import { writeFile } from "fs/promises";
import { resolve } from "path";
import { z } from "zod";

import type { BundleAnalysis } from "./ai-analyzer";
import type { FormattedBundle } from "./formatter";

const reportInputSchema = z.object({
  targetUrl: z.string().url(),
  scriptUrls: z.array(z.string().url()),
  bundles: z.array(
    z.object({
      url: z.string().url(),
      rawCode: z.string(),
      formattedCode: z.string(),
      sizeBytes: z.number().int().nonnegative(),
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
    risks: z.array(z.string()),
    bundleSummaries: z.array(
      z.object({
        url: z.string().url(),
        chunkCount: z.number().int().nonnegative(),
        summary: z.string(),
      }),
    ),
    analyzedChunkCount: z.number().int().nonnegative(),
  }),
});

function formatBulletList(items: string[]): string {
  if (items.length === 0) {
    return "- None detected";
  }

  return items.map((item) => `- ${item}`).join("\n");
}

function formatBundleTable(bundles: FormattedBundle[]): string {
  if (bundles.length === 0) {
    return "_No external bundles were downloaded._";
  }

  const lines = [
    "| Bundle URL | Size (bytes) | Formatting | Note |",
    "| --- | ---: | --- | --- |",
  ];

  for (const bundle of bundles) {
    lines.push(
      `| ${bundle.url} | ${bundle.sizeBytes} | ${bundle.formattingSkipped ? "Skipped" : "Applied"} | ${
        bundle.formattingNote ?? "None"
      } |`,
    );
  }

  return lines.join("\n");
}

export class ReportWriter {
  public generateMarkdown(input: {
    targetUrl: string;
    scriptUrls: string[];
    bundles: FormattedBundle[];
    analysis: BundleAnalysis;
  }): string {
    const report = reportInputSchema.parse(input);

    const entryPointsSection =
      report.analysis.entryPoints.length === 0
        ? "- None identified"
        : report.analysis.entryPoints
            .map(
              (entryPoint) =>
                `- \`${entryPoint.symbol}\`: ${entryPoint.description} Evidence: ${entryPoint.evidence}`,
            )
            .join("\n");

    const callGraphSection =
      report.analysis.callGraph.length === 0
        ? "- No clear call edges extracted"
        : report.analysis.callGraph
            .map((edge) => `- \`${edge.caller}\` -> \`${edge.callee}\`: ${edge.rationale}`)
            .join("\n");

    const restoredNamesSection =
      report.analysis.restoredNames.length === 0
        ? "- No confident renames proposed"
        : report.analysis.restoredNames
            .map(
              (name) =>
                `- \`${name.originalName}\` -> \`${name.suggestedName}\`: ${name.justification}`,
            )
            .join("\n");

    const bundleSummarySection =
      report.analysis.bundleSummaries.length === 0
        ? "- None"
        : report.analysis.bundleSummaries
            .map(
              (summary) =>
                `- ${summary.url} (${summary.chunkCount} chunk(s)): ${summary.summary}`,
            )
            .join("\n");

    return [
      `# Mapr Reverse-Engineering Report`,
      ``,
      `- Target URL: ${report.targetUrl}`,
      `- Generated: ${new Date().toISOString()}`,
      `- External script bundles discovered: ${report.scriptUrls.length}`,
      `- AI chunks analyzed: ${report.analysis.analyzedChunkCount}`,
      ``,
      `## Executive Summary`,
      ``,
      report.analysis.overview,
      ``,
      `## Entry Points`,
      ``,
      entryPointsSection,
      ``,
      `## Initialization Flow`,
      ``,
      formatBulletList(report.analysis.initializationFlow),
      ``,
      `## Call Graph`,
      ``,
      callGraphSection,
      ``,
      `## Restored Names`,
      ``,
      restoredNamesSection,
      ``,
      `## Notable Libraries`,
      ``,
      formatBulletList(report.analysis.notableLibraries),
      ``,
      `## Risks And Observations`,
      ``,
      formatBulletList(report.analysis.risks),
      ``,
      `## Bundle Summaries`,
      ``,
      bundleSummarySection,
      ``,
      `## Downloaded Bundles`,
      ``,
      formatBundleTable(report.bundles),
    ].join("\n");
  }

  public async writeReport(input: {
    targetUrl: string;
    scriptUrls: string[];
    bundles: FormattedBundle[];
    analysis: BundleAnalysis;
  }): Promise<string> {
    const validatedInput = reportInputSchema.parse(input);
    const reportContent = this.generateMarkdown(validatedInput);
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const domain = new URL(validatedInput.targetUrl).hostname.replace(/[^a-zA-Z0-9.-]/g, "-");
    const fileName = `report-${domain}-${timestamp}.md`;
    const outputPath = resolve(process.cwd(), fileName);

    await writeFile(outputPath, `${reportContent}\n`, "utf8");
    return outputPath;
  }
}
