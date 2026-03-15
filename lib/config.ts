import { cancel, isCancel, password, select, text } from "@clack/prompts";
import { mkdir, readFile, writeFile } from "fs/promises";
import { homedir } from "os";
import { join } from "path";
import { z } from "zod";

import {
  AiProviderClient,
  DEFAULT_MODEL,
  DEFAULT_MODEL_CONTEXT_SIZE,
  DEFAULT_OPENAI_BASE_URL,
  aiProviderConfigSchema,
  type AiProviderConfig,
} from "./provider";

const persistedConfigSchema = z
  .object({
    providerType: z.enum(["openai", "openai-compatible"]).optional(),
    providerName: z.string().min(1).optional(),
    apiKey: z.string().min(1).optional(),
    openAiApiKey: z.string().min(1).optional(),
    baseURL: z.string().url().optional(),
    model: z.string().min(1).optional(),
    modelContextSize: z.number().int().positive().optional(),
  })
  .strict();

const configDraftSchema = aiProviderConfigSchema.partial();
const modelListingConfigSchema = z.object({
  providerType: z.enum(["openai", "openai-compatible"]).default("openai"),
  providerName: z.string().min(1).default("OpenAI"),
  apiKey: z.string().min(1),
  baseURL: z.string().trim().url().default(DEFAULT_OPENAI_BASE_URL),
});

type PersistedConfig = z.infer<typeof persistedConfigSchema>;
type ConfigDraft = z.infer<typeof configDraftSchema>;
type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface EnsureConfigOptions {
  forceReconfigure?: boolean;
  headless?: boolean;
  overrides?: ConfigDraft | null;
}

interface ConfigManagerOptions {
  homeDir?: string;
  fetcher?: FetchLike;
  promptConfig?: (existingConfig: ConfigDraft | null) => Promise<AiProviderConfig>;
}

function exitIfCancelled<T>(value: T): T {
  if (isCancel(value)) {
    cancel("Configuration cancelled.");
    process.exit(0);
  }

  return value;
}

function mergeConfigDrafts(baseConfig: ConfigDraft | null, overrides: ConfigDraft | null): ConfigDraft | null {
  if (!baseConfig && !overrides) {
    return null;
  }

  const merged: ConfigDraft = {
    ...(baseConfig ?? {}),
    ...(overrides ?? {}),
  };

  return configDraftSchema.parse(merged);
}

function normalizePersistedConfig(config: PersistedConfig | null): ConfigDraft | null {
  if (!config) {
    return null;
  }

  return configDraftSchema.parse({
    providerType: config.providerType ?? "openai",
    providerName: config.providerName ?? "OpenAI",
    apiKey: config.apiKey ?? config.openAiApiKey,
    baseURL: config.baseURL ?? DEFAULT_OPENAI_BASE_URL,
    model: config.model ?? DEFAULT_MODEL,
    modelContextSize: config.modelContextSize ?? DEFAULT_MODEL_CONTEXT_SIZE,
  });
}

