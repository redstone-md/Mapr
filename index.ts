#!/usr/bin/env bun

import { cancel, confirm, intro, isCancel, log, outro, spinner, text } from "@clack/prompts";
import pc from "picocolors";
import packageJson from "./package.json";

import { buildAnalysisSnapshot, PartialAnalysisError } from "./lib/analysis-schema";
import { AiBundleAnalyzer, chunkTextByBytes, deriveChunkSizeBytes } from "./lib/ai-analyzer";
import { getConfigOverrides, parseCliArgs, renderHelpText } from "./lib/cli-args";
import { ConfigManager } from "./lib/config";
import { BundleFormatter } from "./lib/formatter";
import { renderProgressBar } from "./lib/progress";
import { ReportWriter } from "./lib/reporter";
import { BundleScraper } from "./lib/scraper";
import { SWARM_AGENT_ORDER } from "./lib/swarm-prompts";

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

function formatAnalysisProgress(completed: number, total: number, message: string): string {
  return `${renderProgressBar(completed, total)} ${message}`;
}

async function resolveTargetUrl(headless: boolean, prefilledUrl?: string): Promise<string> {
  if (prefilledUrl) {
    return prefilledUrl;
  }

  if (headless) {
    throw new Error("Headless mode requires --url.");
  }

  return String(
    exitIfCancelled(
      await text({
        message: "Target URL to analyze",
        placeholder: "http://localhost:5173 or https://example.com",
        validate(value) {
          if (!value) {
            return "Enter a valid URL.";
          }

          try {
            const parsed = new URL(value);
            return /^https?:$/.test(parsed.protocol) ? undefined : "URL must start with http:// or https://.";
          } catch {
            return "Enter a valid URL.";
          }
        },
      }),
    ),
  );
}

