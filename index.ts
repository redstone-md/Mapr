#!/usr/bin/env bun

import { cancel, confirm, intro, isCancel, log, outro, select, spinner, text } from "@clack/prompts";
import { join } from "path";
import pc from "picocolors";
import packageJson from "./package.json";

import { ApiSurfaceDiscoverer } from "./lib/api-discovery";
import { estimateAgentTaskCount } from "./lib/analysis-planner";
import { buildAnalysisSnapshot, PartialAnalysisError } from "./lib/analysis-schema";
import { AiBundleAnalyzer, chunkTextByBytes, deriveChunkSizeBytes } from "./lib/ai-analyzer";
import { BrowserAssistedTracer, type BrowserTrace } from "./lib/browser-trace";
import { getConfigOverrides, parseCliArgs, renderHelpText } from "./lib/cli-args";
import { ConfigManager } from "./lib/config";
import { FlowSurfaceDiscoverer } from "./lib/flow-discovery";
import { BundleFormatter } from "./lib/formatter";
import { LocalArtifactRag } from "./lib/local-rag";
import { renderAdaptiveAnalysisProgressLine, renderAgentLogLine, renderProgressBar } from "./lib/progress";
import { findKnownModelInfo, isCodexModel } from "./lib/provider";
import { RunArtifactsWriter } from "./lib/run-output";
import { BundleScraper } from "./lib/scraper";
import { mergeDeterministicSurface } from "./lib/surface-analysis";

process.env.AI_SDK_LOG_WARNINGS = "false";
(globalThis as typeof globalThis & { AI_SDK_LOG_WARNINGS?: boolean }).AI_SDK_LOG_WARNINGS = false;

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

async function resolveAnalysisConcurrency(headless: boolean, prefilledValue: number | undefined, totalChunks: number): Promise<number> {
  if (prefilledValue !== undefined) {
    return prefilledValue;
  }

  if (headless || totalChunks <= 1) {
    return 1;
  }

  return Number(
    exitIfCancelled(
      await select({
        message: "Analysis concurrency",
        initialValue: 2,
        options: [
          { value: 1, label: "1 lane", hint: "Most stable" },
          { value: 2, label: "2 lanes", hint: "Recommended" },
          { value: 4, label: "4 lanes", hint: "Aggressive" },
        ],
      }),
    ),
  );
}

async function resolveLocalRag(headless: boolean, prefilledValue: boolean | undefined, totalBytes: number): Promise<boolean> {
  if (prefilledValue !== undefined) {
    return prefilledValue;
  }

  if (headless || totalBytes < 1_000_000) {
    return false;
  }

  return Boolean(
    exitIfCancelled(
      await confirm({
        message: "Enable local RAG code indexing?",
        active: "Enable",
        inactive: "Skip",
        initialValue: totalBytes >= 2_000_000,
      }),
    ),
  );
}

