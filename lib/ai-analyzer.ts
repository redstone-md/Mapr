import { createOpenAI } from "@ai-sdk/openai";
import { generateText, Output } from "ai";
import { Buffer } from "buffer";
import { z } from "zod";

import type { FormattedBundle } from "./formatter";

export const DEFAULT_CHUNK_SIZE_BYTES = 80 * 1024;

const renamedSymbolSchema = z.object({
  originalName: z.string().min(1),
  suggestedName: z.string().min(1),
  justification: z.string().min(1),
});

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

const chunkAnalysisSchema = z.object({
  entryPoints: z.array(entryPointSchema).default([]),
  initializationFlow: z.array(z.string().min(1)).default([]),
  callGraph: z.array(callGraphEdgeSchema).default([]),
  restoredNames: z.array(renamedSymbolSchema).default([]),
  summary: z.string().min(1),
  notableLibraries: z.array(z.string().min(1)).default([]),
  risks: z.array(z.string().min(1)).default([]),
});

const finalAnalysisSchema = z.object({
  overview: z.string().min(1),
  entryPoints: z.array(entryPointSchema).default([]),
  initializationFlow: z.array(z.string().min(1)).default([]),
  callGraph: z.array(callGraphEdgeSchema).default([]),
  restoredNames: z.array(renamedSymbolSchema).default([]),
  notableLibraries: z.array(z.string().min(1)).default([]),
  risks: z.array(z.string().min(1)).default([]),
  bundleSummaries: z.array(
    z.object({
      url: z.string().url(),
      chunkCount: z.number().int().nonnegative(),
      summary: z.string().min(1),
    }),
  ),
  analyzedChunkCount: z.number().int().nonnegative(),
});

const analyzerOptionsSchema = z.object({
  apiKey: z.string().min(20),
  model: z.string().min(1).default("gpt-4.1-mini"),
  chunkSizeBytes: z.number().int().positive().max(100 * 1024).default(DEFAULT_CHUNK_SIZE_BYTES),
});

const analyzeInputSchema = z.object({
  pageUrl: z.string().url(),
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
});

export type ChunkAnalysis = z.infer<typeof chunkAnalysisSchema>;
export type BundleAnalysis = z.infer<typeof finalAnalysisSchema>;

type AnalyzerOptions = z.input<typeof analyzerOptionsSchema>;

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

function deduplicateObjects<T>(items: T[], keySelector: (item: T) => string): T[] {
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
    return new Error("OpenAI rate limit hit during analysis. Please retry in a moment.");
  }

  if (message.includes("api key")) {
    return new Error("OpenAI rejected the configured API key.");
  }

  return error;
}

export class AiBundleAnalyzer {
  private readonly options: z.infer<typeof analyzerOptionsSchema>;
  private readonly openai;

  public constructor(options: AnalyzerOptions) {
    this.options = analyzerOptionsSchema.parse(options);
    this.openai = createOpenAI({ apiKey: this.options.apiKey });
  }

  public async analyze(input: { pageUrl: string; bundles: FormattedBundle[] }): Promise<BundleAnalysis> {
    const validatedInput = analyzeInputSchema.parse(input);

    if (validatedInput.bundles.length === 0) {
      return finalAnalysisSchema.parse({
        overview: "No external JavaScript bundles were discovered on the target page.",
        entryPoints: [],
        initializationFlow: [],
        callGraph: [],
        restoredNames: [],
        notableLibraries: [],
        risks: [],
        bundleSummaries: [],
        analyzedChunkCount: 0,
      });
    }

    try {
      const bundleSummaries: Array<{ url: string; chunkCount: number; summary: string }> = [];
      const chunkAnalyses: ChunkAnalysis[] = [];

      for (const bundle of validatedInput.bundles) {
        const chunkSource = bundle.formattedCode || bundle.rawCode;
        const chunks = chunkTextByBytes(chunkSource, this.options.chunkSizeBytes);
        const bundleChunkAnalyses: ChunkAnalysis[] = [];

        for (let index = 0; index < chunks.length; index += 1) {
          const analysis = await this.analyzeChunk({
            pageUrl: validatedInput.pageUrl,
            bundle,
            chunk: chunks[index] ?? "",
            chunkIndex: index,
            totalChunks: chunks.length,
          });

          chunkAnalyses.push(analysis);
          bundleChunkAnalyses.push(analysis);
        }

        bundleSummaries.push({
          url: bundle.url,
          chunkCount: chunks.length,
          summary: bundleChunkAnalyses.map((analysis) => analysis.summary).join(" "),
        });
      }

      return await this.summarizeFindings({
        pageUrl: validatedInput.pageUrl,
        bundleSummaries,
        chunkAnalyses,
      });
    } catch (error) {
      throw normalizeAiError(error);
    }
  }

