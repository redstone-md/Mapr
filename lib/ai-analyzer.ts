import { generateText, Output } from "ai";
import { Buffer } from "buffer";
import { z } from "zod";

import { artifactTypeSchema } from "./artifacts";
import type { FormattedArtifact } from "./formatter";
import { AiProviderClient, type AiProviderConfig } from "./provider";

export const DEFAULT_CHUNK_SIZE_BYTES = 80 * 1024;

const entryPointSchema = z.object({
  symbol: z.string().min(1),
  description: z.string().min(1),
  evidence: z.string().min(1),
});

const callGraphEdgeSchema = z.object({
  caller: z.string().min(1),
  callee: z.string().min(1),
  rationale: z.string().min(1),
});

const renamedSymbolSchema = z.object({
  originalName: z.string().min(1),
  suggestedName: z.string().min(1),
  justification: z.string().min(1),
});

const chunkAnalysisSchema = z.object({
  entryPoints: z.array(entryPointSchema).default([]),
  initializationFlow: z.array(z.string().min(1)).default([]),
  callGraph: z.array(callGraphEdgeSchema).default([]),
  restoredNames: z.array(renamedSymbolSchema).default([]),
  summary: z.string().min(1),
  notableLibraries: z.array(z.string().min(1)).default([]),
  investigationTips: z.array(z.string().min(1)).default([]),
  risks: z.array(z.string().min(1)).default([]),
});

const artifactSummarySchema = z.object({
  url: z.string().url(),
  type: artifactTypeSchema,
  chunkCount: z.number().int().nonnegative(),
  summary: z.string().min(1),
});

const finalAnalysisSchema = z.object({
  overview: z.string().min(1),
  entryPoints: z.array(entryPointSchema).default([]),
  initializationFlow: z.array(z.string().min(1)).default([]),
  callGraph: z.array(callGraphEdgeSchema).default([]),
  restoredNames: z.array(renamedSymbolSchema).default([]),
  notableLibraries: z.array(z.string().min(1)).default([]),
  investigationTips: z.array(z.string().min(1)).default([]),
  risks: z.array(z.string().min(1)).default([]),
  artifactSummaries: z.array(artifactSummarySchema),
  analyzedChunkCount: z.number().int().nonnegative(),
});

const analyzerOptionsSchema = z.object({
  providerConfig: z.object({
    providerType: z.enum(["openai", "openai-compatible"]),
    providerName: z.string().min(1),
    apiKey: z.string().min(1),
    baseURL: z.string().url(),
    model: z.string().min(1),
  }),
  chunkSizeBytes: z.number().int().positive().max(100 * 1024).default(DEFAULT_CHUNK_SIZE_BYTES),
});

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

export type BundleAnalysis = z.infer<typeof finalAnalysisSchema>;

type AnalyzerOptions = {
  providerConfig: AiProviderConfig;
  chunkSizeBytes?: number;
};

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

