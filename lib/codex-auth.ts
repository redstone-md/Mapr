import { readFile, writeFile } from "fs/promises";
import { homedir } from "os";
import { join } from "path";
import { z } from "zod";

export const CODEX_REFRESH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const DEFAULT_CODEX_HOME_PATH = join(homedir(), ".codex");
export const DEFAULT_CHATGPT_CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex";
const DEFAULT_REFRESH_ENDPOINT = "https://auth.openai.com/oauth/token";
const TOKEN_REFRESH_LEEWAY_MS = 5 * 60 * 1000;

const codexTokenSchema = z
  .object({
    id_token: z.string().min(1),
    access_token: z.string().min(1),
    refresh_token: z.string().min(1),
    account_id: z.string().min(1).nullable().optional(),
  })
  .strict();

const codexAuthFileSchema = z
  .object({
    auth_mode: z.string().optional(),
    OPENAI_API_KEY: z.string().nullable().optional(),
    tokens: codexTokenSchema.optional(),
    last_refresh: z.string().min(1).optional(),
  })
  .strict();

const refreshResponseSchema = z
  .object({
    id_token: z.string().min(1).optional(),
    access_token: z.string().min(1).optional(),
    refresh_token: z.string().min(1).optional(),
  })
  .passthrough();

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
type HeaderLike = Headers | Array<[string, string]> | Record<string, string>;
type JsonRecord = Record<string, unknown>;

export interface CodexCliAuthState {
  accessToken: string;
  refreshToken: string;
  accountId: string;
  planType?: string;
  expiresAt?: number;
  idToken: string;
  authFilePath: string;
}

function parseJwtPayload(token: string): Record<string, unknown> {
  const payload = token.split(".")[1];
  if (!payload) {
    throw new Error("Codex token is malformed.");
  }

  const normalizedPayload = payload.replace(/-/g, "+").replace(/_/g, "/");
  const padding = normalizedPayload.length % 4 === 0 ? "" : "=".repeat(4 - (normalizedPayload.length % 4));
  const decoded = Buffer.from(`${normalizedPayload}${padding}`, "base64").toString("utf8");
  return z.record(z.string(), z.unknown()).parse(JSON.parse(decoded) as unknown);
}

function extractString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function extractAccountId(idToken: string, fallbackAccountId?: string): string | undefined {
  const payload = parseJwtPayload(idToken);
  const auth = z.record(z.string(), z.unknown()).safeParse(payload["https://api.openai.com/auth"]);
  if (auth.success) {
    return extractString(auth.data.chatgpt_account_id) ?? fallbackAccountId;
  }

  return fallbackAccountId;
}

function extractPlanType(idToken: string): string | undefined {
  const payload = parseJwtPayload(idToken);
  const auth = z.record(z.string(), z.unknown()).safeParse(payload["https://api.openai.com/auth"]);
  if (!auth.success) {
    return undefined;
  }

  return extractString(auth.data.chatgpt_plan_type)?.toLowerCase();
}

function extractExpiresAt(accessToken: string): number | undefined {
  const payload = parseJwtPayload(accessToken);
  const exp = payload.exp;
  return typeof exp === "number" && Number.isFinite(exp) ? exp * 1000 : undefined;
}

function mergeHeaders(input: HeaderLike | undefined, overrides: Record<string, string>): Headers {
  const headers = new Headers(input);
  for (const [key, value] of Object.entries(overrides)) {
    headers.set(key, value);
  }
  return headers;
}

function isJsonRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonRequest(headers: Headers): boolean {
  const contentType = headers.get("content-type");
  return contentType !== null && contentType.toLowerCase().includes("application/json");
}

function extractInstructionText(content: unknown): string | undefined {
  if (typeof content === "string") {
    const normalized = content.trim();
    return normalized.length > 0 ? normalized : undefined;
  }

  if (!Array.isArray(content)) {
    return undefined;
  }

  const segments = content
    .map((part) => {
      if (isJsonRecord(part) && typeof part.text === "string") {
        return part.text.trim();
      }

      return undefined;
    })
    .filter((segment): segment is string => typeof segment === "string" && segment.length > 0);

  if (segments.length === 0) {
    return undefined;
  }

  return segments.join("\n");
}

