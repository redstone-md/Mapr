import { z } from "zod";
import { Buffer } from "buffer";

import {
  agentMemoSchema,
  artifactSummarySchema,
  buildAnalysisSnapshot,
  chunkAnalysisSchema,
  finalAnalysisSchema,
  type AgentMemo,
  type ArtifactSummary,
  type BundleAnalysis,
  type ChunkAnalysis,
  PartialAnalysisError,
} from "./analysis-schema";
import { generateObjectWithTextFallback } from "./ai-json";
import { artifactTypeSchema } from "./artifacts";
import type { FormattedArtifact } from "./formatter";
import { LocalArtifactRag } from "./local-rag";
import { AiProviderClient, type AiProviderConfig } from "./provider";
import { SWARM_AGENT_ORDER, getGlobalMissionPrompt, getSwarmAgentPrompt, type SwarmAgentName } from "./swarm-prompts";

export const DEFAULT_CHUNK_SIZE_BYTES = 80 * 1024;

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
export type AnalysisProgressState = "started" | "completed";

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
}

interface AnalyzerOptions {
  providerConfig: AiProviderConfig;
  chunkSizeBytes?: number;
  localRag?: boolean;
  onProgress?: (event: AnalysisProgressEvent) => void;
}

function createPromptEnvelope(input: {
  pageUrl: string;
  artifact: FormattedArtifact;
  chunk: string;
  chunkIndex: number;
  totalChunks: number;
  memory?: unknown;
  retrievedContext?: string[];
}): string {
  return [
    `Target page: ${input.pageUrl}`,
    `Artifact URL: ${input.artifact.url}`,
    `Artifact type: ${input.artifact.type}`,
    `Discovered from: ${input.artifact.discoveredFrom}`,
    `Chunk ${input.chunkIndex + 1} of ${input.totalChunks}`,
    input.artifact.formattingNote ? `Formatting note: ${input.artifact.formattingNote}` : "Formatting note: none",
    input.memory ? `Swarm memory:\n${JSON.stringify(input.memory, null, 2)}` : "Swarm memory: none yet",
    input.retrievedContext && input.retrievedContext.length > 0
      ? `Local RAG evidence:\n${input.retrievedContext.map((segment, index) => `Segment ${index + 1}:\n${segment}`).join("\n\n")}`
      : "Local RAG evidence: none",
    "Artifact content:",
    "```text",
    input.chunk,
    "```",
  ].join("\n\n");
}

function findSplitBoundary(source: string, start: number, end: number): number {
  const minimumPreferredIndex = start + Math.max(1, Math.floor((end - start) * 0.6));
  const preferredDelimiters = new Set(["\n", ";", "}", " ", ","]);

  for (let cursor = end - 1; cursor >= minimumPreferredIndex; cursor -= 1) {
    const character = source[cursor];
    if (character && preferredDelimiters.has(character)) {
      return cursor + 1;
    }
  }

  return end;
}

export function deriveChunkSizeBytes(modelContextSize: number): number {
  const validatedContextSize = z.number().int().positive().parse(modelContextSize);
  const derived = Math.floor(validatedContextSize * 0.9);
  return Math.max(DEFAULT_CHUNK_SIZE_BYTES, derived);
}

export function chunkTextByBytes(source: string, maxBytes = DEFAULT_CHUNK_SIZE_BYTES): string[] {
  const validatedSource = z.string().parse(source);
  const validatedMaxBytes = z.number().int().positive().parse(maxBytes);

  if (validatedSource.length === 0) {
    return [];
  }

  const chunks: string[] = [];
  let start = 0;

  while (start < validatedSource.length) {
    let end = Math.min(validatedSource.length, start + validatedMaxBytes);

    while (end > start && Buffer.byteLength(validatedSource.slice(start, end), "utf8") > validatedMaxBytes) {
      end -= 1;
    }

    if (end <= start) {
      end = start + 1;
    }

    const splitAt = end === validatedSource.length ? end : findSplitBoundary(validatedSource, start, end);
    chunks.push(validatedSource.slice(start, splitAt));
    start = splitAt;
  }

  return chunks;
}

function normalizeAiError(error: unknown): Error {
  if (!(error instanceof Error)) {
    return new Error("AI analysis failed with an unknown error.");
  }

  const message = error.message.toLowerCase();
  if (message.includes("rate limit")) {
    return new Error("Provider rate limit hit during analysis. Please retry in a moment.");
  }

  if (message.includes("api key")) {
    return new Error("The configured API key was rejected by the provider.");
  }

  return error;
}

export class AiBundleAnalyzer {
  private readonly providerClient: AiProviderClient;
  private readonly chunkSizeBytes: number;
  private readonly localRagEnabled: boolean;
  private readonly onProgress: ((event: AnalysisProgressEvent) => void) | undefined;

