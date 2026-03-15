#!/usr/bin/env bun

import { cancel, confirm, intro, isCancel, outro, spinner, text } from "@clack/prompts";
import pc from "picocolors";
import { z } from "zod";

import { AiBundleAnalyzer } from "./lib/ai-analyzer";
import { ConfigManager } from "./lib/config";
import { BundleFormatter } from "./lib/formatter";
import { ReportWriter } from "./lib/reporter";
import { BundleScraper } from "./lib/scraper";

const targetUrlSchema = z
  .string()
  .trim()
  .url("Enter a valid URL.")
  .refine((value) => /^https?:\/\//.test(value), "URL must start with http:// or https://.");

function exitIfCancelled<T>(value: T): T {
  if (isCancel(value)) {
    cancel("Operation cancelled.");
    process.exit(0);
  }

  return value;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : "An unknown error occurred.";
}

async function run(): Promise<void> {
  intro(`${pc.bgCyan(pc.black(" mapr "))} ${pc.bold("Website reverse-engineering for Bun")}`);

  const configManager = new ConfigManager();
  const existingConfig = await configManager.readConfig();
  let forceReconfigure = false;

  if (existingConfig) {
    forceReconfigure = Boolean(
      exitIfCancelled(
      await confirm({
        message: `Reconfigure AI provider? Current: ${existingConfig.providerName} / ${existingConfig.model}`,
        active: "Reconfigure",
        inactive: "Keep saved config",
        initialValue: false,
      }),
      ),
    );
  }

  const config = await configManager.ensureConfig({ forceReconfigure });

  const targetUrl = targetUrlSchema.parse(
    exitIfCancelled(
      await text({
        message: "Target URL to analyze",
        placeholder: "http://localhost:5173 or https://example.com",
        validate(value) {
          const parsed = targetUrlSchema.safeParse(value);
          return parsed.success ? undefined : parsed.error.issues[0]?.message ?? "Enter a valid URL.";
        },
      }),
    ),
  );

  const scrapeStep = spinner();
  scrapeStep.start("Crawling HTML, scripts, service workers, WASM, and related website artifacts");
  const scraper = new BundleScraper();
  const scrapeResult = await scraper.scrape(targetUrl);
  scrapeStep.stop(
    `Discovered ${scrapeResult.artifacts.length} artifact(s) across ${scrapeResult.htmlPages.length} page(s)`,
  );

  const formatStep = spinner();
  formatStep.start("Formatting downloaded artifacts for analysis");
  const formatter = new BundleFormatter();
  const formattedArtifacts = await formatter.formatArtifacts(scrapeResult.artifacts);
  const skippedCount = formattedArtifacts.filter((artifact) => artifact.formattingSkipped).length;
  formatStep.stop(
    skippedCount > 0
      ? `Prepared ${formattedArtifacts.length} artifact(s); skipped formatting for ${skippedCount} oversized or unsupported item(s)`
      : `Prepared ${formattedArtifacts.length} artifact(s) for analysis`,
  );

  const analysisStep = spinner();
  analysisStep.start("Analyzing website artifacts with the configured AI provider");
  const analyzer = new AiBundleAnalyzer({
    providerConfig: config,
  });
  const analysis = await analyzer.analyze({
    pageUrl: scrapeResult.pageUrl,
    artifacts: formattedArtifacts,
  });
  analysisStep.stop(`Analyzed ${analysis.analyzedChunkCount} chunk(s) across ${formattedArtifacts.length} artifact(s)`);

  const reportStep = spinner();
  reportStep.start("Generating Markdown report");
  const reportWriter = new ReportWriter();
  const reportPath = await reportWriter.writeReport({
    targetUrl: scrapeResult.pageUrl,
    htmlPages: scrapeResult.htmlPages,
    artifacts: formattedArtifacts,
    analysis,
  });
  reportStep.stop("Report written to disk");

  outro(
    [
      pc.green("Analysis complete."),
      `${pc.bold("Target:")} ${scrapeResult.pageUrl}`,
      `${pc.bold("Provider:")} ${config.providerName} (${config.model})`,
      `${pc.bold("Pages:")} ${scrapeResult.htmlPages.length}`,
      `${pc.bold("Artifacts:")} ${formattedArtifacts.length}`,
      `${pc.bold("Chunks analyzed:")} ${analysis.analyzedChunkCount}`,
      `${pc.bold("Report:")} ${pc.underline(reportPath)}`,
    ].join("\n"),
  );
}

run().catch((error) => {
  cancel(pc.red(formatError(error)));
  process.exit(1);
});
