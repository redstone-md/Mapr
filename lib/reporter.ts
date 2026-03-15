import { writeFile } from "fs/promises";
import { resolve } from "path";
import { z } from "zod";

import type { BundleAnalysis } from "./analysis-schema";
import { artifactTypeSchema } from "./artifacts";
import { browserTraceSchema, type BrowserTrace } from "./browser-trace";
import { domPageSnapshotSchema, type DomPageSnapshot } from "./dom-snapshot";
import type { FormattedArtifact } from "./formatter";
import { deterministicSurfaceSchema, EMPTY_DETERMINISTIC_SURFACE, type DeterministicSurface } from "./surface-analysis";

const reportInputSchema = z.object({
  targetUrl: z.string().url(),
  htmlPages: z.array(z.string().url()),
  domSnapshots: z.array(domPageSnapshotSchema).default([]),
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
  deterministicSurface: deterministicSurfaceSchema.default(EMPTY_DETERMINISTIC_SURFACE),
  browserTrace: browserTraceSchema.optional(),
});

type ReportInput = z.input<typeof reportInputSchema>;

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

function formatDomSnapshots(domSnapshots: DomPageSnapshot[]): string {
  if (domSnapshots.length === 0) {
    return "- No DOM snapshots collected";
  }

  return domSnapshots
    .map((snapshot) => {
      const formSummary =
        snapshot.forms.length > 0
          ? `forms: ${snapshot.forms
              .map((form) => `${form.method} ${form.action} [${form.inputNames.join(", ") || form.inputTypes.join(", ") || "no-fields"}]`)
              .join("; ")}`
          : "forms: none";
      const iframeSummary = snapshot.iframes.length > 0 ? `iframes: ${snapshot.iframes.join(", ")}` : "iframes: none";
      const hintSummary =
        snapshot.inlineStateHints.length > 0 ? `state hints: ${snapshot.inlineStateHints.join(", ")}` : "state hints: none";

      return `- ${snapshot.url}: ${snapshot.summary}; ${formSummary}; ${iframeSummary}; ${hintSummary}`;
    })
    .join("\n");
}

function formatDeterministicSurface(surface: DeterministicSurface): string[] {
  const apiEndpoints =
    surface.apiEndpoints.length > 0
      ? surface.apiEndpoints
          .map(
            (endpoint) =>
              `- \`${endpoint.url}\`${endpoint.methods.length > 0 ? ` [${endpoint.methods.join(", ")}]` : ""}: ${endpoint.purpose}. Request fields: ${
                endpoint.requestFields.join(", ") || "none inferred"
              }.`,
          )
          .join("\n")
      : "- No REST-like endpoints were extracted.";
  const openApiDocs =
    surface.openApiDocuments.length > 0
      ? surface.openApiDocuments
          .map(
            (document) =>
              `- ${document.url}${document.title ? ` (${document.title})` : ""}: ${document.pathSummaries.slice(0, 5).join("; ") || "No path summaries parsed."}`,
          )
          .join("\n")
      : "- No OpenAPI or Swagger documents were discovered.";
  const graphQl =
    surface.graphQlEndpoints.length > 0 || surface.graphQlOperations.length > 0
      ? [
          ...surface.graphQlEndpoints.map(
            (endpoint) =>
              `- Endpoint ${endpoint.url}: introspection ${endpoint.introspectionStatus}; schema hints: ${
                endpoint.sampleFields.join(", ") || "none"
              }`,
          ),
          ...surface.graphQlOperations.map(
            (operation) =>
              `- ${operation.operationType} ${operation.operationName} via ${operation.endpointUrl}: variables ${
                operation.variables.join(", ") || "none"
              }; expected response ${operation.expectedResponse}`,
          ),
        ].join("\n")
      : "- No GraphQL surface was extracted.";
  const authFlows =
    surface.authFlows.length > 0
      ? surface.authFlows
          .map(
            (flow) =>
              `- ${flow.title}: triggers ${flow.triggers.join(", ") || "none"}; tokens ${
                flow.tokens.join(", ") || "none"
              }; errors ${flow.errors.join(", ") || "none"}`,
          )
          .join("\n")
      : "- No auth flow was reconstructed.";
  const captchaFlows =
    surface.captchaFlows.length > 0
      ? surface.captchaFlows
          .map(
            (flow) =>
              `- ${flow.provider}: triggers ${flow.triggers.join(", ") || "none"}; endpoints ${
                flow.endpoints.join(", ") || "none"
              }; errors ${flow.errors.join(", ") || "none"}`,
          )
          .join("\n")
      : "- No captcha flow was reconstructed.";
  const fingerprinting =
    surface.fingerprintingSignals.length > 0
      ? surface.fingerprintingSignals
          .map(
            (signal) =>
              `- ${signal.collector}: collects ${signal.dataPoints.join(", ") || "unspecified traits"}; destinations ${
                signal.destinationUrls.join(", ") || "none inferred"
              }`,
          )
          .join("\n")
      : "- No fingerprinting logic was detected.";
  const encryption =
    surface.encryptionSignals.length > 0
      ? surface.encryptionSignals
          .map(
            (signal) =>
              `- Algorithms ${signal.algorithmHints.join(", ") || "unknown"}; inputs ${
                signal.inputs.join(", ") || "none"
              }; outputs ${signal.outputs.join(", ") || "none"}; destinations ${signal.destinationUrls.join(", ") || "none inferred"}`,
          )
          .join("\n")
      : "- No client-side encryption or signing hints were detected.";
  const findings =
    surface.securityFindings.length > 0
      ? surface.securityFindings
          .map((finding) => `- [${finding.severity}] ${finding.title}: ${finding.detail} Remediation: ${finding.remediation}`)
          .join("\n")
      : "- No deterministic security findings were derived.";

  return [
    "## API Surface",
    "",
    apiEndpoints,
    "",
    "## OpenAPI And Swagger",
    "",
    openApiDocs,
    "",
    "## GraphQL Surface",
    "",
    graphQl,
    "",
    "## Authentication Flow",
    "",
    authFlows,
    "",
    "## Captcha And Challenge Flow",
    "",
    captchaFlows,
    "",
    "## Fingerprinting Surface",
    "",
    fingerprinting,
    "",
    "## Encryption And Signing Surface",
    "",
    encryption,
    "",
    "## Deterministic Security Findings",
    "",
    findings,
    "",
  ];
}