async function resolveBrowserAssisted(
  headless: boolean,
  prefilledValue: boolean | undefined,
  targetUrl: string,
): Promise<boolean> {
  if (prefilledValue !== undefined) {
    return prefilledValue;
  }

  if (headless) {
    return false;
  }

  const suggestEnabled = /(login|auth|signin|signup|verify|captcha|challenge|mfa|2fa)/i.test(targetUrl);
  return Boolean(
    exitIfCancelled(
      await confirm({
        message: "Enable browser-assisted tracing?",
        active: "Enable",
        inactive: "Skip",
        initialValue: suggestEnabled,
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
    log.info(`Repository: ${pc.underline("https://github.com/redstone-md/Mapr")}`);
    log.warn("Disclaimer: the author and contributors assume no liability for how this analysis is used.");
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
  const browserAssisted = await resolveBrowserAssisted(headless, args.browserAssisted, targetUrl);

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

  const browserTraceStep = spinner({ indicator: "timer" });
  let browserTrace: BrowserTrace | undefined;
  if (browserAssisted) {
    browserTraceStep.start("Running browser-assisted Playwright trace");
    const tracer = new BrowserAssistedTracer({
      enabled: true,
      onProgress(message) {
        browserTraceStep.message(message);
      },
      ...(args.browserTimeoutMs !== undefined ? { timeoutMs: args.browserTimeoutMs } : {}),
    });
    browserTrace = await tracer.trace(scrapeResult.pageUrl);
    browserTraceStep.stop(
      browserTrace.status === "captured"
        ? `Captured ${browserTrace.requests.length} browser request(s) across ${browserTrace.frameUrls.length || 1} frame(s)`
        : `Browser trace ${browserTrace.status}${browserTrace.error ? `: ${browserTrace.error}` : ""}`,
    );
  }

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
  const totalArtifactBytes = formattedArtifacts.reduce((sum, artifact) => sum + artifact.sizeBytes, 0);
  const localRagEnabled = await resolveLocalRag(headless, args.localRag, totalArtifactBytes);
  const analysisConcurrency = await resolveAnalysisConcurrency(headless, args.analysisConcurrency, totalChunks);
  const ragSummary = localRagEnabled ? new LocalArtifactRag(formattedArtifacts).describe() : undefined;

  const discoveryStep = spinner({ indicator: "timer" });
  discoveryStep.start("Extracting API, auth, captcha, fingerprinting, and encryption surface");
  const apiDiscoverer = new ApiSurfaceDiscoverer({
    onProgress(message) {
      discoveryStep.message(message);
    },
  });
  const apiSurface = await apiDiscoverer.discover(scrapeResult.pageUrl, formattedArtifacts);
  const domSnapshotsForAnalysis =
    browserTrace?.domSnapshot !== undefined ? [...scrapeResult.domSnapshots, browserTrace.domSnapshot] : scrapeResult.domSnapshots;
  const flowDiscoverer = new FlowSurfaceDiscoverer();
  const deterministicSurface = mergeDeterministicSurface({
    ...apiSurface,
    ...flowDiscoverer.discover({
      domSnapshots: domSnapshotsForAnalysis,
      artifacts: formattedArtifacts,
      apiEndpoints: apiSurface.apiEndpoints,
      graphQlEndpoints: apiSurface.graphQlEndpoints,
      ...(browserTrace !== undefined ? { browserTrace } : {}),
    }),
  });
  discoveryStep.stop(
    `Mapped ${deterministicSurface.apiEndpoints.length} API endpoint(s), ${deterministicSurface.authFlows.length} auth flow(s), ${deterministicSurface.captchaFlows.length} captcha flow(s)`,
  );

  const totalAgentTasks = estimateAgentTaskCount(
    scrapeResult.pageUrl,
    formattedArtifacts,
    (artifact) => chunkTextByBytes(artifact.formattedContent || artifact.content, deriveChunkSizeBytes(config.modelContextSize)).length,
  );
  let completedAgentTasks = 0;
  const analysisStartedAt = Date.now();

  const analysisStep = spinner({ indicator: "timer" });
  analysisStep.start(formatAnalysisProgress(0, totalAgentTasks, `Starting swarm analysis (${analysisConcurrency} lane${analysisConcurrency === 1 ? "" : "s"})`));

  const analyzer = new AiBundleAnalyzer({
    providerConfig: config,
    localRag: localRagEnabled,
    analysisConcurrency,
    onProgress(event) {
      if (event.stage === "agent" && event.state === "completed") {
        completedAgentTasks += 1;
      }

      const progressLine =
        event.stage === "agent" && event.agent
          ? renderAdaptiveAnalysisProgressLine({
              completed: completedAgentTasks,
              total: totalAgentTasks,
              elapsedMs: Date.now() - analysisStartedAt,
              agent: event.agent,
              state: event.state,
              artifactUrl: event.artifactUrl,
              ...(event.lane !== undefined ? { lane: event.lane } : {}),
              ...(event.chunkIndex !== undefined ? { chunkIndex: event.chunkIndex } : {}),
              ...(event.chunkCount !== undefined ? { chunkCount: event.chunkCount } : {}),
              ...(event.estimatedOutputTokens !== undefined
                ? { estimatedOutputTokens: event.estimatedOutputTokens }
                : {}),
              ...(event.outputTokens !== undefined ? { outputTokens: event.outputTokens } : {}),
              ...(event.tokensPerSecond !== undefined ? { tokensPerSecond: event.tokensPerSecond } : {}),
            })
          : formatAnalysisProgress(completedAgentTasks, totalAgentTasks, event.message);
      analysisStep.message(progressLine);

      if (event.stage === "agent" && event.state !== "streaming" && (args.verboseAgents || analysisConcurrency > 1)) {
        log.step(
          renderAgentLogLine({
            completed: completedAgentTasks,
            total: totalAgentTasks,
            elapsedMs: Date.now() - analysisStartedAt,
            agent: event.agent ?? "scout",
            state: event.state,
            artifactUrl: event.artifactUrl,
            ...(event.lane !== undefined ? { lane: event.lane } : {}),
            ...(event.chunkIndex !== undefined ? { chunkIndex: event.chunkIndex } : {}),
            ...(event.chunkCount !== undefined ? { chunkCount: event.chunkCount } : {}),
            ...(event.estimatedOutputTokens !== undefined
              ? { estimatedOutputTokens: event.estimatedOutputTokens }
              : {}),
            ...(event.outputTokens !== undefined ? { outputTokens: event.outputTokens } : {}),
            ...(event.tokensPerSecond !== undefined ? { tokensPerSecond: event.tokensPerSecond } : {}),
          }),
        );
      }
    },
  });

  let analysisError: string | undefined;
  let partialReport = false;
  let analysis = await (async () => {
    try {
      const completedAnalysis = await analyzer.analyze({
        pageUrl: scrapeResult.pageUrl,
        domSnapshots: domSnapshotsForAnalysis,
        artifacts: formattedArtifacts,
        deterministicSurface,
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
  reportStep.start(reportStatus === "partial" ? "Writing partial run artifacts after analysis error" : "Generating run artifacts");
  const runWriter = new RunArtifactsWriter();
  const { reportPath, runDirectory } = await runWriter.writeRun({
    targetUrl: scrapeResult.pageUrl,
    htmlPages: scrapeResult.htmlPages,
    domSnapshots: domSnapshotsForAnalysis,
    reportStatus,
    ...(analysisError !== undefined ? { analysisError } : {}),
    artifacts: formattedArtifacts,
    analysis,
    deterministicSurface,
    ...(browserTrace !== undefined ? { browserTrace } : {}),
    runMetadata: {
      targetUrl: scrapeResult.pageUrl,
      providerName: config.providerName,
      model: config.model,
      contextSize: config.modelContextSize,
      analysisConcurrency,
      localRagEnabled,
      browserAssisted,
      browserTraceStatus: browserTrace?.status ?? "disabled",
      ragSummary,
      counts: {
        htmlPages: scrapeResult.htmlPages.length,
        artifacts: formattedArtifacts.length,
        chunks: analysis.analyzedChunkCount,
        browserRequests: browserTrace?.requests.length ?? 0,
      },
    },
    ...(args.output !== undefined ? { outputPathOverride: args.output } : {}),
  });
  const htmlReportPath = join(runDirectory, "report.html");
  reportStep.stop(reportStatus === "partial" ? "Partial run artifacts written to disk" : "Run artifacts written to disk");

  const selectedModelInfo = findKnownModelInfo(config.model);
  const summaryLines = [
    reportStatus === "partial" ? `${pc.yellow("Analysis incomplete.")}` : `${pc.green("Analysis complete.")}`,
    `${pc.bold("Status:")} ${reportStatus === "partial" ? "partial report saved after error" : "complete"}`,
    `${pc.bold("Target:")} ${scrapeResult.pageUrl}`,
    `${pc.bold("Provider:")} ${config.providerName} (${config.model})`,
    ...(config.authMethod !== undefined ? [`${pc.bold("Auth:")} ${config.authMethod}`] : []),
    `${pc.bold("Context size:")} ${config.modelContextSize.toLocaleString()} tokens`,
    ...(config.openAiMode !== undefined ? [`${pc.bold("OpenAI mode:")} ${config.openAiMode}`] : []),
    ...(isCodexModel(config.model) && selectedModelInfo?.usageLimitsNote ? [`${pc.bold("Codex limits:")} ${selectedModelInfo.usageLimitsNote}`] : []),
    `${pc.bold("Concurrency:")} ${analysisConcurrency}`,
    `${pc.bold("Local RAG:")} ${localRagEnabled ? "enabled" : "disabled"}`,
    `${pc.bold("Browser trace:")} ${browserTrace?.status ?? (browserAssisted ? "failed" : "disabled")}`,
    ...(ragSummary !== undefined ? [`${pc.bold("RAG segments:")} ${ragSummary.segmentCount}`] : []),
    `${pc.bold("Pages:")} ${scrapeResult.htmlPages.length}`,
    `${pc.bold("Artifacts:")} ${formattedArtifacts.length}`,
    `${pc.bold("Chunks analyzed:")} ${analysis.analyzedChunkCount}`,
    `${pc.bold("REST endpoints:")} ${deterministicSurface.apiEndpoints.length}`,
    `${pc.bold("GraphQL endpoints:")} ${deterministicSurface.graphQlEndpoints.length}`,
    `${pc.bold("Auth flows:")} ${deterministicSurface.authFlows.length}`,
    `${pc.bold("Captcha flows:")} ${deterministicSurface.captchaFlows.length}`,
    `${pc.bold("Fingerprinting signals:")} ${deterministicSurface.fingerprintingSignals.length}`,
    `${pc.bold("Encryption signals:")} ${deterministicSurface.encryptionSignals.length}`,
    ...(browserTrace !== undefined ? [`${pc.bold("Browser requests:")} ${browserTrace.requests.length}`] : []),
    ...(analysisError !== undefined ? [`${pc.bold("Analysis error:")} ${analysisError}`] : []),
    `${pc.bold("Repo:")} ${pc.underline("https://github.com/redstone-md/Mapr")}`,
    `${pc.bold("Artifacts dir:")} ${pc.underline(runDirectory)}`,
    `${pc.bold("HTML report:")} ${pc.underline(htmlReportPath)}`,
    `${pc.bold("Report:")} ${pc.underline(reportPath)}`,
    `${pc.bold("Disclaimer:")} Author and contributors assume no liability.`,
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
