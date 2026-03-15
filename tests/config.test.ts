import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";

import { ConfigManager, DEFAULT_MODEL, DEFAULT_MODEL_CONTEXT_SIZE } from "../lib/config";

const createdDirectories: string[] = [];

afterEach(async () => {
  while (createdDirectories.length > 0) {
    const directory = createdDirectories.pop();
    if (directory) {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

describe("ConfigManager", () => {
  test("creates a new provider config when none exists", async () => {
    const tempHome = await mkdtemp(join(tmpdir(), "mapr-config-"));
    createdDirectories.push(tempHome);

    const manager = new ConfigManager({
      homeDir: tempHome,
      promptConfig: async () => ({
        providerType: "openai-compatible",
        providerName: "Local vLLM",
        apiKey: "local-secret",
        baseURL: "http://localhost:8000/v1",
        model: "qwen2.5-coder",
        modelContextSize: 512000,
      }),
    });

    const config = await manager.ensureConfig();
    const savedConfig = JSON.parse(await readFile(manager.getConfigPath(), "utf8")) as {
      providerType: string;
      providerName: string;
      apiKey: string;
      baseURL: string;
      model: string;
      modelContextSize: number;
    };

    expect(config.providerType).toBe("openai-compatible");
    expect(config.providerName).toBe("Local vLLM");
    expect(config.baseURL).toBe("http://localhost:8000/v1");
    expect(config.model).toBe("qwen2.5-coder");
    expect(config.modelContextSize).toBe(512000);
    expect(savedConfig.providerType).toBe("openai-compatible");
    expect(savedConfig.model).toBe("qwen2.5-coder");
    expect(savedConfig.modelContextSize).toBe(512000);
  });

  test("reads and normalizes a legacy config without prompting", async () => {
    const tempHome = await mkdtemp(join(tmpdir(), "mapr-config-"));
    createdDirectories.push(tempHome);

    const manager = new ConfigManager({ homeDir: tempHome });
    await manager.saveConfig({
      providerType: "openai",
      providerName: "OpenAI",
      apiKey: "sk-existing-key",
      baseURL: "https://api.openai.com/v1",
      model: DEFAULT_MODEL,
      modelContextSize: DEFAULT_MODEL_CONTEXT_SIZE,
    });

    const reloadedConfig = await manager.ensureConfig();
    expect(reloadedConfig.providerType).toBe("openai");
    expect(reloadedConfig.providerName).toBe("OpenAI");
    expect(reloadedConfig.model).toBe(DEFAULT_MODEL);
    expect(reloadedConfig.modelContextSize).toBe(DEFAULT_MODEL_CONTEXT_SIZE);
  });

  test("migrates the old openAiApiKey field", async () => {
    const tempHome = await mkdtemp(join(tmpdir(), "mapr-config-"));
    createdDirectories.push(tempHome);

    const configPath = join(tempHome, ".mapr", "config.json");
    await mkdir(join(tempHome, ".mapr"), { recursive: true });
    await writeFile(
      configPath,
      JSON.stringify(
        {
          openAiApiKey: "sk-legacy-key",
          model: DEFAULT_MODEL,
          modelContextSize: DEFAULT_MODEL_CONTEXT_SIZE,
        },
        null,
        2,
      ),
    );

    const manager = new ConfigManager({ homeDir: tempHome });
    const config = await manager.ensureConfig();

    expect(config.providerType).toBe("openai");
    expect(config.providerName).toBe("OpenAI");
    expect(config.apiKey).toBe("sk-legacy-key");
    expect(config.baseURL).toBe("https://api.openai.com/v1");
    expect(config.modelContextSize).toBe(DEFAULT_MODEL_CONTEXT_SIZE);
  });

  test("resolves config headlessly from saved values and overrides", async () => {
    const tempHome = await mkdtemp(join(tmpdir(), "mapr-config-"));
    createdDirectories.push(tempHome);

    const manager = new ConfigManager({ homeDir: tempHome });
    await manager.saveConfig({
      providerType: "openai-compatible",
      providerName: "Local vLLM",
      apiKey: "secret",
      baseURL: "http://localhost:8000/v1",
      model: "qwen2.5-coder",
      modelContextSize: 128000,
    });

    const config = await manager.ensureConfig({
      headless: true,
      overrides: {
        model: "qwen2.5-coder-32b",
        modelContextSize: 512000,
      },
    });

    expect(config.model).toBe("qwen2.5-coder-32b");
    expect(config.modelContextSize).toBe(512000);
  });
});
