import { describe, expect, test } from "bun:test";

import { getConfigOverrides, parseCliArgs } from "../lib/cli-args";

describe("parseCliArgs", () => {
  test("parses headless flags and numeric options", () => {
    const args = parseCliArgs([
      "--headless",
      "--url",
      "http://localhost:5178",
      "--provider-type",
      "openai-compatible",
      "--provider-name",
      "Local vLLM",
      "--api-key",
      "secret",
      "--base-url",
      "http://localhost:8000/v1",
      "--model",
      "qwen2.5-coder",
      "--context-size",
      "512000",
      "--local-rag",
      "--max-pages",
      "6",
      "--max-artifacts",
      "150",
      "--max-depth",
      "4",
    ]);

    expect(args.headless).toBe(true);
    expect(args.url).toBe("http://localhost:5178");
    expect(args.contextSize).toBe(512000);
    expect(args.localRag).toBe(true);
    expect(args.maxPages).toBe(6);
    expect(args.maxArtifacts).toBe(150);
    expect(args.maxDepth).toBe(4);
  });

  test("builds config overrides without undefined fields", () => {
    const overrides = getConfigOverrides(
      parseCliArgs([
        "--provider-type",
        "openai-compatible",
        "--model",
        "qwen2.5-coder",
        "--context-size",
        "512000",
      ]),
    );

    expect(overrides).toEqual({
      providerType: "openai-compatible",
      model: "qwen2.5-coder",
      modelContextSize: 512000,
    });
  });

  test("expands provider preset defaults into config overrides", () => {
    const overrides = getConfigOverrides(
      parseCliArgs([
        "--provider-preset",
        "onlysq",
        "--api-key",
        "secret",
      ]),
    );

    expect(overrides).toEqual({
      providerType: "openai-compatible",
      providerPreset: "onlysq",
      providerName: "OnlySQ",
      apiKey: "secret",
      baseURL: "https://api.onlysq.ru/ai/openai",
    });
  });
});
