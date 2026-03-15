import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";

import { CodexCliAuthManager } from "../lib/codex-auth";

const createdDirectories: string[] = [];

afterEach(async () => {
  while (createdDirectories.length > 0) {
    const directory = createdDirectories.pop();
    if (directory) {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

describe("CodexCliAuthManager", () => {
  test("loads local Codex CLI auth state", async () => {
    const codexHome = await mkdtemp(join(tmpdir(), "mapr-codex-auth-"));
    createdDirectories.push(codexHome);
    await mkdir(codexHome, { recursive: true });
    await writeFile(
      join(codexHome, "auth.json"),
      JSON.stringify(
        {
          auth_mode: "chatgpt",
          OPENAI_API_KEY: null,
          tokens: {
            id_token:
              "eyJhbGciOiJIUzI1NiJ9.eyJodHRwczovL2FwaS5vcGVuYWkuY29tL2F1dGgiOnsiY2hhdGdwdF9hY2NvdW50X2lkIjoib3JnX3Rlc3QiLCJjaGF0Z3B0X3BsYW5fdHlwZSI6InRlYW0ifX0.sig",
            access_token:
              "eyJhbGciOiJIUzI1NiJ9.eyJleHAiOjQxMDI0NDQ4MDAsImh0dHBzOi8vYXBpLm9wZW5haS5jb20vYXV0aCI6eyJjaGF0Z3B0X2FjY291bnRfaWQiOiJvcmdfdGVzdCJ9fQ.sig",
            refresh_token: "refresh-current",
            account_id: "org_test",
          },
          last_refresh: "2026-03-15T00:00:00.000Z",
        },
        null,
        2,
      ),
    );

    const manager = new CodexCliAuthManager({ codexHomePath: codexHome });
    const state = await manager.loadState();

    expect(state.accountId).toBe("org_test");
    expect(state.planType).toBe("team");
    expect(state.accessToken).toContain(".");
  });

  test("refreshes expired auth and retries a 401 request once", async () => {
    const codexHome = await mkdtemp(join(tmpdir(), "mapr-codex-refresh-"));
    createdDirectories.push(codexHome);
    await mkdir(codexHome, { recursive: true });
    await writeFile(
      join(codexHome, "auth.json"),
      JSON.stringify(
        {
          auth_mode: "chatgpt",
          OPENAI_API_KEY: null,
          tokens: {
            id_token:
              "eyJhbGciOiJIUzI1NiJ9.eyJodHRwczovL2FwaS5vcGVuYWkuY29tL2F1dGgiOnsiY2hhdGdwdF9hY2NvdW50X2lkIjoib3JnX3Rlc3QiLCJjaGF0Z3B0X3BsYW5fdHlwZSI6InRlYW0ifX0.sig",
            access_token:
              "eyJhbGciOiJIUzI1NiJ9.eyJleHAiOjEwLCJodHRwczovL2FwaS5vcGVuYWkuY29tL2F1dGgiOnsiY2hhdGdwdF9hY2NvdW50X2lkIjoib3JnX3Rlc3QifX0.sig",
            refresh_token: "refresh-old",
            account_id: "org_test",
          },
          last_refresh: "2026-03-15T00:00:00.000Z",
        },
        null,
        2,
      ),
    );

    const calls: string[] = [];
    const manager = new CodexCliAuthManager({
      codexHomePath: codexHome,
      fetcher: async (input: string | URL | Request) => {
        const url = String(input);
        calls.push(url);
        if (url === "https://auth.openai.com/oauth/token") {
          return new Response(
            JSON.stringify({
              id_token:
                "eyJhbGciOiJIUzI1NiJ9.eyJodHRwczovL2FwaS5vcGVuYWkuY29tL2F1dGgiOnsiY2hhdGdwdF9hY2NvdW50X2lkIjoib3JnX3Rlc3QiLCJjaGF0Z3B0X3BsYW5fdHlwZSI6InRlYW0ifX0.sig",
              access_token:
                "eyJhbGciOiJIUzI1NiJ9.eyJleHAiOjQxMDI0NDQ4MDAsImh0dHBzOi8vYXBpLm9wZW5haS5jb20vYXV0aCI6eyJjaGF0Z3B0X2FjY291bnRfaWQiOiJvcmdfdGVzdCJ9fQ.sig",
              refresh_token: "refresh-new",
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }

        return new Response("ok", { status: 200 });
      },
    });

    const authenticatedFetch = manager.createAuthenticatedFetch(async (input: string | URL | Request) => {
      calls.push(`request:${String(input)}`);
      if (calls.filter((entry) => entry.startsWith("request:")).length === 1) {
        return new Response("unauthorized", { status: 401 });
      }

      return new Response("ok", { status: 200 });
    });

    const response = await authenticatedFetch("https://chatgpt.com/backend-api/codex/responses", {
      method: "POST",
    });
    const persisted = JSON.parse(await readFile(join(codexHome, "auth.json"), "utf8")) as {
      tokens: { refresh_token: string; access_token: string };
    };

    expect(response.status).toBe(200);
    expect(calls).toContain("https://auth.openai.com/oauth/token");
    expect(persisted.tokens.refresh_token).toBe("refresh-new");
    expect(persisted.tokens.access_token).toContain("QxMDI0NDQ4MD");
  });
});
