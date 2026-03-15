import { streamText } from "ai";
import { z } from "zod";

const jsonFencePattern = /^```(?:json)?\s*([\s\S]*?)\s*```$/i;
const STREAM_PROGRESS_INTERVAL_MS = 750;
const ESTIMATED_CHARS_PER_TOKEN = 4;

export interface StreamedObjectTelemetry {
  elapsedMs: number;
  estimatedOutputTokens: number;
  outputTokens?: number;
  tokensPerSecond?: number;
}

export interface StreamedObjectResult<TOutput> {
  object: TOutput;
  telemetry: StreamedObjectTelemetry;
}

function extractBalancedJsonSlice(source: string): string | null {
  const startIndex = source.search(/[\[{]/);
  if (startIndex < 0) {
    return null;
  }

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = startIndex; index < source.length; index += 1) {
    const character = source[index];
    if (!character) {
      continue;
    }

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === "\"") {
        inString = false;
      }

      continue;
    }

    if (character === "\"") {
      inString = true;
      continue;
    }

    if (character === "{" || character === "[") {
      depth += 1;
      continue;
    }

    if (character === "}" || character === "]") {
      depth -= 1;
      if (depth === 0) {
        return source.slice(startIndex, index + 1);
      }
    }
  }

  return null;
}

function formatJsonSystemPrompt(system: string, contract: string): string {
  return [
    system,
    "Return only one valid JSON object.",
    "Do not wrap the JSON in markdown fences.",
    "Do not add explanations before or after the JSON.",
    contract,
  ].join("\n");
}

function calculateTokensPerSecond(tokenCount: number, elapsedMs: number): number | undefined {
  if (tokenCount <= 0 || elapsedMs < 250) {
    return undefined;
  }

  return Number((tokenCount / (elapsedMs / 1000)).toFixed(1));
}

export function estimateTokenCountFromText(source: string): number {
  const trimmed = source.trim();
  if (trimmed.length === 0) {
    return 0;
  }

  return Math.max(1, Math.ceil(trimmed.length / ESTIMATED_CHARS_PER_TOKEN));
}

export function extractJsonFromText(source: string): unknown {
  const trimmed = source.trim();
  if (!trimmed) {
    throw new Error("Model returned empty text instead of JSON.");
  }

  const fenced = trimmed.match(jsonFencePattern)?.[1]?.trim();
  const directCandidate = fenced ?? trimmed;

  try {
    return JSON.parse(directCandidate) as unknown;
  } catch {
    const balancedSlice = extractBalancedJsonSlice(directCandidate);
    if (!balancedSlice) {
      throw new Error("No JSON object found in model output.");
    }

    return JSON.parse(balancedSlice) as unknown;
  }
}

export async function generateObjectFromStream<TOutput>(input: {
  model: unknown;
  system: string;
  prompt: string;
  schema: z.ZodType<TOutput>;
  contract: string;
  maxRetries?: number;
  providerOptions?: Record<string, unknown>;
  onProgress?: (telemetry: StreamedObjectTelemetry) => void;
}): Promise<StreamedObjectResult<TOutput>> {
  let streamedText = "";
  const startedAt = Date.now();
  let lastProgressAt = 0;

  const result = streamText({
    model: input.model as never,
    system: formatJsonSystemPrompt(input.system, input.contract),
    prompt: input.prompt,
    maxRetries: input.maxRetries ?? 2,
    ...(input.providerOptions !== undefined ? { providerOptions: input.providerOptions as never } : {}),
  });

  for await (const textPart of result.textStream) {
    streamedText += textPart;

    const now = Date.now();
    if (input.onProgress !== undefined && now - lastProgressAt >= STREAM_PROGRESS_INTERVAL_MS) {
      const estimatedOutputTokens = estimateTokenCountFromText(streamedText);
      const tokensPerSecond = calculateTokensPerSecond(estimatedOutputTokens, now - startedAt);
      input.onProgress({
        elapsedMs: now - startedAt,
        estimatedOutputTokens,
        ...(tokensPerSecond !== undefined ? { tokensPerSecond } : {}),
      });
      lastProgressAt = now;
    }
  }

  let usage: Awaited<typeof result.usage> | undefined;
  try {
    usage = await result.usage;
  } catch {
    usage = undefined;
  }
  const elapsedMs = Date.now() - startedAt;
  const estimatedOutputTokens = estimateTokenCountFromText(streamedText);
  const outputTokens = usage?.outputTokens ?? undefined;
  const tokensPerSecond = calculateTokensPerSecond(outputTokens ?? estimatedOutputTokens, elapsedMs);
  const telemetry: StreamedObjectTelemetry = {
    elapsedMs,
    estimatedOutputTokens,
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(tokensPerSecond !== undefined ? { tokensPerSecond } : {}),
  };

  input.onProgress?.(telemetry);

  return {
    object: input.schema.parse(extractJsonFromText(streamedText)),
    telemetry,
  };
}
