import { mkdir, writeFile } from "fs/promises";
import { basename, dirname, extname, join, resolve } from "path";
import { z } from "zod";

import type { BundleAnalysis } from "./analysis-schema";
import { artifactTypeSchema } from "./artifacts";
import { browserTraceSchema, type BrowserTrace } from "./browser-trace";
import { deterministicSurfaceSchema, type DeterministicSurface } from "./surface-analysis";
import { domPageSnapshotSchema, type DomPageSnapshot } from "./dom-snapshot";
import type { FormattedArtifact } from "./formatter";
import { HtmlReportBuilder } from "./html-report";
import { ReportWriter } from "./reporter";

const runOutputInputSchema = z.object({
  targetUrl: z.string().url(),
  htmlPages: z.array(z.string().url()),
  domSnapshots: z.array(domPageSnapshotSchema).default([]),
  reportStatus: z.enum(["complete", "partial"]).default("complete"),
  analysisError: z.string().optional(),
  artifacts: z.array(
    z.object({
      url: z.string().url(),
      type: artifactTypeSchema,
      content: z.string(),
      formattedContent: z.string(),
      sizeBytes: z.number().int().nonnegative(),
      discoveredFrom: z.string(),
      formattingSkipped: z.boolean(),
      formattingNote: z.string().optional(),
    }),
  ),
  analysis: z.custom<BundleAnalysis>(),
  deterministicSurface: deterministicSurfaceSchema,
  browserTrace: browserTraceSchema.optional(),
  outputPathOverride: z.string().optional(),
  runMetadata: z.record(z.string(), z.unknown()).default({}),
});

function sanitizeFileName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 80) || "artifact";
}

function buildDefaultRunDirectory(targetUrl: string): string {
  const host = new URL(targetUrl).hostname.replace(/[^a-zA-Z0-9.-]/g, "-");
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return resolve(process.cwd(), `mapr-run-${host}-${timestamp}`);
}

function resolveRunDirectory(outputPathOverride: string | undefined, targetUrl: string): { runDirectory: string; reportPath: string } {
  if (!outputPathOverride) {
    const runDirectory = buildDefaultRunDirectory(targetUrl);
    return { runDirectory, reportPath: join(runDirectory, "report.md") };
  }

  const resolvedOverride = resolve(process.cwd(), outputPathOverride);
  if (extname(resolvedOverride).toLowerCase() === ".md") {
    const runDirectory = join(dirname(resolvedOverride), `${basename(resolvedOverride, ".md")}-artifacts`);
    return { runDirectory, reportPath: resolvedOverride };
  }

  return { runDirectory: resolvedOverride, reportPath: join(resolvedOverride, "report.md") };
}

function buildRunReadme(input: {
  targetUrl: string;
  reportStatus: "complete" | "partial";
  reportPath: string;
  deterministicSurface: DeterministicSurface;
  htmlPages: string[];
  artifacts: FormattedArtifact[];
}): string {
  const securityFindings =
    input.deterministicSurface.securityFindings.length > 0
      ? input.deterministicSurface.securityFindings
          .map((finding) => `- [${finding.severity}] ${finding.title}: ${finding.detail} Remediation: ${finding.remediation}`)
          .join("\n")
      : "- No explicit security findings were derived from deterministic discovery.";

  return [
    "# Mapr Run Artifacts",
    "",
    `- Target: ${input.targetUrl}`,
    `- Status: ${input.reportStatus}`,
    `- Report: ${basename(input.reportPath)}`,
    `- HTML pages: ${input.htmlPages.length}`,
    `- Artifacts: ${input.artifacts.length}`,
    "",
    "## Disclaimer",
    "",
    "The author and contributors assume no liability for how this analysis is used. Validate all findings before relying on them operationally.",
    "",
    "## Security Findings",
    "",
    securityFindings,
    "",
    "## Files",
    "",
    "- `report.md` or the requested Markdown output",
    "- `report.html` interactive HTML report with code-map browser and manifest explorer",
    "- `metadata.json` high-level run metadata",
    "- `browser-trace.json` Playwright runtime trace when enabled",
    "- `deterministic-surface.json` API/auth/captcha/fingerprinting/encryption findings",
    "- `dom-snapshots.json` static DOM snapshots",
    "- `artifacts/index.json` artifact manifest",
    "- `artifacts/raw/*` raw fetched artifact bodies",
    "- `artifacts/formatted/*` formatted artifact bodies used for AI analysis",
  ].join("\n");
}