async function run(): Promise<void> {
  const args = parseCliArgs(process.argv.slice(2));

  if (args.help) {
    console.log(renderHelpText());
    return;
  }

  if (args.version) {
    console.log(packageJson.version);
    return;
  }

  const headless = args.headless;
  if (!headless) {
    intro(`${pc.bgCyan(pc.black(" mapr "))} ${pc.bold("Website reverse-engineering for Bun")}`);
  }

  const configManager = new ConfigManager();
  const configOverrides = getConfigOverrides(args);
  const existingConfig = await configManager.readConfig();
  let forceReconfigure = args.reconfigure;

  if (!headless && existingConfig && !args.reconfigure && Object.keys(configOverrides).length === 0) {
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

  if (args.listModels) {
    const models = await configManager.listModelCatalog(await configManager.resolveConfigDraft(configOverrides));
    console.log(
      models
        .map((model) => (model.contextSize ? `${model.id}\t${model.contextSize}` : model.id))
        .join("\n"),
    );
    return;
  }

  const config = await configManager.ensureConfig({
    forceReconfigure,
    headless,
    overrides: configOverrides,
  });

  const targetUrl = await resolveTargetUrl(headless, args.url);

  const scrapeStep = spinner({ indicator: "timer" });
  scrapeStep.start("Crawling HTML, scripts, service workers, WASM, and related website artifacts");
  const scraper = new BundleScraper(fetch, {
    maxPages: args.maxPages,
    maxArtifacts: args.maxArtifacts,
    maxDepth: args.maxDepth,
    onProgress(event) {
      scrapeStep.message(event.message);
    },
  });
  const scrapeResult = await scraper.scrape(targetUrl);
  scrapeStep.stop(
    `Discovered ${scrapeResult.artifacts.length} artifact(s) across ${scrapeResult.htmlPages.length} page(s)`,
  );

  const formatStep = spinner({ indicator: "timer" });
  formatStep.start("Formatting downloaded artifacts for analysis");
  const formatter = new BundleFormatter();
  const formattedArtifacts = await formatter.formatArtifacts(scrapeResult.artifacts);
  const skippedCount = formattedArtifacts.filter((artifact) => artifact.formattingSkipped).length;
  formatStep.stop(
    skippedCount > 0
      ? `Prepared ${formattedArtifacts.length} artifact(s); formatting fallback used for ${skippedCount} item(s)`
      : `Prepared ${formattedArtifacts.length} artifact(s) for analysis`,
  );

  const totalChunks = formattedArtifacts.reduce(
    (sum, artifact) =>
      sum + chunkTextByBytes(artifact.formattedContent || artifact.content, deriveChunkSizeBytes(config.modelContextSize)).length,
    0,
  );
  const totalAgentTasks = Math.max(1, totalChunks * SWARM_AGENT_ORDER.length);
  let completedAgentTasks = 0;

  const analysisStep = spinner({ indicator: "timer" });
  analysisStep.start(formatAnalysisProgress(0, totalAgentTasks, "Starting swarm analysis"));

  const analyzer = new AiBundleAnalyzer({
    providerConfig: config,
    localRag: args.localRag,
    onProgress(event) {
      if (event.stage === "agent" && event.state === "completed") {
        completedAgentTasks += 1;
      }

      const progressLine = formatAnalysisProgress(completedAgentTasks, totalAgentTasks, event.message);
      analysisStep.message(progressLine);

      if (args.verboseAgents && event.stage === "agent" && event.state === "completed") {
        log.step(progressLine);
      }
    },
  });

  let analysisError: string | undefined;
  let partialReport = false;
  let analysis = await (async () => {
    try {
      const completedAnalysis = await analyzer.analyze({
        pageUrl: scrapeResult.pageUrl,
        artifacts: formattedArtifacts,
      });

      analysisStep.stop(
        formatAnalysisProgress(
          totalAgentTasks,
          totalAgentTasks,
          `Analyzed ${completedAnalysis.analyzedChunkCount} chunk(s) across ${formattedArtifacts.length} artifact(s)`,
        ),
      );

      return completedAnalysis;
    } catch (error) {
      analysisError = formatError(error);
      partialReport = true;
      analysisStep.error(formatAnalysisProgress(completedAgentTasks, totalAgentTasks, `Analysis interrupted: ${analysisError}`));

      if (error instanceof PartialAnalysisError) {
        return error.partialAnalysis;
      }

      return buildAnalysisSnapshot({
        overview: `Partial report only. Analysis failed before completion: ${analysisError}`,
      });
    }
  })();
  const reportStatus: "complete" | "partial" = partialReport ? "partial" : "complete";

  const reportStep = spinner({ indicator: "timer" });
  reportStep.start(reportStatus === "partial" ? "Writing partial Markdown report after analysis error" : "Generating Markdown report");
  const reportWriter = new ReportWriter();
  const reportPath = await reportWriter.writeReport({
    targetUrl: scrapeResult.pageUrl,
    htmlPages: scrapeResult.htmlPages,
    reportStatus,
    ...(analysisError !== undefined ? { analysisError } : {}),
    artifacts: formattedArtifacts,
    analysis,
    ...(args.output !== undefined ? { outputPathOverride: args.output } : {}),
  });
  reportStep.stop(reportStatus === "partial" ? "Partial report written to disk" : "Report written to disk");

  const summaryLines = [
    reportStatus === "partial" ? `${pc.yellow("Analysis incomplete.")}` : `${pc.green("Analysis complete.")}`,
    `${pc.bold("Status:")} ${reportStatus === "partial" ? "partial report saved after error" : "complete"}`,
    `${pc.bold("Target:")} ${scrapeResult.pageUrl}`,
    `${pc.bold("Provider:")} ${config.providerName} (${config.model})`,
    `${pc.bold("Context size:")} ${config.modelContextSize.toLocaleString()} tokens`,
    `${pc.bold("Local RAG:")} ${args.localRag ? "enabled" : "disabled"}`,
    `${pc.bold("Pages:")} ${scrapeResult.htmlPages.length}`,
    `${pc.bold("Artifacts:")} ${formattedArtifacts.length}`,
    `${pc.bold("Chunks analyzed:")} ${analysis.analyzedChunkCount}`,
    ...(analysisError !== undefined ? [`${pc.bold("Analysis error:")} ${analysisError}`] : []),
    `${pc.bold("Report:")} ${pc.underline(reportPath)}`,
  ].join("\n");

  if (headless) {
    if (reportStatus === "partial") {
      log.error(summaryLines);
      process.exit(1);
    }

    log.success(summaryLines);
    return;
  }

  if (reportStatus === "partial") {
    cancel(summaryLines);
    process.exit(1);
  }

  outro(summaryLines);
}

run().catch((error) => {
  cancel(pc.red(formatError(error)));
  process.exit(1);
});
