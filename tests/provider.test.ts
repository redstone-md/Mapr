import { describe, expect, test } from "bun:test";

import { AiProviderClient } from "../lib/provider";

describe("AiProviderClient", () => {
  test("fetches model ids from an OpenAI-compatible models endpoint", async () => {
    const client = new AiProviderClient({
      providerType: "openai-compatible",
      providerName: "Local vLLM",
      apiKey: "secret",
      baseURL: "http://localhost:8000/v1",
      model: "unused",
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
});
