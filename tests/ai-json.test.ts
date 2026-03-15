import { describe, expect, test } from "bun:test";

import { estimateTokenCountFromText, extractJsonFromText } from "../lib/ai-json";

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

describe("estimateTokenCountFromText", () => {
  test("returns a stable token estimate from text length", () => {
    expect(estimateTokenCountFromText("")).toBe(0);
    expect(estimateTokenCountFromText("abcd")).toBe(1);
    expect(estimateTokenCountFromText("abcdefgh")).toBe(2);
  });
});
