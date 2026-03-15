import { Buffer } from "buffer";
import { z } from "zod";

import type { StreamedObjectTelemetry } from "./ai-json";
import type { FormattedArtifact } from "./formatter";

export const DEFAULT_CHUNK_SIZE_BYTES = 80 * 1024;

export function createPromptEnvelope(input: {
  pageUrl: string;
  artifact: FormattedArtifact;
  chunk: string;
  chunkIndex: number;
  totalChunks: number;
  artifactPrimer?: string;
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
    input.artifactPrimer ? `Artifact primer from earlier chunk(s):\n${input.artifactPrimer}` : "Artifact primer from earlier chunk(s): none",
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

export function normalizeAiError(error: unknown): Error {
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

export function formatAgentTelemetrySuffix(telemetry: StreamedObjectTelemetry): string {
  const tokenCount = telemetry.outputTokens ?? telemetry.estimatedOutputTokens;
  const tokenLabel = telemetry.outputTokens !== undefined ? `${tokenCount} tok` : `~${tokenCount} tok`;
  const tpsLabel = telemetry.tokensPerSecond !== undefined ? ` ${telemetry.tokensPerSecond} tps` : "";
  return ` [${tokenLabel}${tpsLabel}]`;
}
