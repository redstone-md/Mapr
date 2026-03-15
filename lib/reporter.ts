import { writeFile } from "fs/promises";
import { resolve } from "path";
import { z } from "zod";

import type { BundleAnalysis } from "./analysis-schema";
import { artifactTypeSchema } from "./artifacts";
import type { FormattedArtifact } from "./formatter";

const reportInputSchema = z.object({
  targetUrl: z.string().url(),
  htmlPages: z.array(z.string().url()),
  reportStatus: z.enum(["complete", "partial"]).default("complete"),
  analysisError: z.string().min(1).optional(),
  artifacts: z.array(
    z.object({
      url: z.string().url(),
      type: artifactTypeSchema,
      content: z.string(),
      formattedContent: z.string(),
      sizeBytes: z.number().int().nonnegative(),
      discoveredFrom: z.string().min(1),
      formattingSkipped: z.boolean(),
      formattingNote: z.string().optional(),
    }),
  ),
  analysis: z.object({
    overview: z.string(),
    entryPoints: z.array(
      z.object({
        symbol: z.string(),
        description: z.string(),
        evidence: z.string(),
      }),
    ),
    initializationFlow: z.array(z.string()),
    callGraph: z.array(
      z.object({
        caller: z.string(),
        callee: z.string(),
        rationale: z.string(),
      }),
    ),
    restoredNames: z.array(
      z.object({
        originalName: z.string(),
        suggestedName: z.string(),
        justification: z.string(),
      }),
    ),
    notableLibraries: z.array(z.string()),
    investigationTips: z.array(z.string()),
    risks: z.array(z.string()),
    artifactSummaries: z.array(
      z.object({
        url: z.string().url(),
        type: artifactTypeSchema,
        chunkCount: z.number().int().nonnegative(),
        summary: z.string(),
      }),
    ),
    analyzedChunkCount: z.number().int().nonnegative(),
  }),
});

type ReportInput = z.infer<typeof reportInputSchema>;

function formatBulletList(items: string[], emptyState: string): string {
  return items.length > 0 ? items.map((item) => `- ${item}`).join("\n") : `- ${emptyState}`;
}

function formatArtifactTable(artifacts: FormattedArtifact[]): string {
  if (artifacts.length === 0) {
    return "_No artifacts were downloaded._";
  }

  const lines = [
    "| Artifact URL | Type | Size (bytes) | Discovered From | Formatting | Note |",
    "| --- | --- | ---: | --- | --- | --- |",
  ];

  for (const artifact of artifacts) {
    lines.push(
      `| ${artifact.url} | ${artifact.type} | ${artifact.sizeBytes} | ${artifact.discoveredFrom} | ${
        artifact.formattingSkipped ? "Skipped" : "Applied"
      } | ${artifact.formattingNote ?? "None"} |`,
    );
  }

  return lines.join("\n");
}

export class ReportWriter {
  public generateMarkdown(input: ReportInput): string {
    const report = reportInputSchema.parse(input);

    const entryPointsSection =
      report.analysis.entryPoints.length > 0
        ? report.analysis.entryPoints
            .map((entryPoint) => `- \`${entryPoint.symbol}\`: ${entryPoint.description} Evidence: ${entryPoint.evidence}`)
            .join("\n")
        : "- None identified";

    const callGraphSection =
      report.analysis.callGraph.length > 0
        ? report.analysis.callGraph
            .map((edge) => `- \`${edge.caller}\` -> \`${edge.callee}\`: ${edge.rationale}`)
            .join("\n")
        : "- No clear call edges extracted";

    const restoredNamesSection =
      report.analysis.restoredNames.length > 0
        ? report.analysis.restoredNames
            .map((entry) => `- \`${entry.originalName}\` -> \`${entry.suggestedName}\`: ${entry.justification}`)
            .join("\n")
        : "- No confident renames proposed";

    const artifactSummarySection =
      report.analysis.artifactSummaries.length > 0
        ? report.analysis.artifactSummaries
            .map(
              (summary) =>
                `- ${summary.url} [${summary.type}] (${summary.chunkCount} chunk(s)): ${summary.summary}`,
            )
            .join("\n")
        : "- None";

    return [
      "# Mapr Reverse-Engineering Report",
      "",
      `- Target URL: ${report.targetUrl}`,
      `- Generated: ${new Date().toISOString()}`,
      `- Report status: ${report.reportStatus}`,
      `- HTML pages crawled: ${report.htmlPages.length}`,
      `- Artifacts analyzed: ${report.artifacts.length}`,
      `- AI chunks analyzed: ${report.analysis.analyzedChunkCount}`,
      "",
      report.analysisError ? "## Analysis Status" : undefined,
      report.analysisError ? `- Analysis ended early: ${report.analysisError}` : undefined,
      report.analysisError ? "" : undefined,
      "## Website Surface",
      "",
      formatBulletList(report.htmlPages, "No HTML pages crawled beyond the entry page"),
      "",
      "## Executive Summary",
      "",
      report.analysis.overview,
      "",
      "## Entry Points",
      "",
      entryPointsSection,
      "",
      "## Initialization Flow",
      "",
      formatBulletList(report.analysis.initializationFlow, "No initialization flow extracted"),
      "",
      "## Call Graph",
      "",
      callGraphSection,
      "",
      "## Restored Names",
      "",
      restoredNamesSection,
      "",
      "## Notable Libraries",
      "",
      formatBulletList(report.analysis.notableLibraries, "No notable libraries identified"),
      "",
      "## Investigation Tips",
      "",
      formatBulletList(report.analysis.investigationTips, "No investigation tips generated"),
      "",
      "## Risks And Observations",
      "",
      formatBulletList(report.analysis.risks, "No specific risks highlighted"),
      "",
      "## Artifact Summaries",
      "",
      artifactSummarySection,
      "",
      "## Downloaded Artifacts",
      "",
      formatArtifactTable(report.artifacts),
    ]
      .filter((line): line is string => line !== undefined)
      .join("\n");
  }

  public async writeReport(input: {
    targetUrl: string;
    htmlPages: string[];
    reportStatus?: "complete" | "partial";
    analysisError?: string;
    artifacts: FormattedArtifact[];
    analysis: BundleAnalysis;
    outputPathOverride?: string;
  }): Promise<string> {
    const { outputPathOverride, ...reportInput } = input;
    const validatedInput = reportInputSchema.parse(reportInput);
    const reportContent = this.generateMarkdown(validatedInput);
    const outputPath =
      outputPathOverride !== undefined
        ? resolve(process.cwd(), outputPathOverride)
        : resolve(
            process.cwd(),
            `report-${new URL(validatedInput.targetUrl).hostname.replace(/[^a-zA-Z0-9.-]/g, "-")}-${new Date()
              .toISOString()
              .replace(/[:.]/g, "-")}.md`,
          );

    await writeFile(outputPath, `${reportContent}\n`, "utf8");
    return outputPath;
  }
}
