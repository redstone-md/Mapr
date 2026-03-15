import { cancel, isCancel, password } from "@clack/prompts";
import { mkdir, readFile, writeFile } from "fs/promises";
import { homedir } from "os";
import { join } from "path";
import { z } from "zod";

export const DEFAULT_MODEL = "gpt-4.1-mini";

const configSchema = z.object({
  openAiApiKey: z.string().min(20, "OpenAI API key looks too short."),
  model: z.string().min(1).default(DEFAULT_MODEL),
});

const persistedConfigSchema = z
  .object({
    openAiApiKey: z.string().min(20).optional(),
    model: z.string().min(1).optional(),
  })
  .strict();

const configManagerOptionsSchema = z.object({
  homeDir: z.string().min(1).optional(),
  promptApiKey: z.function({ input: [], output: z.promise(z.string()) }).optional(),
});

export type AppConfig = z.infer<typeof configSchema>;
type PersistedConfig = z.infer<typeof persistedConfigSchema>;

type ConfigManagerOptions = z.input<typeof configManagerOptionsSchema>;

export class ConfigManager {
  private readonly homeDirectory: string;
  private readonly promptApiKeyOverride: (() => Promise<string>) | undefined;

  public constructor(options: ConfigManagerOptions = {}) {
    const parsedOptions = configManagerOptionsSchema.parse(options);
    this.homeDirectory = parsedOptions.homeDir ?? homedir();
    this.promptApiKeyOverride = parsedOptions.promptApiKey;
  }

  public getConfigDir(): string {
    return join(this.homeDirectory, ".mapr");
  }

  public getConfigPath(): string {
    return join(this.getConfigDir(), "config.json");
  }

  public async readConfig(): Promise<PersistedConfig | null> {
    try {
      const raw = await readFile(this.getConfigPath(), "utf8");
      const parsed = JSON.parse(raw) as unknown;
      return persistedConfigSchema.parse(parsed);
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
    const validatedConfig = configSchema.parse(config);
    await mkdir(this.getConfigDir(), { recursive: true });
    await writeFile(this.getConfigPath(), `${JSON.stringify(validatedConfig, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
  }

  public async ensureConfig(): Promise<AppConfig> {
    const existingConfig = await this.readConfig();
    const openAiApiKey = existingConfig?.openAiApiKey ?? (await this.promptForApiKey());
    const config = configSchema.parse({
      openAiApiKey,
      model: existingConfig?.model ?? DEFAULT_MODEL,
    });

    await this.saveConfig(config);
    return config;
  }

  private async promptForApiKey(): Promise<string> {
    if (this.promptApiKeyOverride) {
      return configSchema.shape.openAiApiKey.parse(await this.promptApiKeyOverride());
    }

    const apiKey = await password({
      message: "Enter your OpenAI API key",
      mask: "*",
      validate(value) {
        const parsed = configSchema.shape.openAiApiKey.safeParse(value);
        if (!parsed.success) {
          return parsed.error.issues[0]?.message ?? "OpenAI API key is required.";
        }

        return undefined;
      },
    });

    if (isCancel(apiKey)) {
      cancel("Configuration cancelled.");
      process.exit(0);
    }

    return configSchema.shape.openAiApiKey.parse(apiKey);
  }
}
