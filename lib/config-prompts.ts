import { select, text } from "@clack/prompts";
import { z } from "zod";

import { DEFAULT_CODEX_HOME_PATH } from "./codex-auth";
import { DEFAULT_MODEL_CONTEXT_SIZE } from "./provider";

type ExitIfCancelled = <T>(value: T) => T;

export async function promptForContextSize(defaultValue: number, exitIfCancelled: ExitIfCancelled): Promise<number> {
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

export async function promptForAuthMethod<T>(
  initialMethod: "api-key" | "codex-cli" | undefined,
  exitIfCancelled: ExitIfCancelled,
): Promise<"api-key" | "codex-cli"> {
  return exitIfCancelled(
    await select({
      message: "OpenAI auth method",
      initialValue: initialMethod ?? "api-key",
      options: [
        { value: "api-key", label: "API key", hint: "Use a standard OpenAI API key" },
        { value: "codex-cli", label: "Use existing Codex CLI auth", hint: "Reuse `codex login` browser sign-in" },
      ],
    }),
  ) as "api-key" | "codex-cli";
}

export async function promptForCodexMode(
  initialMode: "fast" | "reasoning" | undefined,
  exitIfCancelled: ExitIfCancelled,
): Promise<"fast" | "reasoning"> {
  return exitIfCancelled(
    await select({
      message: "Codex mode",
      initialValue: initialMode ?? "reasoning",
      options: [
        { value: "fast", label: "Fast", hint: "Prefer mini / lower-latency Codex variant" },
        { value: "reasoning", label: "Reasoning", hint: "Prefer max / deeper reasoning Codex variant" },
      ],
    }),
  ) as "fast" | "reasoning";
}

export async function promptForCodexHomePath(
  initialPath: string | undefined,
  exitIfCancelled: ExitIfCancelled,
): Promise<string> {
  return z.string().trim().min(1).parse(
    exitIfCancelled(
      await text({
        message: "Codex CLI home path",
        placeholder: DEFAULT_CODEX_HOME_PATH,
        initialValue: initialPath ?? DEFAULT_CODEX_HOME_PATH,
        validate(value) {
          const parsed = z.string().trim().min(1).safeParse(value);
          return parsed.success ? undefined : "Codex home path is required.";
        },
      }),
    ),
  );
}
