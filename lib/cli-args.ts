import { z } from "zod";

import { authMethodSchema, getProviderPreset, openAiModeSchema, providerPresetSchema, providerTypeSchema } from "./provider";

const rawCliArgsSchema = z.object({
  help: z.boolean().default(false),
  version: z.boolean().default(false),
  headless: z.boolean().default(false),
  reconfigure: z.boolean().default(false),
  listModels: z.boolean().default(false),
  localRag: z.boolean().optional(),
  verboseAgents: z.boolean().default(false),
  url: z.string().url().optional(),
  output: z.string().min(1).optional(),
  providerType: providerTypeSchema.optional(),
  providerPreset: providerPresetSchema.optional(),
  openAiMode: openAiModeSchema.optional(),
  authMethod: authMethodSchema.optional(),
  providerName: z.string().min(1).optional(),
  apiKey: z.string().min(1).optional(),
  codexHomePath: z.string().min(1).optional(),
  baseURL: z.string().url().optional(),
  model: z.string().min(1).optional(),
  contextSize: z.number().int().positive().optional(),
  analysisConcurrency: z.number().int().positive().optional(),
  maxPages: z.number().int().positive().optional(),
  maxArtifacts: z.number().int().positive().optional(),
  maxDepth: z.number().int().nonnegative().optional(),
});

const cliConfigOverrideSchema = z
  .object({
    providerType: providerTypeSchema.optional(),
    providerPreset: providerPresetSchema.optional(),
    openAiMode: openAiModeSchema.optional(),
    authMethod: authMethodSchema.optional(),
    providerName: z.string().min(1).optional(),
    apiKey: z.string().min(1).optional(),
    codexHomePath: z.string().min(1).optional(),
    baseURL: z.string().url().optional(),
    model: z.string().min(1).optional(),
    modelContextSize: z.number().int().positive().optional(),
  })
  .strict();

export type CliArgs = z.infer<typeof rawCliArgsSchema>;

const optionMap = new Map<string, keyof CliArgs>([
  ["--help", "help"],
  ["-h", "help"],
  ["--version", "version"],
  ["-v", "version"],
  ["--headless", "headless"],
  ["--reconfigure", "reconfigure"],
  ["--list-models", "listModels"],
  ["--local-rag", "localRag"],
  ["--verbose-agents", "verboseAgents"],
  ["--url", "url"],
  ["-u", "url"],
  ["--output", "output"],
  ["--provider-type", "providerType"],
  ["--provider-preset", "providerPreset"],
  ["--openai-mode", "openAiMode"],
  ["--auth-method", "authMethod"],
  ["--provider-name", "providerName"],
  ["--api-key", "apiKey"],
  ["--codex-home", "codexHomePath"],
  ["--base-url", "baseURL"],
  ["--model", "model"],
  ["--context-size", "contextSize"],
  ["--analysis-concurrency", "analysisConcurrency"],
  ["--max-pages", "maxPages"],
  ["--max-artifacts", "maxArtifacts"],
  ["--max-depth", "maxDepth"],
]);

const booleanFalseOptionMap = new Map<string, keyof CliArgs>([["--no-local-rag", "localRag"]]);
const booleanKeys = new Set<keyof CliArgs>(["help", "version", "headless", "reconfigure", "listModels", "localRag", "verboseAgents"]);
const numberKeys = new Set<keyof CliArgs>(["contextSize", "analysisConcurrency", "maxPages", "maxArtifacts", "maxDepth"]);

function normalizeValue(key: keyof CliArgs, value: string): unknown {
  if (numberKeys.has(key)) {
    return Number(value);
  }

  return value;
}

