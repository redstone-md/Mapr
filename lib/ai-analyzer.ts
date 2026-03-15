import { z } from "zod";

import type { AgentMemo, ArtifactSummary, BundleAnalysis, ChunkAnalysis } from "./analysis-schema";
import {
  agentMemoSchema,
  buildAnalysisSnapshot,
  chunkAnalysisSchema,
  finalAnalysisSchema,
  PartialAnalysisError,
} from "./analysis-schema";
import { createFallbackAgentMemo, createFallbackChunkAnalysis } from "./analysis-fallback";
import {
  chunkTextByBytes,
  createPromptEnvelope,
  deriveChunkSizeBytes,
  formatAgentTelemetrySuffix,
  normalizeAiError,
} from "./analysis-helpers";
import { generateObjectFromStream, type StreamedObjectTelemetry } from "./ai-json";
import { artifactTypeSchema } from "./artifacts";
import type { FormattedArtifact } from "./formatter";
import { LocalArtifactRag } from "./local-rag";
import { mapWithConcurrency } from "./promise-pool";
import { AiProviderClient, type AiProviderConfig } from "./provider";
import { getGlobalMissionPrompt, getSwarmAgentPrompt, SWARM_AGENT_ORDER, type SwarmAgentName } from "./swarm-prompts";

const analyzeInputSchema = z.object({
  pageUrl: z.string().url(),
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
});

export type AnalysisProgressStage = "artifact" | "chunk" | "agent";
export type AnalysisProgressState = "started" | "streaming" | "completed";

export interface AnalysisProgressEvent {
  stage: AnalysisProgressStage;
  state: AnalysisProgressState;
  message: string;
  artifactIndex: number;
  artifactCount: number;
  artifactUrl: string;
  chunkIndex?: number;
  chunkCount?: number;
  agent?: SwarmAgentName;
  estimatedOutputTokens?: number;
  outputTokens?: number;
  tokensPerSecond?: number;
}

interface AnalyzerOptions {
  providerConfig: AiProviderConfig;
  chunkSizeBytes?: number;
  localRag?: boolean;
  analysisConcurrency?: number;
  onProgress?: (event: AnalysisProgressEvent) => void;
}

interface ChunkTaskInput {
  pageUrl: string;
  artifact: FormattedArtifact;
  chunk: string;
  chunkIndex: number;
  totalChunks: number;
  artifactIndex: number;
  artifactCount: number;
  localRag: LocalArtifactRag | null;
}

export { chunkTextByBytes, deriveChunkSizeBytes } from "./analysis-helpers";

export class AiBundleAnalyzer {
  private readonly providerClient: AiProviderClient;
  private readonly chunkSizeBytes: number;
  private readonly localRagEnabled: boolean;
  private readonly analysisConcurrency: number;
  private readonly onProgress: ((event: AnalysisProgressEvent) => void) | undefined;
  private readonly providerOptions: Record<string, unknown>;

  public constructor(options: AnalyzerOptions) {
    this.providerClient = new AiProviderClient(options.providerConfig);
    this.chunkSizeBytes = options.chunkSizeBytes ?? deriveChunkSizeBytes(options.providerConfig.modelContextSize);
    this.localRagEnabled = options.localRag ?? false;
    this.analysisConcurrency = Math.max(1, Math.floor(options.analysisConcurrency ?? 1));
    this.providerOptions = this.providerClient.getProviderOptions();
    this.onProgress = options.onProgress;
  }