function rewriteCodexResponsesBody(bodyText: string): string {
  const parsed = JSON.parse(bodyText) as unknown;
  if (!isJsonRecord(parsed)) {
    return bodyText;
  }

  const hasInstructions = typeof parsed.instructions === "string" && parsed.instructions.trim().length > 0;
  if (hasInstructions || !Array.isArray(parsed.input)) {
    return bodyText;
  }

  const instructionSegments: string[] = [];
  const filteredInput = parsed.input.filter((entry) => {
    if (!isJsonRecord(entry)) {
      return true;
    }

    const role = typeof entry.role === "string" ? entry.role : undefined;
    if (role !== "system" && role !== "developer") {
      return true;
    }

    const instruction = extractInstructionText(entry.content);
    if (instruction !== undefined) {
      instructionSegments.push(instruction);
    }

    return false;
  });

  if (instructionSegments.length === 0) {
    return bodyText;
  }

  return JSON.stringify({
    ...parsed,
    instructions: instructionSegments.join("\n\n"),
    input: filteredInput,
  });
}

export class CodexCliAuthManager {
  private readonly codexHomePath: string;
  private readonly fetcher: FetchLike;
  private refreshPromise: Promise<CodexCliAuthState> | null = null;

  public constructor(options: { codexHomePath?: string; fetcher?: FetchLike } = {}) {
    this.codexHomePath = options.codexHomePath ?? DEFAULT_CODEX_HOME_PATH;
    this.fetcher = options.fetcher ?? fetch;
  }

  public getCodexHomePath(): string {
    return this.codexHomePath;
  }

  public getAuthFilePath(): string {
    return join(this.codexHomePath, "auth.json");
  }

  public async loadState(): Promise<CodexCliAuthState> {
    const raw = await readFile(this.getAuthFilePath(), "utf8");
    const parsed = codexAuthFileSchema.parse(JSON.parse(raw) as unknown);
    if (!parsed.tokens) {
      throw new Error(`Codex CLI auth was not found at ${this.getAuthFilePath()}. Run \`codex login\` first.`);
    }

    const accountId = extractAccountId(parsed.tokens.id_token, parsed.tokens.account_id ?? undefined);
    if (!accountId) {
      throw new Error("Codex CLI auth is missing a ChatGPT account identifier.");
    }

    return {
      accessToken: parsed.tokens.access_token,
      refreshToken: parsed.tokens.refresh_token,
      accountId,
      ...(extractPlanType(parsed.tokens.id_token) !== undefined
        ? { planType: extractPlanType(parsed.tokens.id_token)! }
        : {}),
      ...(extractExpiresAt(parsed.tokens.access_token) !== undefined
        ? { expiresAt: extractExpiresAt(parsed.tokens.access_token)! }
        : {}),
      idToken: parsed.tokens.id_token,
      authFilePath: this.getAuthFilePath(),
    };
  }

  public async ensureFreshState(): Promise<CodexCliAuthState> {
    const state = await this.loadState();
    if (!this.shouldRefresh(state)) {
      return state;
    }

    return this.refreshState();
  }

  public async buildAuthHeaders(): Promise<Record<string, string>> {
    const state = await this.ensureFreshState();
    return {
      Authorization: `Bearer ${state.accessToken}`,
      "ChatGPT-Account-Id": state.accountId,
      Accept: "application/json",
    };
  }