export function parseCliArgs(argv: string[]): CliArgs {
  const accumulator: Record<string, unknown> = {};

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token) {
      continue;
    }
    if (!token.startsWith("-")) {
      throw new Error(`Unexpected positional argument: ${token}`);
    }

    const [rawKey, rawInlineValue] = token.includes("=") ? token.split(/=(.*)/s, 2) : [token, undefined];
    const mappedKey = optionMap.get(rawKey);
    if (!mappedKey && !booleanFalseOptionMap.has(rawKey)) {
      throw new Error(`Unknown argument: ${rawKey}`);
    }

    if (booleanFalseOptionMap.has(rawKey)) {
      accumulator[booleanFalseOptionMap.get(rawKey)!] = false;
      continue;
    }

    if (!mappedKey) {
      throw new Error(`Unknown argument: ${rawKey}`);
    }

    if (booleanKeys.has(mappedKey)) {
      accumulator[mappedKey] = true;
      continue;
    }

    const value = rawInlineValue ?? argv[index + 1];
    if (!value || value.startsWith("-")) {
      throw new Error(`Argument ${rawKey} requires a value.`);
    }

    accumulator[mappedKey] = normalizeValue(mappedKey, value);
    if (rawInlineValue === undefined) {
      index += 1;
    }
  }

  return rawCliArgsSchema.parse(accumulator);
}

export function getConfigOverrides(args: CliArgs) {
  const overrides: Record<string, unknown> = {};

  if (args.providerType !== undefined) overrides.providerType = args.providerType;
  if (args.openAiMode !== undefined) overrides.openAiMode = args.openAiMode;
  if (args.authMethod !== undefined) overrides.authMethod = args.authMethod;
  if (args.providerPreset !== undefined) {
    const preset = getProviderPreset(args.providerPreset);
    overrides.providerType = "openai-compatible";
    overrides.providerPreset = args.providerPreset;
    overrides.providerName = args.providerName ?? preset.providerName;
    overrides.baseURL = args.baseURL ?? preset.baseURL;
  }
  if (args.providerName !== undefined) overrides.providerName = args.providerName;
  if (args.apiKey !== undefined) overrides.apiKey = args.apiKey;
  if (args.codexHomePath !== undefined) overrides.codexHomePath = args.codexHomePath;
  if (args.baseURL !== undefined) overrides.baseURL = args.baseURL;
  if (args.model !== undefined) overrides.model = args.model;
  if (args.contextSize !== undefined) overrides.modelContextSize = args.contextSize;

  return cliConfigOverrideSchema.parse(overrides);
}

export function renderHelpText(): string {
  return [
    "Mapr",
    "",
    "Usage:",
    "  mapr [options]",
    "",
    "Core options:",
    "  --url, -u <url>                 Target URL to analyze",
    "  --headless                      Disable prompts and require config from saved values or flags",
    "  --output <path>                 Write the report to a specific path",
    "  --max-pages <number>            Limit same-origin HTML pages to crawl",
    "  --max-artifacts <number>        Limit total downloaded artifacts",
    "  --max-depth <number>            Limit crawl hop depth from the entry page",
    "",
    "Provider options:",
    "  --provider-type <type>          openai | openai-compatible",
    "  --provider-preset <preset>      custom | blackbox | nvidia-nim | onlysq",
    "  --openai-mode <mode>            fast | reasoning",
    "  --auth-method <method>          api-key | codex-cli",
    "  --provider-name <name>          Display name for the provider",
    "  --api-key <key>                 Provider API key",
    "  --codex-home <path>             Path to the local Codex CLI home, defaults to ~/.codex",
    "  --base-url <url>                Base URL for the provider",
    "  --model <id>                    Model identifier",
    "  --context-size <tokens>         Model context window, for example 128000 or 512000",
    "  --analysis-concurrency <n>      Parallel chunk analyses per artifact",
    "  --list-models                   Fetch and print models using the resolved provider config",
    "  --local-rag                     Enable local lexical RAG for oversized artifacts",
    "  --no-local-rag                  Disable local lexical RAG explicitly",
    "  --reconfigure                   Force interactive provider reconfiguration",
    "",
    "Output and diagnostics:",
    "  --verbose-agents                Print agent swarm completion events",
    "  --help, -h                      Show help",
    "  --version, -v                   Show version",
  ].join("\n");
}