  public async analyze(input: { pageUrl: string; artifacts: FormattedArtifact[] }): Promise<BundleAnalysis> {
    const validatedInput = analyzeInputSchema.parse(input);

    if (validatedInput.artifacts.length === 0) {
      return finalAnalysisSchema.parse({
        overview: "No analyzable website artifacts were discovered on the target page.",
        entryPoints: [],
        initializationFlow: [],
        callGraph: [],
        restoredNames: [],
        notableLibraries: [],
        investigationTips: [],
        risks: [],
        artifactSummaries: [],
        analyzedChunkCount: 0,
      });
    }

    const chunkAnalyses: ChunkAnalysis[] = [];
    const artifactSummaries: ArtifactSummary[] = [];
    const localRag = this.localRagEnabled ? new LocalArtifactRag(validatedInput.artifacts) : null;

    for (let artifactIndex = 0; artifactIndex < validatedInput.artifacts.length; artifactIndex += 1) {
      const artifact = validatedInput.artifacts[artifactIndex]!;
      const chunks = chunkTextByBytes(artifact.formattedContent || artifact.content, this.chunkSizeBytes);

      this.emitProgress({
        stage: "artifact",
        state: "started",
        message: `Starting swarm analysis for artifact ${artifactIndex + 1}/${validatedInput.artifacts.length}: ${artifact.url}`,
        artifactIndex: artifactIndex + 1,
        artifactCount: validatedInput.artifacts.length,
        artifactUrl: artifact.url,
      });

      const perArtifactChunkAnalyses = await mapWithConcurrency(
        chunks,
        this.analysisConcurrency,
        async (chunk, chunkIndex): Promise<ChunkAnalysis> => {
          const chunkInput: ChunkTaskInput = {
            pageUrl: validatedInput.pageUrl,
            artifact,
            chunk,
            chunkIndex,
            totalChunks: chunks.length,
            artifactIndex: artifactIndex + 1,
            artifactCount: validatedInput.artifacts.length,
            localRag,
          };

          this.emitChunkEvent("started", chunkInput);
          const analysis = await this.analyzeChunkWithSwarm(chunkInput);
          this.emitChunkEvent("completed", chunkInput);
          return analysis;
        },
      );

      chunkAnalyses.push(...perArtifactChunkAnalyses);
      artifactSummaries.push({
        url: artifact.url,
        type: artifact.type,
        chunkCount: chunks.length,
        summary: perArtifactChunkAnalyses.map((analysis) => analysis.summary).join(" "),
      });

      this.emitProgress({
        stage: "artifact",
        state: "completed",
        message: `Completed swarm analysis for artifact ${artifactIndex + 1}/${validatedInput.artifacts.length}: ${artifact.url}`,
        artifactIndex: artifactIndex + 1,
        artifactCount: validatedInput.artifacts.length,
        artifactUrl: artifact.url,
      });
    }

    return await this.summarizeFindings(validatedInput.pageUrl, artifactSummaries, chunkAnalyses);
  }

  private emitChunkEvent(state: Extract<AnalysisProgressState, "started" | "completed">, input: ChunkTaskInput): void {
    this.emitProgress({
      stage: "chunk",
      state,
      message: `${state === "started" ? "Starting" : "Completed"} chunk ${input.chunkIndex + 1}/${input.totalChunks} for ${input.artifact.url}`,
      artifactIndex: input.artifactIndex,
      artifactCount: input.artifactCount,
      artifactUrl: input.artifact.url,
      chunkIndex: input.chunkIndex + 1,
      chunkCount: input.totalChunks,
    });
  }

  private async analyzeChunkWithSwarm(input: ChunkTaskInput): Promise<ChunkAnalysis> {
    const memory: Partial<Record<SwarmAgentName, AgentMemo | ChunkAnalysis>> = {};

    for (const agent of SWARM_AGENT_ORDER) {
      this.emitAgentEvent("started", agent, input, `${agent} agent running on ${input.artifact.url} chunk ${input.chunkIndex + 1}/${input.totalChunks}`);

      try {
        if (agent === "synthesizer") {
          const synthesized = await this.runSynthesisAgent(input, memory, this.getRetrievedContext(agent, input, memory));
          memory[agent] = synthesized.object;
          this.emitAgentCompletion(agent, input, synthesized.telemetry);
          continue;
        }

        const memo = await this.runMemoAgent(agent, input, memory, this.getRetrievedContext(agent, input, memory));
        memory[agent] = memo.object;
        this.emitAgentCompletion(agent, input, memo.telemetry);
      } catch (error) {
        const normalizedError = normalizeAiError(error);
        memory[agent] =
          agent === "synthesizer"
            ? createFallbackChunkAnalysis({ artifactUrl: input.artifact.url, memory, error: normalizedError })
            : createFallbackAgentMemo(agent, normalizedError);

        this.emitAgentEvent(
          "completed",
          agent,
          input,
          `${agent} agent fell back ${input.artifact.url} chunk ${input.chunkIndex + 1}/${input.totalChunks}: ${normalizedError.message}`,
        );
      }
    }

    return chunkAnalysisSchema.parse(memory.synthesizer);
  }