async function promptForModel(config: Omit<AiProviderConfig, "model" | "modelContextSize">, fetcher: FetchLike): Promise<string> {
  const providerClient = new AiProviderClient({
    ...config,
    model: DEFAULT_MODEL,
    modelContextSize: DEFAULT_MODEL_CONTEXT_SIZE,
  });

  try {
    const models = await providerClient.fetchModels(fetcher);
    if (models.length === 0) {
      throw new Error("No models returned by the provider.");
    }

    let currentSearch = "";

    while (true) {
      const searchTerm = String(
        exitIfCancelled(
          await text({
            message: "Search models",
            placeholder: currentSearch || "gpt, llama, qwen, coder",
            initialValue: currentSearch,
          }),
        ),
      ).trim();

      currentSearch = searchTerm;
      const filteredModels = models.filter((model) =>
        searchTerm.length === 0 ? true : model.toLowerCase().includes(searchTerm.toLowerCase()),
      );
      const visibleModels = filteredModels.slice(0, 15);

      const selectedModel = exitIfCancelled(
        await select({
          message: "Select model",
          options: [
            ...visibleModels.map((model) => ({ value: model, label: model })),
            { value: "__search_again__", label: "Search again" },
            { value: "__manual__", label: "Enter model manually" },
          ],
        }),
      );

      if (selectedModel === "__search_again__") {
        continue;
      }

      if (selectedModel === "__manual__") {
        break;
      }

      return z.string().min(1).parse(selectedModel);
    }
  } catch {
    return z
      .string()
      .trim()
      .min(1, "Model is required.")
      .parse(
        exitIfCancelled(
          await text({
            message: "Enter model ID manually",
            placeholder: DEFAULT_MODEL,
            initialValue: DEFAULT_MODEL,
            validate(value) {
              const parsed = z.string().trim().min(1).safeParse(value);
              return parsed.success ? undefined : "Model is required.";
            },
          }),
        ),
      );
  }

  return z
    .string()
    .trim()
    .min(1, "Model is required.")
    .parse(
      exitIfCancelled(
        await text({
          message: "Enter model ID manually",
          placeholder: DEFAULT_MODEL,
          initialValue: DEFAULT_MODEL,
          validate(value) {
            const parsed = z.string().trim().min(1).safeParse(value);
            return parsed.success ? undefined : "Model is required.";
          },
        }),
      ),
    );
}

async function promptForContextSize(defaultValue: number): Promise<number> {
  const rawValue = exitIfCancelled(
    await text({
      message: "Model context size in tokens",
      placeholder: String(DEFAULT_MODEL_CONTEXT_SIZE),
      initialValue: String(defaultValue),
      validate(value) {
        const parsed = z.coerce.number().int().positive().safeParse(value);
        return parsed.success ? undefined : "Context size must be a positive integer.";
      },
    }),
  );

  return z.coerce.number().int().positive().parse(rawValue);
}

export type AppConfig = AiProviderConfig;
export { DEFAULT_MODEL, DEFAULT_MODEL_CONTEXT_SIZE } from "./provider";

export class ConfigManager {
  private readonly homeDirectory: string;
  private readonly fetcher: FetchLike;
  private readonly promptConfigOverride: ((existingConfig: ConfigDraft | null) => Promise<AiProviderConfig>) | undefined;

  public constructor(options: ConfigManagerOptions = {}) {
    this.homeDirectory = options.homeDir ?? homedir();
    this.fetcher = options.fetcher ?? fetch;
    this.promptConfigOverride = options.promptConfig;
  }

  public getConfigDir(): string {
    return join(this.homeDirectory, ".mapr");
  }

  public getConfigPath(): string {
    return join(this.getConfigDir(), "config.json");
  }

