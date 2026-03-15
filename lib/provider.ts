import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { z } from "zod";

export const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";
export const DEFAULT_MODEL = "gpt-4.1-mini";
export const DEFAULT_MODEL_CONTEXT_SIZE = 128000;

export const providerTypeSchema = z.enum(["openai", "openai-compatible"]);
export const providerPresetSchema = z.enum(["custom", "blackbox", "nvidia-nim", "onlysq"]);

export interface ProviderPreset {
  id: z.infer<typeof providerPresetSchema>;
  label: string;
  providerName: string;
  baseURL: string;
  modelsEndpoint?: string;
}

export interface ProviderModelInfo {
  id: string;
  contextSize?: number;
}

const openAiCompatiblePresetDefinitions: ProviderPreset[] = [
  {
    id: "blackbox",
    label: "BlackBox AI",
    providerName: "BlackBox AI",
    baseURL: "https://api.blackbox.ai",
  },
  {
    id: "nvidia-nim",
    label: "Nvidia NIM",
    providerName: "Nvidia NIM",
    baseURL: "https://integrate.api.nvidia.com/v1",
  },
  {
    id: "onlysq",
    label: "OnlySQ",
    providerName: "OnlySQ",
    baseURL: "https://api.onlysq.ru/ai/openai",
    modelsEndpoint: "https://api.onlysq.ru/ai/models",
  },
];

const openAiCompatiblePresetMap = new Map(openAiCompatiblePresetDefinitions.map((preset) => [preset.id, preset]));

export const aiProviderConfigSchema = z.object({
  providerType: providerTypeSchema.default("openai"),
  providerPreset: providerPresetSchema.optional(),
  providerName: z.string().min(1).default("OpenAI"),
  apiKey: z.string().min(1, "API key is required."),
  baseURL: z.string().trim().url("Base URL must be a valid URL.").default(DEFAULT_OPENAI_BASE_URL),
  model: z.string().min(1).default(DEFAULT_MODEL),
  modelContextSize: z.number().int().positive().default(DEFAULT_MODEL_CONTEXT_SIZE),
});

export type AiProviderConfig = z.infer<typeof aiProviderConfigSchema>;

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
type JsonRecord = Record<string, unknown>;

const exactContextKeys = new Set([
  "context",
  "contextlength",
  "contextwindow",
  "contextsize",
  "maxcontext",
  "maxcontextlength",
  "maxcontextwindow",
  "maxcontextsize",
  "maxinputtokens",
  "inputtokenlimit",
  "maxinputtokenlimit",
  "maxmodellen",
  "maxsequencelength",
  "maxpositionembeddings",
  "tokenlimit",
  "nctx",
  "numctx",
]);

const tagCarrierKeys = new Set(["tags", "capabilities", "metadata", "limits", "details", "extra", "spec"]);

function isJsonRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeBaseUrl(baseURL: string): string {
  return new URL(baseURL).toString().replace(/\/$/, "");
}

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function parseTokenCount(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.trunc(value);
  }

  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }

  const compactMatch = normalized.match(/\b(\d+(?:\.\d+)?)\s*([km])\b/);
  if (compactMatch) {
    const multiplier = compactMatch[2] === "m" ? 1_000_000 : 1_000;
    return Math.round(Number(compactMatch[1]) * multiplier);
  }

  const plainMatch = normalized.match(/\b(\d{4,7})\b/);
  if (plainMatch) {
    return Number(plainMatch[1]);
  }

  return undefined;
}

function extractContextFromStringTag(value: string): number | undefined {
  const normalized = value.trim().toLowerCase();
  if (!/(context|window|input|token|ctx)/.test(normalized)) {
    return undefined;
  }

  return parseTokenCount(normalized);
}

function scoreContextKey(key: string): number {
  const normalizedKey = normalizeKey(key);
  if (exactContextKeys.has(normalizedKey)) {
    return 6;
  }

  if (normalizedKey.includes("context") || normalizedKey.includes("window")) {
    return 5;
  }

  if (normalizedKey.includes("input") && normalizedKey.includes("token")) {
    return 4;
  }

  if (normalizedKey.includes("token") || normalizedKey.includes("ctx")) {
    return 3;
  }

  return 0;
}

