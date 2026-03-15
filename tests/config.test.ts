import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";

import { ConfigManager, DEFAULT_MODEL } from "../lib/config";

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
  test("creates a new config when none exists", async () => {
    const tempHome = await mkdtemp(join(tmpdir(), "mapr-config-"));
    createdDirectories.push(tempHome);

    const manager = new ConfigManager({
      homeDir: tempHome,
      promptApiKey: async () => "sk-test-key-that-is-long-enough-1234567890",
    });

    const config = await manager.ensureConfig();
    const savedConfig = JSON.parse(await readFile(manager.getConfigPath(), "utf8")) as {
      openAiApiKey: string;
      model: string;
    };

    expect(config.openAiApiKey).toBe("sk-test-key-that-is-long-enough-1234567890");
    expect(config.model).toBe(DEFAULT_MODEL);
    expect(savedConfig.openAiApiKey).toBe("sk-test-key-that-is-long-enough-1234567890");
    expect(savedConfig.model).toBe(DEFAULT_MODEL);
  });

  test("reads an existing config without prompting", async () => {
    const tempHome = await mkdtemp(join(tmpdir(), "mapr-config-"));
    createdDirectories.push(tempHome);

    const manager = new ConfigManager({ homeDir: tempHome });
    await manager.saveConfig({
      openAiApiKey: "sk-existing-key-that-is-long-enough-123456",
      model: "gpt-4.1-mini",
    });

    const reloadedManager = new ConfigManager({
      homeDir: tempHome,
      promptApiKey: async () => {
        throw new Error("prompt should not be called");
      },
    });

    const config = await reloadedManager.ensureConfig();
    expect(config.openAiApiKey).toBe("sk-existing-key-that-is-long-enough-123456");
    expect(config.model).toBe("gpt-4.1-mini");
  });
});
