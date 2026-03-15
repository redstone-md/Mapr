import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { z } from "zod";

export const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";
export const DEFAULT_MODEL = "gpt-4.1-mini";
export const DEFAULT_MODEL_CONTEXT_SIZE = 128000;

export const providerTypeSchema = z.enum(["openai", "openai-compatible"]);

export const aiProviderConfigSchema = z.object({
  providerType: providerTypeSchema.default("openai"),
  providerName: z.string().min(1).default("OpenAI"),
  apiKey: z.string().min(1, "API key is required."),
  baseURL: z.string().trim().url("Base URL must be a valid URL.").default(DEFAULT_OPENAI_BASE_URL),
  model: z.string().min(1).default(DEFAULT_MODEL),
  modelContextSize: z.number().int().positive().default(DEFAULT_MODEL_CONTEXT_SIZE),
});

const modelListResponseSchema = z.object({
  data: z.array(
    z.object({
      id: z.string().min(1),
      created: z.number().optional(),
      owned_by: z.string().optional(),
    }),
  ),
});

export type AiProviderConfig = z.infer<typeof aiProviderConfigSchema>;

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

function normalizeBaseUrl(baseURL: string): string {
  return new URL(baseURL).toString().replace(/\/$/, "");
}

export class AiProviderClient {
  private readonly config: AiProviderConfig;

  public constructor(config: AiProviderConfig) {
    this.config = aiProviderConfigSchema.parse(config);
  }

  public getConfig(): AiProviderConfig {
    return this.config;
  }

  public getModel(modelId = this.config.model) {
    if (this.config.providerType === "openai-compatible") {
      const provider = createOpenAICompatible({
        name: this.config.providerName,
        apiKey: this.config.apiKey,
        baseURL: this.config.baseURL,
      });

      return provider(modelId);
    }

    const provider = createOpenAI({
      apiKey: this.config.apiKey,
      baseURL: this.config.baseURL,
    });

    return provider(modelId);
  }

  public async fetchModels(fetcher: FetchLike = fetch): Promise<string[]> {
    const endpoint = new URL("models", `${normalizeBaseUrl(this.config.baseURL)}/`).toString();
    const response = await fetcher(endpoint, {
      headers: {
        Authorization: `Bearer ${this.config.apiKey}`,
      },
    });

    if (!response.ok) {
      throw new Error(`Model discovery failed: ${response.status} ${response.statusText}`);
    }

    const payload = modelListResponseSchema.parse((await response.json()) as unknown);
    return [...new Set(payload.data.map((entry) => entry.id).filter(Boolean))].sort((left, right) =>
      left.localeCompare(right),
    );
  }
}