function deduplicate<T>(items: T[], keySelector: (item: T) => string): T[] {
  const seen = new Set<string>();
  const deduplicated: T[] = [];

  for (const item of items) {
    const key = keySelector(item);
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    deduplicated.push(item);
  }

  return deduplicated;
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
  private readonly options: z.infer<typeof analyzerOptionsSchema>;
  private readonly providerClient: AiProviderClient;

  public constructor(options: AnalyzerOptions) {
    this.options = analyzerOptionsSchema.parse(options);
    this.providerClient = new AiProviderClient(this.options.providerConfig);
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

    try {
      const chunkAnalyses: Array<z.infer<typeof chunkAnalysisSchema>> = [];
      const artifactSummaries: Array<z.infer<typeof artifactSummarySchema>> = [];

      for (const artifact of validatedInput.artifacts) {
        const chunks = chunkTextByBytes(artifact.formattedContent || artifact.content, this.options.chunkSizeBytes);
        const perArtifactChunkAnalyses: Array<z.infer<typeof chunkAnalysisSchema>> = [];

        for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex += 1) {
          const analysis = await this.analyzeChunk({
            pageUrl: validatedInput.pageUrl,
            artifact,
            chunk: chunks[chunkIndex] ?? "",
            chunkIndex,
            totalChunks: chunks.length,
          });

          chunkAnalyses.push(analysis);
          perArtifactChunkAnalyses.push(analysis);
        }

        artifactSummaries.push({
          url: artifact.url,
          type: artifact.type,
          chunkCount: chunks.length,
          summary: perArtifactChunkAnalyses.map((analysis) => analysis.summary).join(" "),
        });
      }

      return await this.summarizeFindings(validatedInput.pageUrl, artifactSummaries, chunkAnalyses);
    } catch (error) {
      throw normalizeAiError(error);
    }
  }

  private async analyzeChunk(input: {
    pageUrl: string;
    artifact: FormattedArtifact;
    chunk: string;
    chunkIndex: number;
    totalChunks: number;
  }) {
    const result = await generateText({
      model: this.providerClient.getModel(),
      system: [
        "You are reverse-engineering website artifacts including JavaScript, HTML, CSS, service workers, and WASM summaries.",
        "Return only structured output matching the schema.",
        "Focus on concrete execution flow, runtime entry points, inter-artifact relationships, restored names, and operator tips.",
      ].join(" "),
      prompt: [
        `Target page: ${input.pageUrl}`,
        `Artifact URL: ${input.artifact.url}`,
        `Artifact type: ${input.artifact.type}`,
        `Discovered from: ${input.artifact.discoveredFrom}`,
        `Chunk ${input.chunkIndex + 1} of ${input.totalChunks}`,
        input.artifact.formattingNote ? `Formatting note: ${input.artifact.formattingNote}` : "Formatting note: none",
        "Analyze the artifact content below.",
        "```text",
        input.chunk,
        "```",
      ].join("\n\n"),
      output: Output.object({ schema: chunkAnalysisSchema }),
      maxRetries: 2,
      providerOptions: {
        openai: {
          store: false,
        },
      },
    });

    return chunkAnalysisSchema.parse(result.output);
  }

  private async summarizeFindings(
    pageUrl: string,
    artifactSummaries: Array<z.infer<typeof artifactSummarySchema>>,
    chunkAnalyses: Array<z.infer<typeof chunkAnalysisSchema>>,
  ): Promise<BundleAnalysis> {
    try {
      const result = await generateText({
        model: this.providerClient.getModel(),
        system: [
          "You are consolidating reverse-engineering analyses from multiple website artifacts.",
          "Merge duplicates, produce a coherent site map, and include actionable investigation tips.",
          "Return only structured output matching the schema.",
        ].join(" "),
        prompt: [
          `Target page: ${pageUrl}`,
          "Artifact summaries:",
          JSON.stringify(artifactSummaries, null, 2),
          "Chunk analyses:",
          JSON.stringify(chunkAnalyses, null, 2),
        ].join("\n\n"),
        output: Output.object({
          schema: finalAnalysisSchema.omit({
            artifactSummaries: true,
            analyzedChunkCount: true,
          }),
        }),
        maxRetries: 2,
        providerOptions: {
          openai: {
            store: false,
          },
        },
      });

      return finalAnalysisSchema.parse({
        ...result.output,
        artifactSummaries,
        analyzedChunkCount: chunkAnalyses.length,
      });
    } catch {
      return finalAnalysisSchema.parse({
        overview: artifactSummaries.map((summary) => summary.summary).join(" ").trim() || "Artifact analysis completed.",
        entryPoints: deduplicate(
          chunkAnalyses.flatMap((analysis) => analysis.entryPoints),
          (entryPoint) => `${entryPoint.symbol}:${entryPoint.description}`,
        ),
        initializationFlow: deduplicate(
          chunkAnalyses.flatMap((analysis) => analysis.initializationFlow),
          (step) => step,
        ),
        callGraph: deduplicate(
          chunkAnalyses.flatMap((analysis) => analysis.callGraph),
          (edge) => `${edge.caller}->${edge.callee}`,
        ),
        restoredNames: deduplicate(
          chunkAnalyses.flatMap((analysis) => analysis.restoredNames),
          (entry) => `${entry.originalName}:${entry.suggestedName}`,
        ),
        notableLibraries: deduplicate(
          chunkAnalyses.flatMap((analysis) => analysis.notableLibraries),
          (library) => library,
        ),
        investigationTips: deduplicate(
          chunkAnalyses.flatMap((analysis) => analysis.investigationTips),
          (tip) => tip,
        ),
        risks: deduplicate(
          chunkAnalyses.flatMap((analysis) => analysis.risks),
          (risk) => risk,
        ),
        artifactSummaries,
        analyzedChunkCount: chunkAnalyses.length,
      });
    }
  }
}