  public createAuthenticatedFetch(baseFetch: FetchLike = this.fetcher): FetchLike {
    return async (input, init) => {
      const sourceRequest = input instanceof Request ? input : new Request(String(input), init);
      const requestBody =
        sourceRequest.method === "GET" || sourceRequest.method === "HEAD"
          ? undefined
          : await sourceRequest.clone().arrayBuffer();
      const execute = async (forceRefresh = false): Promise<Response> => {
        const state = forceRefresh ? await this.refreshState() : await this.ensureFreshState();
        const headers = mergeHeaders(sourceRequest.headers, {
          Authorization: `Bearer ${state.accessToken}`,
          "ChatGPT-Account-Id": state.accountId,
        });
        const requestUrl = new URL(sourceRequest.url);
        const isCodexResponsesRequest = requestUrl.pathname.endsWith("/responses");
        const transformedBody =
          requestBody !== undefined && isCodexResponsesRequest && isJsonRequest(headers)
            ? rewriteCodexResponsesBody(new TextDecoder().decode(requestBody))
            : requestBody;
        const request = new Request(sourceRequest, {
          headers,
          ...(typeof transformedBody === "string"
            ? { body: transformedBody }
            : transformedBody !== undefined
              ? { body: transformedBody.slice(0) }
              : {}),
        });

        const response = await baseFetch(request);

        if (response.status !== 401 || forceRefresh) {
          return response;
        }

        return execute(true);
      };

      return execute(false);
    };
  }

  public async refreshState(): Promise<CodexCliAuthState> {
    if (!this.refreshPromise) {
      this.refreshPromise = this.refreshStateInternal().finally(() => {
        this.refreshPromise = null;
      });
    }

    return this.refreshPromise;
  }

  private shouldRefresh(state: CodexCliAuthState): boolean {
    return state.expiresAt !== undefined && state.expiresAt - Date.now() <= TOKEN_REFRESH_LEEWAY_MS;
  }

  private async refreshStateInternal(): Promise<CodexCliAuthState> {
    const current = await this.loadState();
    const response = await this.fetcher(DEFAULT_REFRESH_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        client_id: CODEX_REFRESH_CLIENT_ID,
        grant_type: "refresh_token",
        refresh_token: current.refreshToken,
      }),
    });

    const bodyText = await response.text();
    if (!response.ok) {
      let message = bodyText.trim();
      try {
        const parsedError = z.record(z.string(), z.unknown()).parse(JSON.parse(bodyText) as unknown);
        const nestedError = parsedError.error;
        if (typeof nestedError === "string") {
          message = nestedError;
        } else if (nestedError && typeof nestedError === "object" && "message" in nestedError) {
          message = extractString((nestedError as Record<string, unknown>).message) ?? message;
        }
      } catch {
        // Keep the raw response body when the backend did not return JSON.
      }

      throw new Error(`Codex CLI auth refresh failed: ${response.status} ${message || response.statusText}`);
    }

    const refresh = refreshResponseSchema.parse(JSON.parse(bodyText) as unknown);
    const nextIdToken = refresh.id_token ?? current.idToken;
    const nextAccessToken = refresh.access_token ?? current.accessToken;
    const nextRefreshToken = refresh.refresh_token ?? current.refreshToken;
    const nextAccountId = extractAccountId(nextIdToken, current.accountId);
    if (!nextAccountId) {
      throw new Error("Codex CLI auth refresh returned a token without a ChatGPT account identifier.");
    }

    const persisted = {
      auth_mode: "chatgpt",
      OPENAI_API_KEY: null,
      tokens: {
        id_token: nextIdToken,
        access_token: nextAccessToken,
        refresh_token: nextRefreshToken,
        account_id: nextAccountId,
      },
      last_refresh: new Date().toISOString(),
    };

    await writeFile(this.getAuthFilePath(), `${JSON.stringify(persisted, null, 2)}\n`, "utf8");

    return {
      accessToken: nextAccessToken,
      refreshToken: nextRefreshToken,
      accountId: nextAccountId,
      ...(extractPlanType(nextIdToken) !== undefined ? { planType: extractPlanType(nextIdToken)! } : {}),
      ...(extractExpiresAt(nextAccessToken) !== undefined ? { expiresAt: extractExpiresAt(nextAccessToken)! } : {}),
      idToken: nextIdToken,
      authFilePath: this.getAuthFilePath(),
    };
  }
}
