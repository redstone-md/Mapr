import { describe, expect, test } from "bun:test";

import { getConfigOverrides, parseCliArgs } from "../lib/cli-args";

describe("parseCliArgs", () => {
  test("parses headless flags and numeric options", () => {
    const args = parseCliArgs([
      "--headless",
      "--url",
      "http://localhost:5178",
      "--provider-type",
      "openai",
      "--openai-mode",
      "fast",
      "--auth-method",
      "codex-cli",
      "--codex-home",
      "C:\\Users\\Andrii\\.codex",
      "--provider-name",
      "OpenAI",
      "--base-url",
      "https://chatgpt.com/backend-api/codex",
      "--model",
      "gpt-5.4",
      "--context-size",
      "272000",
      "--analysis-concurrency",
      "3",
      "--local-rag",
      "--browser-assisted",
      "--browser-timeout-ms",
      "25000",
      "--max-pages",
      "6",
      "--max-artifacts",
      "150",
      "--max-depth",
      "4",
    ]);

    expect(args.headless).toBe(true);
    expect(args.url).toBe("http://localhost:5178");
    expect(args.openAiMode).toBe("fast");
    expect(args.authMethod).toBe("codex-cli");
    expect(args.codexHomePath).toBe("C:\\Users\\Andrii\\.codex");
    expect(args.contextSize).toBe(272000);
    expect(args.analysisConcurrency).toBe(3);
    expect(args.localRag).toBe(true);
    expect(args.browserAssisted).toBe(true);
    expect(args.browserTimeoutMs).toBe(25000);
    expect(args.maxPages).toBe(6);
    expect(args.maxArtifacts).toBe(150);
    expect(args.maxDepth).toBe(4);
  });

  test("supports explicit local rag disable", () => {
    const args = parseCliArgs(["--no-local-rag", "--no-browser-assisted"]);
    expect(args.localRag).toBe(false);
    expect(args.browserAssisted).toBe(false);
  });

  test("builds config overrides without undefined fields", () => {
    const overrides = getConfigOverrides(
      parseCliArgs([
        "--provider-type",
        "openai",
        "--openai-mode",
        "reasoning",
        "--auth-method",
        "codex-cli",
        "--codex-home",
        "C:\\Users\\Andrii\\.codex",
        "--model",
        "gpt-5.4",
        "--context-size",
        "272000",
      ]),
    );

    expect(overrides).toEqual({
      providerType: "openai",
      openAiMode: "reasoning",
      authMethod: "codex-cli",
      codexHomePath: "C:\\Users\\Andrii\\.codex",
      model: "gpt-5.4",
      modelContextSize: 272000,
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