  private async analyzeChunk(input: {
    pageUrl: string;
    bundle: FormattedBundle;
    chunk: string;
    chunkIndex: number;
    totalChunks: number;
  }): Promise<ChunkAnalysis> {
    const result = await generateText({
      model: this.openai(this.options.model),
      system: [
        "You are reverse-engineering a frontend JavaScript bundle.",
        "Return only structured output matching the provided schema.",
        "Infer entry points, initialization flow, call relationships, and restored names from context.",
        "Do not speculate wildly; be explicit when evidence is weak.",
      ].join(" "),
      prompt: [
        `Target page: ${input.pageUrl}`,
        `Bundle URL: ${input.bundle.url}`,
        `Chunk ${input.chunkIndex + 1} of ${input.totalChunks}`,
        input.bundle.formattingNote ? `Formatting note: ${input.bundle.formattingNote}` : "Formatting note: none",
        "Analyze the JavaScript below.",
        "```javascript",
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

  private async summarizeFindings(input: {
    pageUrl: string;
    bundleSummaries: Array<{ url: string; chunkCount: number; summary: string }>;
    chunkAnalyses: ChunkAnalysis[];
  }): Promise<BundleAnalysis> {
    try {
      const synthesisResult = await generateText({
        model: this.openai(this.options.model),
        system: [
          "You are consolidating multiple partial reverse-engineering analyses of JavaScript bundles.",
          "Merge duplicates, preserve evidence-backed conclusions, and prefer precise technical language.",
          "Return only structured output matching the schema.",
        ].join(" "),
        prompt: [
          `Target page: ${input.pageUrl}`,
          "Bundle summaries:",
          JSON.stringify(input.bundleSummaries, null, 2),
          "Chunk analyses:",
          JSON.stringify(input.chunkAnalyses, null, 2),
        ].join("\n\n"),
        output: Output.object({
          schema: finalAnalysisSchema.omit({
            bundleSummaries: true,
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
        ...synthesisResult.output,
        bundleSummaries: input.bundleSummaries,
        analyzedChunkCount: input.chunkAnalyses.length,
      });
    } catch {
      const mergedEntryPoints = deduplicateObjects(
        input.chunkAnalyses.flatMap((analysis) => analysis.entryPoints),
        (entryPoint) => `${entryPoint.symbol}:${entryPoint.description}`,
      );
      const mergedFlow = deduplicateObjects(
        input.chunkAnalyses.flatMap((analysis) => analysis.initializationFlow),
        (step) => step,
      );
      const mergedGraph = deduplicateObjects(
        input.chunkAnalyses.flatMap((analysis) => analysis.callGraph),
        (edge) => `${edge.caller}->${edge.callee}`,
      );
      const mergedNames = deduplicateObjects(
        input.chunkAnalyses.flatMap((analysis) => analysis.restoredNames),
        (name) => `${name.originalName}:${name.suggestedName}`,
      );
      const libraries = deduplicateObjects(
        input.chunkAnalyses.flatMap((analysis) => analysis.notableLibraries),
        (library) => library,
      );
      const risks = deduplicateObjects(
        input.chunkAnalyses.flatMap((analysis) => analysis.risks),
        (risk) => risk,
      );

      return finalAnalysisSchema.parse({
        overview: input.bundleSummaries.map((summary) => summary.summary).join(" ").trim() || "Bundle analysis completed.",
        entryPoints: mergedEntryPoints,
        initializationFlow: mergedFlow,
        callGraph: mergedGraph,
        restoredNames: mergedNames,
        notableLibraries: libraries,
        risks,
        bundleSummaries: input.bundleSummaries,
        analyzedChunkCount: input.chunkAnalyses.length,
      });
    }
  }
}