function collectContextCandidates(
  value: unknown,
  path: string[] = [],
  seen = new WeakSet<object>(),
): Array<{ score: number; value: number }> {
  const candidates: Array<{ score: number; value: number }> = [];

  if (typeof value === "string") {
    const parsed = extractContextFromStringTag(value);
    if (parsed !== undefined) {
      candidates.push({ score: 2, value: parsed });
    }
    return candidates;
  }

  if (Array.isArray(value)) {
    for (const entry of value) {
      candidates.push(...collectContextCandidates(entry, path, seen));
    }
    return candidates;
  }

  if (!isJsonRecord(value)) {
    return candidates;
  }

  if (seen.has(value)) {
    return candidates;
  }

  seen.add(value);

  for (const [key, nestedValue] of Object.entries(value)) {
    const score = scoreContextKey(key);
    if (score > 0) {
      const parsed = parseTokenCount(nestedValue);
      if (parsed !== undefined) {
        candidates.push({ score, value: parsed });
      }
    }

    if (typeof nestedValue === "string" && tagCarrierKeys.has(normalizeKey(key))) {
      const parsed = extractContextFromStringTag(nestedValue);
      if (parsed !== undefined) {
        candidates.push({ score: 2, value: parsed });
      }
    }

    if (Array.isArray(nestedValue) || isJsonRecord(nestedValue)) {
      candidates.push(...collectContextCandidates(nestedValue, [...path, key], seen));
    }
  }

  return candidates.filter((candidate) => candidate.value >= 1024 && candidate.value <= 10_000_000);
}

function extractModelEntries(payload: unknown): JsonRecord[] {
  if (Array.isArray(payload)) {
    return payload.filter(isJsonRecord);
  }

  if (!isJsonRecord(payload)) {
    return [];
  }

  for (const key of ["data", "models", "items", "results"]) {
    const candidate = payload[key];
    if (Array.isArray(candidate)) {
      return candidate.filter(isJsonRecord);
    }
  }

  return [];
}

function getModelId(entry: JsonRecord): string | undefined {
  const candidateKeys = ["id", "model", "name"];
  for (const key of candidateKeys) {
    const value = entry[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }

  return undefined;
}

function resolvePresetByBaseUrl(baseURL: string): ProviderPreset | undefined {
  const normalizedBaseURL = normalizeBaseUrl(baseURL);
  return openAiCompatiblePresetDefinitions.find((preset) => normalizeBaseUrl(preset.baseURL) === normalizedBaseURL);
}

function resolveModelCatalogEndpoint(config: AiProviderConfig): string {
  if (config.providerType !== "openai-compatible") {
    return new URL("models", `${normalizeBaseUrl(config.baseURL)}/`).toString();
  }

  const preset =
    config.providerPreset && config.providerPreset !== "custom"
      ? openAiCompatiblePresetMap.get(config.providerPreset)
      : resolvePresetByBaseUrl(config.baseURL);
  if (preset?.modelsEndpoint) {
    return preset.modelsEndpoint;
  }

  return new URL("models", `${normalizeBaseUrl(config.baseURL)}/`).toString();
}

export function getProviderPreset(presetId: z.infer<typeof providerPresetSchema>): ProviderPreset {
  if (presetId === "custom") {
    return {
      id: "custom",
      label: "Custom OpenAI-compatible",
      providerName: "Custom OpenAI-compatible",
      baseURL: DEFAULT_OPENAI_BASE_URL,
    };
  }

  const preset = openAiCompatiblePresetMap.get(presetId);
  if (!preset) {
    throw new Error(`Unknown provider preset: ${presetId}`);
  }

  return preset;
}

export function getOpenAiCompatibleProviderPresets(): ProviderPreset[] {
  return [
    getProviderPreset("custom"),
    ...openAiCompatiblePresetDefinitions.map((preset) => ({ ...preset })),
  ];
}

export function inferProviderPreset(baseURL: string, providerType: z.infer<typeof providerTypeSchema>): z.infer<typeof providerPresetSchema> | undefined {
  if (providerType !== "openai-compatible") {
    return undefined;
  }

  return resolvePresetByBaseUrl(baseURL)?.id;
}

export function extractContextWindowFromMetadata(value: unknown): number | undefined {
  const candidates = collectContextCandidates(value);
  if (candidates.length === 0) {
    return undefined;
  }

  return candidates
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }

      return right.value - left.value;
    })[0]?.value;
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
    const catalog = await this.fetchModelCatalog(fetcher);
    return catalog.map((entry) => entry.id);
  }

  public async fetchModelCatalog(fetcher: FetchLike = fetch): Promise<ProviderModelInfo[]> {
    const endpoint = resolveModelCatalogEndpoint(this.config);
    const response = await fetcher(endpoint, {
      headers: {
        Authorization: `Bearer ${this.config.apiKey}`,
        Accept: "application/json",
      },
    });

    if (!response.ok) {
      throw new Error(`Model discovery failed: ${response.status} ${response.statusText}`);
    }

    const payload = (await response.json()) as unknown;
    const catalog: ProviderModelInfo[] = extractModelEntries(payload)
      .map((entry): ProviderModelInfo | null => {
        const id = getModelId(entry);
        if (!id) {
          return null;
        }

        const contextSize = extractContextWindowFromMetadata(entry);
        return contextSize !== undefined ? { id, contextSize } : { id };
      })
      .filter((entry): entry is ProviderModelInfo => entry !== null);

    return [...new Map(catalog.map((entry) => [entry.id, entry])).values()].sort((left, right) =>
      left.id.localeCompare(right.id),
    );
  }
}