  private emitAgentCompletion(agent: SwarmAgentName, input: ChunkTaskInput, telemetry: StreamedObjectTelemetry): void {
    this.emitAgentEvent(
      "completed",
      agent,
      input,
      `${agent} agent completed ${input.artifact.url} chunk ${input.chunkIndex + 1}/${input.totalChunks}${formatAgentTelemetrySuffix(telemetry)}`,
      telemetry,
    );
  }

  private emitAgentEvent(
    state: AnalysisProgressState,
    agent: SwarmAgentName,
    input: ChunkTaskInput,
    message: string,
    telemetry?: StreamedObjectTelemetry,
  ): void {
    this.emitProgress({
      stage: "agent",
      state,
      message,
      artifactIndex: input.artifactIndex,
      artifactCount: input.artifactCount,
      artifactUrl: input.artifact.url,
      chunkIndex: input.chunkIndex + 1,
      chunkCount: input.totalChunks,
      agent,
      ...(telemetry !== undefined ? { estimatedOutputTokens: telemetry.estimatedOutputTokens } : {}),
      ...(telemetry?.outputTokens !== undefined ? { outputTokens: telemetry.outputTokens } : {}),
      ...(telemetry?.tokensPerSecond !== undefined ? { tokensPerSecond: telemetry.tokensPerSecond } : {}),
    });
  }

  private async runMemoAgent(
    agent: Exclude<SwarmAgentName, "synthesizer">,
    input: ChunkTaskInput,
    memory: Partial<Record<SwarmAgentName, unknown>>,
    retrievedContext: string[],
  ): Promise<{ object: AgentMemo; telemetry: StreamedObjectTelemetry }> {
    return generateObjectFromStream({
      model: this.providerClient.getModel(),
      system: getSwarmAgentPrompt(agent),
      prompt: createPromptEnvelope({ ...input, memory, retrievedContext }),
      schema: agentMemoSchema,
      contract: [
        "JSON contract:",
        '{"role":"string","summary":"string","observations":["string"],"evidence":["string"],"nextQuestions":["string"]}',
      ].join("\n"),
      attempts: 4,
      maxRetries: 2,
      providerOptions: this.providerOptions,
      onRetry: (attempt, error) =>
        this.emitAgentEvent(
          "streaming",
          agent,
          input,
          `${agent} agent retry ${attempt}/4 ${input.artifact.url} chunk ${input.chunkIndex + 1}/${input.totalChunks}: ${error.message}`,
        ),
      onProgress: (telemetry) =>
        this.emitAgentEvent(
          "streaming",
          agent,
          input,
          `${agent} agent streaming ${input.artifact.url} chunk ${input.chunkIndex + 1}/${input.totalChunks}${formatAgentTelemetrySuffix(telemetry)}`,
          telemetry,
        ),
    });
  }

