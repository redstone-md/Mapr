import { describe, expect, test } from "bun:test";

import {
  AiProviderClient,
  extractContextWindowFromMetadata,
  findKnownModelInfo,
  inferCodexMode,
  inferProviderPreset,
  resolveCodexModelForMode,
} from "../lib/provider";

describe("AiProviderClient", () => {
  test("fetches model ids from an OpenAI-compatible models endpoint", async () => {
    const client = new AiProviderClient({
      providerType: "openai-compatible",
      providerName: "Local vLLM",
      apiKey: "secret",
      baseURL: "http://localhost:8000/v1",
      model: "unused",
      modelContextSize: 128000,
    });

    const calls: string[] = [];
    const fetcher = async (input: string | URL | Request): Promise<Response> => {
      calls.push(String(input));
      return new Response(
        JSON.stringify({
          data: [{ id: "qwen2.5-coder" }, { id: "llama-3.3-70b" }, { id: "qwen2.5-coder" }],
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    };

    const models = await client.fetchModels(fetcher);

    expect(calls).toEqual(["http://localhost:8000/v1/models"]);
    expect(models).toEqual(["llama-3.3-70b", "qwen2.5-coder"]);
  });

  test("extracts context size from provider model metadata", async () => {
    const client = new AiProviderClient({
      providerType: "openai-compatible",
      providerName: "BlackBox AI",
      providerPreset: "blackbox",
      apiKey: "secret",
      baseURL: "https://api.blackbox.ai",
      model: "unused",
      modelContextSize: 128000,
    });

    const catalog = await client.fetchModelCatalog(async () =>
      new Response(
        JSON.stringify({
          data: [
            { id: "z-ai/glm-5", context_length: 128000 },
            { id: "z-ai/glm-5.chat", tags: ["context: 256k"] },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    expect(catalog).toEqual([
      { id: "z-ai/glm-5", contextSize: 128000 },
      { id: "z-ai/glm-5.chat", contextSize: 256000 },
    ]);
  });

  test("uses the OnlySQ model catalog endpoint override", async () => {
    const calls: string[] = [];
    const client = new AiProviderClient({
      providerType: "openai-compatible",
      providerName: "OnlySQ",
      providerPreset: "onlysq",
      apiKey: "secret",
      baseURL: "https://api.onlysq.ru/ai/openai",
      model: "unused",
      modelContextSize: 128000,
    });

    await client.fetchModels(async (input: string | URL | Request) => {
      calls.push(String(input));
      return new Response(JSON.stringify({ data: [{ id: "onlysq/devstral", max_input_tokens: 512000 }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    expect(calls).toEqual(["https://api.onlysq.ru/ai/models"]);
  });
});

describe("provider metadata helpers", () => {
  test("infers known presets from base URLs", () => {
    expect(inferProviderPreset("https://integrate.api.nvidia.com/v1", "openai-compatible")).toBe("nvidia-nim");
    expect(inferProviderPreset("https://api.blackbox.ai", "openai-compatible")).toBe("blackbox");
  });

  test("extracts context windows from nested metadata and tags", () => {
    expect(
      extractContextWindowFromMetadata({
        metadata: {
          limits: {
            max_context_window: "512k",
          },
        },
      }),
    ).toBe(512000);
    expect(extractContextWindowFromMetadata({ tags: ["thinking", "context 128k"] })).toBe(128000);
  });

  test("resolves codex mode variants and exposes known limits", () => {
    expect(resolveCodexModelForMode("gpt-5.1-codex-max", "fast")).toBe("gpt-5.1-codex-mini");
    expect(resolveCodexModelForMode("gpt-5.1-codex-mini", "reasoning")).toBe("gpt-5.1-codex-max");
    expect(inferCodexMode("gpt-5.1-codex-mini")).toBe("fast");
    expect(inferCodexMode("gpt-5.1-codex-max")).toBe("reasoning");
    expect(findKnownModelInfo("gpt-5.1-codex-max")?.usageLimitsNote).toContain("5h");
  });
});
