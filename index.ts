#!/usr/bin/env bun

import { cancel, intro, isCancel, outro, spinner, text } from "@clack/prompts";
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

function exitIfCancelled<T>(value: T) {
  if (isCancel(value)) {
    cancel("Operation cancelled.");
    process.exit(0);
  }

  return value;
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return "An unknown error occurred.";
}

async function run(): Promise<void> {
  intro(`${pc.bgCyan(pc.black(" mapr "))} ${pc.bold("Frontend bundle reverse-engineering for Bun")}`);

  const configManager = new ConfigManager();
  const config = await configManager.ensureConfig();

  const targetUrlInput = exitIfCancelled(
    await text({
      message: "Target URL to analyze",
      placeholder: "https://example.com",
      validate(value) {
        const parsed = targetUrlSchema.safeParse(value);
        if (!parsed.success) {
          return parsed.error.issues[0]?.message ?? "Enter a valid URL.";
        }

        return undefined;
      },
    }),
  );

  const targetUrl = targetUrlSchema.parse(targetUrlInput);

  const scrapeStep = spinner();
  scrapeStep.start("Fetching HTML and discovering external bundles");
  const scraper = new BundleScraper();
  const scrapeResult = await scraper.scrape(targetUrl);
  scrapeStep.stop(`Discovered ${scrapeResult.scriptUrls.length} external script bundle(s)`);

  const formatStep = spinner();
  formatStep.start("Beautifying downloaded bundles");
  const formatter = new BundleFormatter();
  const formattedBundles = await formatter.formatBundles(scrapeResult.bundles);
  const skippedCount = formattedBundles.filter((bundle) => bundle.formattingSkipped).length;
  formatStep.stop(
    skippedCount > 0
      ? `Prepared ${formattedBundles.length} bundle(s); skipped formatting for ${skippedCount} oversized or invalid file(s)`
      : `Prepared ${formattedBundles.length} bundle(s) for analysis`,
  );

  const analysisStep = spinner();
  analysisStep.start("Analyzing code chunks with OpenAI");
  const analyzer = new AiBundleAnalyzer({
    apiKey: config.openAiApiKey,
    model: config.model,
  });
  const analysis = await analyzer.analyze({
    pageUrl: scrapeResult.pageUrl,
    bundles: formattedBundles,
  });
  analysisStep.stop(`Analyzed ${analysis.analyzedChunkCount} chunk(s) across ${formattedBundles.length} bundle(s)`);

  const reportStep = spinner();
  reportStep.start("Generating Markdown report");
  const reportWriter = new ReportWriter();
  const reportPath = await reportWriter.writeReport({
    targetUrl: scrapeResult.pageUrl,
    scriptUrls: scrapeResult.scriptUrls,
    bundles: formattedBundles,
    analysis,
  });
  reportStep.stop("Report written to disk");

  outro(
    [
      `${pc.green("Analysis complete.")}`,
      `${pc.bold("Target:")} ${scrapeResult.pageUrl}`,
      `${pc.bold("Bundles:")} ${formattedBundles.length}`,
      `${pc.bold("Chunks analyzed:")} ${analysis.analyzedChunkCount}`,
      `${pc.bold("Report:")} ${pc.underline(reportPath)}`,
    ].join("\n"),
  );
}

run().catch((error) => {
  cancel(pc.red(formatError(error)));
  process.exit(1);
});