  private async runSynthesisAgent(
    input: ChunkTaskInput,
    memory: Partial<Record<SwarmAgentName, unknown>>,
    retrievedContext: string[],
  ): Promise<{ object: ChunkAnalysis; telemetry: StreamedObjectTelemetry }> {
    return generateObjectFromStream({
      model: this.providerClient.getModel(),
      system: getSwarmAgentPrompt("synthesizer"),
      prompt: createPromptEnvelope({ ...input, memory, retrievedContext }),
      schema: chunkAnalysisSchema,
      contract: [
        "JSON contract:",
        '{"entryPoints":[{"symbol":"string","description":"string","evidence":"string"}],"initializationFlow":["string"],"callGraph":[{"caller":"string","callee":"string","rationale":"string"}],"restoredNames":[{"originalName":"string","suggestedName":"string","justification":"string"}],"summary":"string","notableLibraries":["string"],"investigationTips":["string"],"risks":["string"]}',
      ].join("\n"),
      attempts: 4,
      maxRetries: 2,
      providerOptions: this.providerOptions,
      onRetry: (attempt, error) =>
        this.emitAgentEvent(
          "streaming",
          "synthesizer",
          input,
          `synthesizer agent retry ${attempt}/4 ${input.artifact.url} chunk ${input.chunkIndex + 1}/${input.totalChunks}: ${error.message}`,
        ),
      onProgress: (telemetry) =>
        this.emitAgentEvent(
          "streaming",
          "synthesizer",
          input,
          `synthesizer agent streaming ${input.artifact.url} chunk ${input.chunkIndex + 1}/${input.totalChunks}${formatAgentTelemetrySuffix(telemetry)}`,
          telemetry,
        ),
    });
  }

  private async summarizeFindings(
    pageUrl: string,
    artifactSummaries: ArtifactSummary[],
    chunkAnalyses: ChunkAnalysis[],
  ): Promise<BundleAnalysis> {
    try {
      const result = await generateObjectFromStream({
        model: this.providerClient.getModel(),
        system: [
          getGlobalMissionPrompt(),
          "You are the lead synthesis agent for the final report.",
          "Merge artifact summaries and chunk analyses into a coherent site-level reverse-engineering map with the strongest evidence available.",
        ].join(" "),
        prompt: [`Target page: ${pageUrl}`, "Artifact summaries:", JSON.stringify(artifactSummaries, null, 2), "Chunk analyses:", JSON.stringify(chunkAnalyses, null, 2)].join("\n\n"),
        schema: finalAnalysisSchema.omit({ artifactSummaries: true, analyzedChunkCount: true }),
        contract: [
          "JSON contract:",
          '{"overview":"string","entryPoints":[{"symbol":"string","description":"string","evidence":"string"}],"initializationFlow":["string"],"callGraph":[{"caller":"string","callee":"string","rationale":"string"}],"restoredNames":[{"originalName":"string","suggestedName":"string","justification":"string"}],"notableLibraries":["string"],"investigationTips":["string"],"risks":["string"]}',
        ].join("\n"),
        attempts: 4,
        maxRetries: 2,
        providerOptions: this.providerOptions,
      });

      return finalAnalysisSchema.parse({
        ...result.object,
        artifactSummaries,
        analyzedChunkCount: chunkAnalyses.length,
      });
    } catch {
      return buildAnalysisSnapshot({
        overview: artifactSummaries.map((summary) => summary.summary).join(" ").trim() || "Artifact analysis completed.",
        artifactSummaries,
        chunkAnalyses,
      });
    }
  }

  private emitProgress(event: AnalysisProgressEvent): void {
    this.onProgress?.(event);
  }

  private getRetrievedContext(
    agent: SwarmAgentName,
    input: Pick<ChunkTaskInput, "artifact" | "chunk" | "localRag">,
    memory: Partial<Record<SwarmAgentName, unknown>>,
  ): string[] {
    if (!input.localRag) {
      return [];
    }

    const agentKeywords: Record<SwarmAgentName, string> = {
      scout: "imports exports framework runtime mount hydrate render boot start worker register fetch cache dom route manifest css wasm",
      runtime: "entry init bootstrap mount hydrate listener event lifecycle schedule render message postMessage fetch call graph trigger",
      naming: "function class variable module store client request response state cache token auth session api route handler service",
      security: "auth token session cookie localStorage sessionStorage indexedDB cache service worker telemetry endpoint wasm trust dynamic import",
      synthesizer: "entry points call graph restored names investigation tips risks runtime relationships architecture summary",
    };

    const memoryText = Object.values(memory).map((entry) => JSON.stringify(entry)).join(" ");
    return input.localRag.query({
      artifactUrl: input.artifact.url,
      query: `${agentKeywords[agent]} ${input.chunk} ${memoryText}`.slice(0, 6000),
      excludeContent: input.chunk,
    });
  }
}