  public constructor(options: AnalyzerOptions) {
    this.providerClient = new AiProviderClient(options.providerConfig);
    this.chunkSizeBytes = options.chunkSizeBytes ?? deriveChunkSizeBytes(options.providerConfig.modelContextSize);
    this.localRagEnabled = options.localRag ?? false;
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

    try {
      const localRag = this.localRagEnabled ? new LocalArtifactRag(validatedInput.artifacts) : null;

      for (let artifactIndex = 0; artifactIndex < validatedInput.artifacts.length; artifactIndex += 1) {
        const artifact = validatedInput.artifacts[artifactIndex]!;
        const chunks = chunkTextByBytes(artifact.formattedContent || artifact.content, this.chunkSizeBytes);
        const perArtifactChunkAnalyses: ChunkAnalysis[] = [];

        this.emitProgress({
          stage: "artifact",
          state: "started",
          message: `Starting swarm analysis for artifact ${artifactIndex + 1}/${validatedInput.artifacts.length}: ${artifact.url}`,
          artifactIndex: artifactIndex + 1,
          artifactCount: validatedInput.artifacts.length,
          artifactUrl: artifact.url,
        });

        for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex += 1) {
          this.emitProgress({
            stage: "chunk",
            state: "started",
            message: `Starting chunk ${chunkIndex + 1}/${chunks.length} for ${artifact.url}`,
            artifactIndex: artifactIndex + 1,
            artifactCount: validatedInput.artifacts.length,
            artifactUrl: artifact.url,
            chunkIndex: chunkIndex + 1,
            chunkCount: chunks.length,
          });

          const analysis = await this.analyzeChunkWithSwarm({
            pageUrl: validatedInput.pageUrl,
            artifact,
            chunk: chunks[chunkIndex] ?? "",
            chunkIndex,
            totalChunks: chunks.length,
            artifactIndex: artifactIndex + 1,
            artifactCount: validatedInput.artifacts.length,
            localRag,
          });

          chunkAnalyses.push(analysis);
          perArtifactChunkAnalyses.push(analysis);

          this.emitProgress({
            stage: "chunk",
            state: "completed",
            message: `Completed chunk ${chunkIndex + 1}/${chunks.length} for ${artifact.url}`,
            artifactIndex: artifactIndex + 1,
            artifactCount: validatedInput.artifacts.length,
            artifactUrl: artifact.url,
            chunkIndex: chunkIndex + 1,
            chunkCount: chunks.length,
          });
        }

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
    } catch (error) {
      const normalizedError = normalizeAiError(error);
      const partialAnalysis = buildAnalysisSnapshot({
        overview:
          chunkAnalyses.length > 0 || artifactSummaries.length > 0
            ? `Partial analysis only. Processing stopped because: ${normalizedError.message}`
            : `Analysis aborted before any chunk completed. Cause: ${normalizedError.message}`,
        artifactSummaries,
        chunkAnalyses,
      });

      throw new PartialAnalysisError(normalizedError.message, partialAnalysis);
    }
  }

  private async analyzeChunkWithSwarm(input: {
    pageUrl: string;
    artifact: FormattedArtifact;
    chunk: string;
    chunkIndex: number;
    totalChunks: number;
    artifactIndex: number;
    artifactCount: number;
    localRag: LocalArtifactRag | null;
  }): Promise<ChunkAnalysis> {
    const memory: Partial<Record<SwarmAgentName, AgentMemo | ChunkAnalysis>> = {};

    for (const agent of SWARM_AGENT_ORDER) {
      this.emitProgress({
        stage: "agent",
        state: "started",
        message: `${agent} agent running on ${input.artifact.url} chunk ${input.chunkIndex + 1}/${input.totalChunks}`,
        artifactIndex: input.artifactIndex,
        artifactCount: input.artifactCount,
        artifactUrl: input.artifact.url,
        chunkIndex: input.chunkIndex + 1,
        chunkCount: input.totalChunks,
        agent,
      });

      if (agent === "synthesizer") {
        const synthesized = await this.runSynthesisAgent(input, memory, this.getRetrievedContext(agent, input, memory));
        memory[agent] = synthesized;
      } else {
        const memo = await this.runMemoAgent(agent, input, memory, this.getRetrievedContext(agent, input, memory));
        memory[agent] = memo;
      }

      this.emitProgress({
        stage: "agent",
        state: "completed",
        message: `${agent} agent completed ${input.artifact.url} chunk ${input.chunkIndex + 1}/${input.totalChunks}`,
        artifactIndex: input.artifactIndex,
        artifactCount: input.artifactCount,
        artifactUrl: input.artifact.url,
        chunkIndex: input.chunkIndex + 1,
        chunkCount: input.totalChunks,
        agent,
      });
    }

    return chunkAnalysisSchema.parse(memory.synthesizer);
  }

