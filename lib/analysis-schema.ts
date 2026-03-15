import { z } from "zod";

import { artifactTypeSchema } from "./artifacts";

export const entryPointSchema = z.object({
  symbol: z.string().min(1),
  description: z.string().min(1),
  evidence: z.string().min(1),
});

export const callGraphEdgeSchema = z.object({
  caller: z.string().min(1),
  callee: z.string().min(1),
  rationale: z.string().min(1),
});

export const renamedSymbolSchema = z.object({
  originalName: z.string().min(1),
  suggestedName: z.string().min(1),
  justification: z.string().min(1),
});

export const agentMemoSchema = z.object({
  role: z.string().min(1),
  summary: z.string().min(1),
  observations: z.array(z.string().min(1)).default([]),
  evidence: z.array(z.string().min(1)).default([]),
  nextQuestions: z.array(z.string().min(1)).default([]),
});

export const chunkAnalysisSchema = z.object({
  entryPoints: z.array(entryPointSchema).default([]),
  initializationFlow: z.array(z.string().min(1)).default([]),
  callGraph: z.array(callGraphEdgeSchema).default([]),
  restoredNames: z.array(renamedSymbolSchema).default([]),
  summary: z.string().min(1),
  notableLibraries: z.array(z.string().min(1)).default([]),
  investigationTips: z.array(z.string().min(1)).default([]),
  risks: z.array(z.string().min(1)).default([]),
});

export const artifactSummarySchema = z.object({
  url: z.string().url(),
  type: artifactTypeSchema,
  chunkCount: z.number().int().nonnegative(),
  summary: z.string().min(1),
});

export const finalAnalysisSchema = z.object({
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

export type BundleAnalysis = z.infer<typeof finalAnalysisSchema>;
export type AgentMemo = z.infer<typeof agentMemoSchema>;
export type ChunkAnalysis = z.infer<typeof chunkAnalysisSchema>;
export type ArtifactSummary = z.infer<typeof artifactSummarySchema>;

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

export function buildAnalysisSnapshot(input: {
  overview: string;
  artifactSummaries?: ArtifactSummary[];
  chunkAnalyses?: ChunkAnalysis[];
}): BundleAnalysis {
  const artifactSummaries = input.artifactSummaries ?? [];
  const chunkAnalyses = input.chunkAnalyses ?? [];

  return finalAnalysisSchema.parse({
    overview: input.overview,
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

export class PartialAnalysisError extends Error {
  public readonly partialAnalysis: BundleAnalysis;

  public constructor(message: string, partialAnalysis: BundleAnalysis) {
    super(message);
    this.name = "PartialAnalysisError";
    this.partialAnalysis = partialAnalysis;
  }
}