function formatBrowserTrace(trace: BrowserTrace | undefined): string[] {
  if (!trace) {
    return ["## Browser-Assisted Trace", "", "- Browser-assisted tracing was not used.", ""];
  }

  const requestLines =
    trace.requests.length > 0
      ? trace.requests
          .slice(0, 20)
          .map(
            (request) =>
              `- ${request.method} ${request.url} [${request.resourceType}]${request.status !== undefined ? ` -> ${request.status}` : ""}${
                request.requestBodySnippet ? ` body: ${request.requestBodySnippet}` : ""
              }`,
          )
          .join("\n")
      : "- No runtime requests recorded.";
  const consoleLines =
    trace.consoleMessages.length > 0
      ? trace.consoleMessages.map((entry) => `- [${entry.type}] ${entry.text}`).join("\n")
      : "- No console messages captured.";

  return [
    "## Browser-Assisted Trace",
    "",
    `- Status: ${trace.status}`,
    ...(trace.finalUrl ? [`- Final URL: ${trace.finalUrl}`] : []),
    `- Frames observed: ${trace.frameUrls.length}`,
    `- Requests captured: ${trace.requests.length}`,
    `- Captcha providers: ${trace.runtimeSignals.captchaProviders.join(", ") || "none"}`,
    `- Auth runtime requests: ${trace.runtimeSignals.authRequestUrls.length}`,
    `- Challenge runtime requests: ${trace.runtimeSignals.challengeRequestUrls.length}`,
    `- Fingerprinting runtime requests: ${trace.runtimeSignals.fingerprintingRequestUrls.length}`,
    ...(trace.error ? [`- Error: ${trace.error}`] : []),
    "",
    "### Runtime Requests",
    "",
    requestLines,
    "",
    "### Console And Page Errors",
    "",
    consoleLines,
    ...(trace.pageErrors.length > 0 ? ["", ...trace.pageErrors.map((entry) => `- pageerror: ${entry}`)] : []),
    "",
  ];
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
      "- Repository: https://github.com/redstone-md/Mapr",
      "- Disclaimer: The author and contributors assume no liability for how this analysis is used.",
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
      "## DOM Surface",
      "",
      formatDomSnapshots(report.domSnapshots),
      "",
      ...formatBrowserTrace(report.browserTrace),
      ...formatDeterministicSurface(report.deterministicSurface),
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
    domSnapshots: DomPageSnapshot[];
    reportStatus?: "complete" | "partial";
    analysisError?: string;
    artifacts: FormattedArtifact[];
    analysis: BundleAnalysis;
    deterministicSurface: DeterministicSurface;
    browserTrace?: BrowserTrace;
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
