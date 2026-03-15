import { describe, expect, test } from "bun:test";

import { extractJsonFromText, shouldFallbackToTextJson } from "../lib/ai-json";

describe("extractJsonFromText", () => {
  test("parses fenced JSON", () => {
    expect(extractJsonFromText('```json\n{"ok":true}\n```')).toEqual({ ok: true });
  });

  test("parses JSON embedded in surrounding text", () => {
    expect(extractJsonFromText('Here is the result: {"value":42,"items":["a"]} end.')).toEqual({
      value: 42,
      items: ["a"],
    });
  });
});

describe("shouldFallbackToTextJson", () => {
  test("matches unsupported structured output errors", () => {
    expect(shouldFallbackToTextJson(new Error("The feature responseFormat is not supported."))).toBe(true);
    expect(shouldFallbackToTextJson(new Error("No object generated: response did not match schema."))).toBe(true);
    expect(shouldFallbackToTextJson(new Error("401 unauthorized"))).toBe(false);
  });
});