  private async runMemoAgent(
    agent: Exclude<SwarmAgentName, "synthesizer">,
    input: {
      pageUrl: string;
      artifact: FormattedArtifact;
      chunk: string;
      chunkIndex: number;
      totalChunks: number;
    },
    memory: Partial<Record<SwarmAgentName, unknown>>,
    retrievedContext: string[],
  ): Promise<AgentMemo> {
    return generateObjectWithTextFallback({
      model: this.providerClient.getModel(),
      system: getSwarmAgentPrompt(agent),
      prompt: createPromptEnvelope({
        pageUrl: input.pageUrl,
        artifact: input.artifact,
        chunk: input.chunk,
        chunkIndex: input.chunkIndex,
        totalChunks: input.totalChunks,
        memory,
        retrievedContext,
      }),
      schema: agentMemoSchema,
      contract: [
        "JSON contract:",
        '{"role":"string","summary":"string","observations":["string"],"evidence":["string"],"nextQuestions":["string"]}',
      ].join("\n"),
      maxRetries: 2,
      providerOptions: {
        openai: {
          store: false,
        },
      },
    });
  }

  private async runSynthesisAgent(
    input: {
      pageUrl: string;
      artifact: FormattedArtifact;
      chunk: string;
      chunkIndex: number;
      totalChunks: number;
    },
    memory: Partial<Record<SwarmAgentName, unknown>>,
    retrievedContext: string[],
  ): Promise<ChunkAnalysis> {
    return generateObjectWithTextFallback({
      model: this.providerClient.getModel(),
      system: getSwarmAgentPrompt("synthesizer"),
      prompt: createPromptEnvelope({
        pageUrl: input.pageUrl,
        artifact: input.artifact,
        chunk: input.chunk,
        chunkIndex: input.chunkIndex,
        totalChunks: input.totalChunks,
        memory,
        retrievedContext,
      }),
      schema: chunkAnalysisSchema,
      contract: [
        "JSON contract:",
        '{"entryPoints":[{"symbol":"string","description":"string","evidence":"string"}],"initializationFlow":["string"],"callGraph":[{"caller":"string","callee":"string","rationale":"string"}],"restoredNames":[{"originalName":"string","suggestedName":"string","justification":"string"}],"summary":"string","notableLibraries":["string"],"investigationTips":["string"],"risks":["string"]}',
      ].join("\n"),
      maxRetries: 2,
      providerOptions: {
        openai: {
          store: false,
        },
      },
    });
  }

  private async summarizeFindings(
    pageUrl: string,
    artifactSummaries: ArtifactSummary[],
    chunkAnalyses: ChunkAnalysis[],
  ): Promise<BundleAnalysis> {
    try {
      const result = await generateObjectWithTextFallback({
        model: this.providerClient.getModel(),
        system: [
          getGlobalMissionPrompt(),
          "You are the lead synthesis agent for the final report.",
          "Merge artifact summaries and chunk analyses into a coherent site-level reverse-engineering map with the strongest evidence available.",
        ].join(" "),
        prompt: [
          `Target page: ${pageUrl}`,
          "Artifact summaries:",
          JSON.stringify(artifactSummaries, null, 2),
          "Chunk analyses:",
          JSON.stringify(chunkAnalyses, null, 2),
        ].join("\n\n"),
        schema: finalAnalysisSchema.omit({
          artifactSummaries: true,
          analyzedChunkCount: true,
        }),
        contract: [
          "JSON contract:",
          '{"overview":"string","entryPoints":[{"symbol":"string","description":"string","evidence":"string"}],"initializationFlow":["string"],"callGraph":[{"caller":"string","callee":"string","rationale":"string"}],"restoredNames":[{"originalName":"string","suggestedName":"string","justification":"string"}],"notableLibraries":["string"],"investigationTips":["string"],"risks":["string"]}',
        ].join("\n"),
        maxRetries: 2,
        providerOptions: {
          openai: {
            store: false,
          },
        },
      });

      return finalAnalysisSchema.parse({
        ...result,
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
    input: {
      artifact: FormattedArtifact;
      chunk: string;
      localRag: LocalArtifactRag | null;
    },
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

    const memoryText = Object.values(memory)
      .map((entry) => JSON.stringify(entry))
      .join(" ");

    return input.localRag.query({
      artifactUrl: input.artifact.url,
      query: `${agentKeywords[agent]} ${input.chunk} ${memoryText}`.slice(0, 6000),
      excludeContent: input.chunk,
    });
  }
}
