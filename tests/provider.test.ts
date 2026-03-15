import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";

import {
  AiProviderClient,
  extractContextWindowFromMetadata,
  findKnownModelInfo,
  inferCodexMode,
  inferProviderPreset,
  resolveCodexModelForMode,
  supportsOpenAiMode,
} from "../lib/provider";

const createdDirectories: string[] = [];

afterEach(async () => {
  while (createdDirectories.length > 0) {
    const directory = createdDirectories.pop();
    if (directory) {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

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

  test("uses Codex CLI auth against the ChatGPT Codex models endpoint", async () => {
    const codexHome = await mkdtemp(join(tmpdir(), "mapr-provider-codex-"));
    createdDirectories.push(codexHome);
    await mkdir(codexHome, { recursive: true });
    await writeFile(
      join(codexHome, "auth.json"),
      JSON.stringify(
        {
          auth_mode: "chatgpt",
          OPENAI_API_KEY: null,
          tokens: {
            id_token:
              "eyJhbGciOiJIUzI1NiJ9.eyJodHRwczovL2FwaS5vcGVuYWkuY29tL2F1dGgiOnsiY2hhdGdwdF9hY2NvdW50X2lkIjoib3JnX3Rlc3QiLCJjaGF0Z3B0X3BsYW5fdHlwZSI6InRlYW0ifX0.sig",
            access_token:
              "eyJhbGciOiJIUzI1NiJ9.eyJleHAiOjQxMDI0NDQ4MDAsImh0dHBzOi8vYXBpLm9wZW5haS5jb20vYXV0aCI6eyJjaGF0Z3B0X2FjY291bnRfaWQiOiJvcmdfdGVzdCJ9fQ.sig",
            refresh_token: "refresh-current",
            account_id: "org_test",
          },
          last_refresh: "2026-03-15T00:00:00.000Z",
        },
        null,
        2,
      ),
    );

    const client = new AiProviderClient({
      providerType: "openai",
      authMethod: "codex-cli",
      providerName: "OpenAI",
      codexHomePath: codexHome,
      baseURL: "https://chatgpt.com/backend-api/codex",
      model: "gpt-5.4",
      modelContextSize: 272000,
    });

    const calls: Array<{ url: string; headers: Headers }> = [];
    const catalog = await client.fetchModelCatalog(async (input: string | URL | Request, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(String(input), init);
      calls.push({
        url: request.url,
        headers: new Headers(request.headers),
      });

      if (request.url.startsWith("https://auth.openai.com/oauth/token")) {
        return new Response(
          JSON.stringify({
            id_token:
              "eyJhbGciOiJIUzI1NiJ9.eyJodHRwczovL2FwaS5vcGVuYWkuY29tL2F1dGgiOnsiY2hhdGdwdF9hY2NvdW50X2lkIjoib3JnX3Rlc3QiLCJjaGF0Z3B0X3BsYW5fdHlwZSI6InRlYW0ifSwiZXhwIjo0MTAyNDQ0ODAwfQ.sig",
            access_token:
              "eyJhbGciOiJIUzI1NiJ9.eyJleHAiOjQxMDI0NDQ4MDAsImh0dHBzOi8vYXBpLm9wZW5haS5jb20vYXV0aCI6eyJjaGF0Z3B0X2FjY291bnRfaWQiOiJvcmdfdGVzdCJ9fQ.sig",
            refresh_token: "refresh-new",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      return new Response(
        JSON.stringify({
          models: [
            { slug: "gpt-5.4", display_name: "gpt-5.4", context_window: 272000 },
            { slug: "gpt-5.1-codex-mini", display_name: "gpt-5.1-codex-mini", context_window: 272000 },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    expect(calls[0]?.url).toContain("https://chatgpt.com/backend-api/codex/models?client_version=");
    expect(calls[0]?.headers.get("authorization")).toMatch(/^Bearer /);
    expect(calls[0]?.headers.get("chatgpt-account-id")).toBe("org_test");
    expect(catalog).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "gpt-5.1-codex-mini", contextSize: 272000 }),
        expect.objectContaining({ id: "gpt-5.4", contextSize: 272000 }),
      ]),
    );
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

  test("supports generic openai mode for gpt-5.4 and exposes reasoning effort", () => {
    const client = new AiProviderClient({
      providerType: "openai",
      providerName: "OpenAI",
      openAiMode: "fast",
      apiKey: "secret",
      baseURL: "https://api.openai.com/v1",
      model: "gpt-5.4",
      modelContextSize: 128000,
    });

    expect(supportsOpenAiMode("gpt-5.4")).toBe(true);
    expect(client.getProviderOptions()).toEqual({
      openai: {
        store: false,
        reasoningEffort: "low",
      },
    });
  });
});