  public async readConfig(): Promise<ConfigDraft | null> {
    try {
      const raw = await readFile(this.getConfigPath(), "utf8");
      const parsed = persistedConfigSchema.parse(JSON.parse(raw) as unknown);
      return normalizePersistedConfig(parsed);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return null;
      }

      if (error instanceof z.ZodError) {
        throw new Error(`Invalid config file at ${this.getConfigPath()}: ${error.issues[0]?.message ?? "schema error"}`);
      }

      if (error instanceof SyntaxError) {
        throw new Error(`Config file at ${this.getConfigPath()} is not valid JSON.`);
      }

      throw error;
    }
  }

  public async saveConfig(config: AppConfig): Promise<void> {
    const validatedConfig = aiProviderConfigSchema.parse(config);
    await mkdir(this.getConfigDir(), { recursive: true });
    await writeFile(this.getConfigPath(), `${JSON.stringify(validatedConfig, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
  }

  public async ensureConfig(options: EnsureConfigOptions = {}): Promise<AppConfig> {
    const mergedDraft = await this.resolveConfigDraft(options.overrides ?? null);

    if (options.headless) {
      try {
        const resolvedConfig = aiProviderConfigSchema.parse(mergedDraft);
        await this.saveConfig(resolvedConfig);
        return resolvedConfig;
      } catch (error) {
        if (error instanceof z.ZodError) {
          throw new Error(`Headless mode requires a complete provider config: ${error.issues[0]?.message ?? "missing field"}`);
        }

        throw error;
      }
    }

    if (mergedDraft && !options.forceReconfigure) {
      const parsedConfig = aiProviderConfigSchema.safeParse(mergedDraft);
      if (parsedConfig.success) {
        await this.saveConfig(parsedConfig.data);
        return parsedConfig.data;
      }
    }

    const config = this.promptConfigOverride
      ? aiProviderConfigSchema.parse(await this.promptConfigOverride(mergedDraft))
      : await this.promptForConfig(mergedDraft);

    await this.saveConfig(config);
    return config;
  }

  public async listModels(config: ConfigDraft | null): Promise<string[]> {
    const resolvedConfig = modelListingConfigSchema.parse(config);
    const providerClient = new AiProviderClient({
      ...resolvedConfig,
      model: DEFAULT_MODEL,
      modelContextSize: DEFAULT_MODEL_CONTEXT_SIZE,
    });
    return providerClient.fetchModels(this.fetcher);
  }

  public async resolveConfigDraft(overrides: ConfigDraft | null): Promise<ConfigDraft | null> {
    const existingConfig = await this.readConfig();
    return mergeConfigDrafts(existingConfig, overrides);
  }

  private async promptForConfig(existingConfig: ConfigDraft | null): Promise<AppConfig> {
    const providerType = exitIfCancelled(
      await select({
        message: "Choose AI provider",
        initialValue: existingConfig?.providerType ?? "openai",
        options: [
          { value: "openai", label: "OpenAI" },
          { value: "openai-compatible", label: "OpenAI-compatible server" },
        ],
      }),
    ) as AiProviderConfig["providerType"];

    const providerName =
      providerType === "openai"
        ? "OpenAI"
        : z.string().trim().min(1).parse(
            exitIfCancelled(
              await text({
                message: "Provider display name",
                placeholder: "Local vLLM, LM Studio, Ollama gateway",
                initialValue: existingConfig?.providerName && existingConfig.providerType === "openai-compatible"
                  ? existingConfig.providerName
                  : "",
                validate(value) {
                  const parsed = z.string().trim().min(1).safeParse(value);
                  return parsed.success ? undefined : "Provider name is required.";
                },
              }),
            ),
          );

    const baseURL = z.string().trim().url().parse(
      exitIfCancelled(
        await text({
          message: providerType === "openai" ? "OpenAI base URL" : "OpenAI-compatible base URL",
          placeholder: DEFAULT_OPENAI_BASE_URL,
          initialValue:
            existingConfig?.baseURL && existingConfig.providerType === providerType
              ? existingConfig.baseURL
              : DEFAULT_OPENAI_BASE_URL,
          validate(value) {
            const parsed = z.string().trim().url().safeParse(value);
            return parsed.success ? undefined : "Base URL must be a valid URL.";
          },
        }),
      ),
    );

    const apiKey = z.string().trim().min(1).parse(
      exitIfCancelled(
        await password({
          message: providerType === "openai" ? "Enter your OpenAI API key" : "Enter your provider API key",
          mask: "*",
          validate(value) {
            const parsed = z.string().trim().min(1).safeParse(value);
            return parsed.success ? undefined : "API key is required.";
          },
        }),
      ),
    );

    const model = existingConfig?.model && existingConfig.providerType === providerType
      ? existingConfig.model
      : await promptForModel(
          {
            providerType,
            providerName,
            baseURL,
            apiKey,
          },
          this.fetcher,
        );

    const modelContextSize = await promptForContextSize(existingConfig?.modelContextSize ?? DEFAULT_MODEL_CONTEXT_SIZE);

    return aiProviderConfigSchema.parse({
      providerType,
      providerName,
      baseURL,
      apiKey,
      model,
      modelContextSize,
    });
  }
}
