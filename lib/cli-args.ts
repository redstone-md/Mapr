import { z } from "zod";

import { providerTypeSchema } from "./provider";

const rawCliArgsSchema = z.object({
  help: z.boolean().default(false),
  version: z.boolean().default(false),
  headless: z.boolean().default(false),
  reconfigure: z.boolean().default(false),
  listModels: z.boolean().default(false),
  localRag: z.boolean().default(false),
  verboseAgents: z.boolean().default(false),
  url: z.string().url().optional(),
  output: z.string().min(1).optional(),
  providerType: providerTypeSchema.optional(),
  providerName: z.string().min(1).optional(),
  apiKey: z.string().min(1).optional(),
  baseURL: z.string().url().optional(),
  model: z.string().min(1).optional(),
  contextSize: z.number().int().positive().optional(),
  maxPages: z.number().int().positive().optional(),
  maxArtifacts: z.number().int().positive().optional(),
});

const cliConfigOverrideSchema = z
  .object({
    providerType: providerTypeSchema.optional(),
    providerName: z.string().min(1).optional(),
    apiKey: z.string().min(1).optional(),
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
  ["--provider-name", "providerName"],
  ["--api-key", "apiKey"],
  ["--base-url", "baseURL"],
  ["--model", "model"],
  ["--context-size", "contextSize"],
  ["--max-pages", "maxPages"],
  ["--max-artifacts", "maxArtifacts"],
]);

const booleanKeys = new Set<keyof CliArgs>(["help", "version", "headless", "reconfigure", "listModels", "localRag", "verboseAgents"]);
const numberKeys = new Set<keyof CliArgs>(["contextSize", "maxPages", "maxArtifacts"]);

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
  if (args.providerName !== undefined) overrides.providerName = args.providerName;
  if (args.apiKey !== undefined) overrides.apiKey = args.apiKey;
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
    "",
    "Provider options:",
    "  --provider-type <type>          openai | openai-compatible",
    "  --provider-name <name>          Display name for the provider",
    "  --api-key <key>                 Provider API key",
    "  --base-url <url>                Base URL for the provider",
    "  --model <id>                    Model identifier",
    "  --context-size <tokens>         Model context window, for example 128000 or 512000",
    "  --list-models                   Fetch and print models using the resolved provider config",
    "  --local-rag                     Enable local lexical RAG for oversized artifacts",
    "  --reconfigure                   Force interactive provider reconfiguration",
    "",
    "Output and diagnostics:",
    "  --verbose-agents                Print agent swarm completion events",
    "  --help, -h                      Show help",
    "  --version, -v                   Show version",
  ].join("\n");
}
