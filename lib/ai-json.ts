import { generateText, Output } from "ai";
import { z } from "zod";

const jsonFencePattern = /^```(?:json)?\s*([\s\S]*?)\s*```$/i;

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

export function shouldFallbackToTextJson(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const message = error.message.toLowerCase();
  return (
    message.includes("responseformat") ||
    message.includes("structured output") ||
    message.includes("structuredoutputs") ||
    message.includes("response did not match schema") ||
    message.includes("no object generated")
  );
}

export async function generateObjectWithTextFallback<TOutput>(input: {
  model: unknown;
  system: string;
  prompt: string;
  schema: z.ZodType<TOutput>;
  contract: string;
  maxRetries?: number;
  providerOptions?: Record<string, unknown>;
}): Promise<TOutput> {
  try {
    const structuredResult = await generateText({
      model: input.model as never,
      system: input.system,
      prompt: input.prompt,
      output: Output.object({ schema: input.schema }),
      maxRetries: input.maxRetries ?? 2,
      ...(input.providerOptions !== undefined ? { providerOptions: input.providerOptions as never } : {}),
    });

    return input.schema.parse(structuredResult.output);
  } catch (error) {
    if (!shouldFallbackToTextJson(error)) {
      throw error;
    }
  }

  const textResult = await generateText({
    model: input.model as never,
    system: [
      input.system,
      "Return only one valid JSON object.",
      "Do not wrap the JSON in markdown fences.",
      "Do not add explanations before or after the JSON.",
      input.contract,
    ].join("\n"),
    prompt: input.prompt,
    output: Output.text(),
    maxRetries: input.maxRetries ?? 2,
    ...(input.providerOptions !== undefined ? { providerOptions: input.providerOptions as never } : {}),
  });

  return input.schema.parse(extractJsonFromText(textResult.output));
}