export class RunArtifactsWriter {
  private readonly reportWriter = new ReportWriter();
  private readonly htmlReportBuilder = new HtmlReportBuilder();

  public async writeRun(input: {
    targetUrl: string;
    htmlPages: string[];
    domSnapshots: DomPageSnapshot[];
    reportStatus?: "complete" | "partial";
    analysisError?: string;
    artifacts: FormattedArtifact[];
    analysis: BundleAnalysis;
    deterministicSurface: DeterministicSurface;
    browserTrace?: BrowserTrace;
    outputPathOverride?: string;
    runMetadata?: Record<string, unknown>;
  }): Promise<{ runDirectory: string; reportPath: string }> {
    const validated = runOutputInputSchema.parse(input);
    const { runDirectory, reportPath } = resolveRunDirectory(validated.outputPathOverride, validated.targetUrl);
    const rawDir = join(runDirectory, "artifacts", "raw");
    const formattedDir = join(runDirectory, "artifacts", "formatted");
    await mkdir(rawDir, { recursive: true });
    await mkdir(formattedDir, { recursive: true });

    const markdown = this.reportWriter.generateMarkdown({
      targetUrl: validated.targetUrl,
      htmlPages: validated.htmlPages,
      domSnapshots: validated.domSnapshots,
      reportStatus: validated.reportStatus,
      analysisError: validated.analysisError,
      artifacts: validated.artifacts,
      analysis: validated.analysis,
      deterministicSurface: validated.deterministicSurface,
      ...(validated.browserTrace !== undefined ? { browserTrace: validated.browserTrace } : {}),
    });
    const htmlReport = this.htmlReportBuilder.generate({
      targetUrl: validated.targetUrl,
      htmlPages: validated.htmlPages,
      domSnapshots: validated.domSnapshots,
      reportStatus: validated.reportStatus,
      artifacts: validated.artifacts,
      analysis: validated.analysis,
      deterministicSurface: validated.deterministicSurface,
      ...(validated.browserTrace !== undefined ? { browserTrace: validated.browserTrace } : {}),
      ...(validated.analysisError !== undefined ? { analysisError: validated.analysisError } : {}),
    });
    await writeFile(reportPath, `${markdown}\n`, "utf8");

    const manifest = validated.artifacts.map((artifact, index) => {
      const baseName = `${String(index + 1).padStart(3, "0")}-${sanitizeFileName(new URL(artifact.url).hostname)}-${sanitizeFileName(
        new URL(artifact.url).pathname.split("/").filter(Boolean).pop() ?? artifact.type,
      )}.txt`;
      return {
        ...artifact,
        rawPath: join("artifacts", "raw", baseName),
        formattedPath: join("artifacts", "formatted", baseName),
      };
    });

    await Promise.all(
      manifest.flatMap((entry, index) => [
        writeFile(join(runDirectory, entry.rawPath), `${validated.artifacts[index]!.content}\n`, "utf8"),
        writeFile(join(runDirectory, entry.formattedPath), `${validated.artifacts[index]!.formattedContent}\n`, "utf8"),
      ]),
    );

    await Promise.all([
      writeFile(join(runDirectory, "artifacts", "index.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8"),
      writeFile(join(runDirectory, "metadata.json"), `${JSON.stringify(validated.runMetadata, null, 2)}\n`, "utf8"),
      writeFile(join(runDirectory, "browser-trace.json"), `${JSON.stringify(validated.browserTrace ?? null, null, 2)}\n`, "utf8"),
      writeFile(join(runDirectory, "dom-snapshots.json"), `${JSON.stringify(validated.domSnapshots, null, 2)}\n`, "utf8"),
      writeFile(join(runDirectory, "deterministic-surface.json"), `${JSON.stringify(validated.deterministicSurface, null, 2)}\n`, "utf8"),
      writeFile(join(runDirectory, "report.html"), `${htmlReport}\n`, "utf8"),
      writeFile(
        join(runDirectory, "README.md"),
        `${buildRunReadme({
          targetUrl: validated.targetUrl,
          reportStatus: validated.reportStatus,
          reportPath,
          deterministicSurface: validated.deterministicSurface,
          htmlPages: validated.htmlPages,
          artifacts: validated.artifacts,
        })}\n`,
        "utf8",
      ),
    ]);

    return { runDirectory, reportPath };
  }
}
