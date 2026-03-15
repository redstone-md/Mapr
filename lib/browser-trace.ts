import { z } from "zod";
import type { Browser, BrowserContext, ConsoleMessage, Frame, Response as PlaywrightResponse, Route } from "playwright";

import { DomSnapshotBuilder, domPageSnapshotSchema } from "./dom-snapshot";

const browserRequestSchema = z.object({
  url: z.string().url(),
  method: z.string().min(1),
  resourceType: z.string().min(1),
  status: z.number().int().min(0).optional(),
  frameUrl: z.string().url().optional(),
  requestBodySnippet: z.string().optional(),
  responseBodySnippet: z.string().optional(),
  contentType: z.string().optional(),
});

const browserConsoleMessageSchema = z.object({
  type: z.string().min(1),
  text: z.string().min(1),
});

const browserStorageSnapshotSchema = z.object({
  localStorageKeys: z.array(z.string().min(1)).default([]),
  sessionStorageKeys: z.array(z.string().min(1)).default([]),
  cookieNames: z.array(z.string().min(1)).default([]),
  interestingGlobals: z.array(z.string().min(1)).default([]),
});

const browserRuntimeSignalsSchema = z.object({
  captchaProviders: z.array(z.string().min(1)).default([]),
  authRequestUrls: z.array(z.string().url()).default([]),
  challengeRequestUrls: z.array(z.string().url()).default([]),
  fingerprintingRequestUrls: z.array(z.string().url()).default([]),
  encryptionHints: z.array(z.string().min(1)).default([]),
});

export const browserTraceSchema = z.object({
  status: z.enum(["captured", "disabled", "unavailable", "failed"]),
  mode: z.literal("playwright"),
  finalUrl: z.string().url().optional(),
  domSnapshot: domPageSnapshotSchema.optional(),
  frameUrls: z.array(z.string().url()).default([]),
  requests: z.array(browserRequestSchema).default([]),
  consoleMessages: z.array(browserConsoleMessageSchema).default([]),
  pageErrors: z.array(z.string().min(1)).default([]),
  storage: browserStorageSnapshotSchema.default({
    localStorageKeys: [],
    sessionStorageKeys: [],
    cookieNames: [],
    interestingGlobals: [],
  }),
  runtimeSignals: browserRuntimeSignalsSchema.default({
    captchaProviders: [],
    authRequestUrls: [],
    challengeRequestUrls: [],
    fingerprintingRequestUrls: [],
    encryptionHints: [],
  }),
  notes: z.array(z.string().min(1)).default([]),
  error: z.string().optional(),
});

export type BrowserTrace = z.infer<typeof browserTraceSchema>;

export interface BrowserTraceOptions {
  enabled?: boolean;
  timeoutMs?: number;
  onProgress?: (message: string) => void;
}

type PlaywrightModule = typeof import("playwright");
type StorageProbeResult = {
  localStorageKeys: string[];
  sessionStorageKeys: string[];
  interestingGlobals: string[];
};
const DEFAULT_TRACE_TIMEOUT_MS = 8_000;
const MAX_SNIPPET_BODY_BYTES = 32_000;
const RESPONSE_SNIPPET_TIMEOUT_MS = 400;

function clip(value: string | null | undefined, maxLength = 300): string | undefined {
  if (!value) {
    return undefined;
  }

  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length === 0) {
    return undefined;
  }

  return normalized.length > maxLength ? `${normalized.slice(0, maxLength)}…` : normalized;
}

function unique(items: string[]): string[] {
  return [...new Set(items.filter((item) => item.length > 0))];
}

function inferCaptchaProviders(text: string): string[] {
  const providers: string[] = [];
  if (/turnstile/i.test(text)) providers.push("Cloudflare Turnstile");
  if (/recaptcha/i.test(text)) providers.push("Google reCAPTCHA");
  if (/hcaptcha/i.test(text)) providers.push("hCaptcha");
  if (/geetest/i.test(text)) providers.push("GeeTest");
  if (/arkose|funcaptcha/i.test(text)) providers.push("Arkose Labs");
  return unique(providers);
}

function inferInterestingGlobals(globalKeys: string[]): string[] {
  return globalKeys.filter((key) => /(captcha|turnstile|grecaptcha|hcaptcha|geetest|arkose|fingerprint|device|crypto)/i.test(key)).slice(0, 20);
}

function inferRuntimeSignals(input: {
  pageText: string;
  requests: Array<z.infer<typeof browserRequestSchema>>;
  consoleMessages: Array<z.infer<typeof browserConsoleMessageSchema>>;
  pageErrors: string[];
  interestingGlobals: string[];
}): z.infer<typeof browserRuntimeSignalsSchema> {
  const combinedText = [input.pageText, ...input.consoleMessages.map((entry) => entry.text), ...input.pageErrors, ...input.interestingGlobals].join("\n");
  const authRequestUrls = input.requests
    .filter((request) => /(auth|login|signin|signup|session|token|password|verify|mfa|2fa|oauth)/i.test(`${request.url} ${request.requestBodySnippet ?? ""}`))
    .map((request) => request.url);
  const challengeRequestUrls = input.requests
    .filter((request) => /(captcha|challenge|risk|turnstile|recaptcha|hcaptcha|verify)/i.test(`${request.url} ${request.requestBodySnippet ?? ""}`))
    .map((request) => request.url);
  const fingerprintingRequestUrls = input.requests
    .filter((request) => /(device|fingerprint|telemetry|collect|track|risk|profile)/i.test(`${request.url} ${request.requestBodySnippet ?? ""}`))
    .map((request) => request.url);
  const encryptionHints = unique(
    [
      ...combinedText.match(/\b(?:crypto\.subtle\.\w+|AES|RSA|SHA-256|SHA-512|HMAC|PBKDF2|CryptoJS)\b/gi) ?? [],
    ].map((entry) => entry.trim()),
  ).slice(0, 20);

  return browserRuntimeSignalsSchema.parse({
    captchaProviders: inferCaptchaProviders(combinedText),
    authRequestUrls: unique(authRequestUrls).slice(0, 20),
    challengeRequestUrls: unique(challengeRequestUrls).slice(0, 20),
    fingerprintingRequestUrls: unique(fingerprintingRequestUrls).slice(0, 20),
    encryptionHints,
  });
}

async function safeResponseSnippet(response: Pick<PlaywrightResponse, "text" | "headers">): Promise<string | undefined> {
  try {
    const headers = await response.headers();
    const contentType = headers["content-type"] ?? headers["Content-Type"] ?? "";
    const contentLength = Number(headers["content-length"] ?? headers["Content-Length"] ?? "0");
    if (!/(json|text)/i.test(contentType) || (Number.isFinite(contentLength) && contentLength > MAX_SNIPPET_BODY_BYTES)) {
      return undefined;
    }

    const text = await Promise.race([
      response.text(),
      new Promise<string>((_, reject) => setTimeout(() => reject(new Error("response snippet timeout")), RESPONSE_SNIPPET_TIMEOUT_MS)),
    ]);
    return clip(text);
  } catch {
    return undefined;
  }
}

function toValidUrlOrUndefined(value: string | null | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  try {
    return new URL(value).toString();
  } catch {
    return undefined;
  }
}

function shouldCaptureResponseSnippet(response: PlaywrightResponse): boolean {
  const request = response.request();
  const resourceType = request.resourceType();
  if (resourceType !== "fetch" && resourceType !== "xhr") {
    return false;
  }

  return /(auth|login|signin|signup|session|token|password|verify|mfa|2fa|oauth|captcha|challenge|risk|telemetry|fingerprint|device|profile)/i.test(
    request.url(),
  );
}

export class BrowserAssistedTracer {
  private readonly enabled: boolean;
  private readonly timeoutMs: number;
  private readonly onProgress: ((message: string) => void) | undefined;
  private readonly domSnapshotBuilder = new DomSnapshotBuilder();

  public constructor(options: BrowserTraceOptions = {}) {
    this.enabled = options.enabled ?? false;
    this.timeoutMs = Math.max(1_000, options.timeoutMs ?? DEFAULT_TRACE_TIMEOUT_MS);
    this.onProgress = options.onProgress;
  }

  public async trace(targetUrl: string): Promise<BrowserTrace> {
    if (!this.enabled) {
      return browserTraceSchema.parse({
        status: "disabled",
        mode: "playwright",
        notes: ["Browser-assisted tracing was not enabled for this run."],
      });
    }

    let playwright: PlaywrightModule;
    try {
      playwright = await import("playwright");
    } catch {
      return browserTraceSchema.parse({
        status: "unavailable",
        mode: "playwright",
        notes: ["Playwright is not installed in this environment."],
        error: "Playwright dependency is unavailable.",
      });
    }

    const requests: Array<z.infer<typeof browserRequestSchema>> = [];
    const consoleMessages: Array<z.infer<typeof browserConsoleMessageSchema>> = [];
    const pageErrors: string[] = [];
    const frameUrls = new Set<string>();
    let finalUrl: string | undefined;
    let domSnapshot: BrowserTrace["domSnapshot"];
    let browser: Browser | undefined;
    let context: BrowserContext | undefined;
    let storage = browserStorageSnapshotSchema.parse({
      localStorageKeys: [],
      sessionStorageKeys: [],
      cookieNames: [],
      interestingGlobals: [],
    });

    try {
      this.onProgress?.("Launching Playwright Chromium");
      browser = await playwright.chromium.launch({ headless: true });
      context = await browser.newContext({ ignoreHTTPSErrors: true });
      await context.route("**/*", async (route: Route) => {
        const resourceType = route.request().resourceType();
        if (resourceType === "image" || resourceType === "media" || resourceType === "font" || resourceType === "stylesheet") {
          await route.abort();
          return;
        }

        await route.continue();
      });

      const page = await context.newPage();
      context.setDefaultNavigationTimeout(this.timeoutMs);
      page.on("console", (message: ConsoleMessage) => {
        try {
          const text = clip(message.text(), 240);
          if (!text) {
            return;
          }

          consoleMessages.push(
            browserConsoleMessageSchema.parse({
              type: message.type(),
              text,
            }),
          );
        } catch {
          return;
        }
      });
      page.on("pageerror", (error: Error) => {
        pageErrors.push(String(error));
      });
      page.on("framenavigated", (frame: Frame) => {
        try {
          const frameUrl = frame.url();
          if (frameUrl) {
            frameUrls.add(frameUrl);
          }
        } catch {
          return;
        }
      });
      page.on("response", async (response: PlaywrightResponse) => {
        try {
          if (requests.length >= 160) {
            return;
          }

          const request = response.request();
          const requestUrl = toValidUrlOrUndefined(request.url());
          if (!requestUrl) {
            return;
          }
          const frameUrl = toValidUrlOrUndefined(request.frame()?.url());
          const requestBodySnippet = clip(request.postData());
          const responseBodySnippet = shouldCaptureResponseSnippet(response) ? await safeResponseSnippet(response) : undefined;
          const contentType = response.headers()["content-type"];

          requests.push(
            browserRequestSchema.parse({
              url: requestUrl,
              method: request.method(),
              resourceType: request.resourceType(),
              status: response.status(),
              ...(frameUrl !== undefined ? { frameUrl } : {}),
              ...(requestBodySnippet !== undefined ? { requestBodySnippet } : {}),
              ...(responseBodySnippet !== undefined ? { responseBodySnippet } : {}),
              ...(contentType !== undefined ? { contentType } : {}),
            }),
          );
        } catch {
          return;
        }
      });

      this.onProgress?.("Navigating browser to target");
      await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: this.timeoutMs });
      await page.waitForTimeout(Math.min(1_200, Math.max(600, Math.floor(this.timeoutMs / 4))));
      finalUrl = page.url();
      const html = await page.content();
      domSnapshot = this.domSnapshotBuilder.build(html, finalUrl || targetUrl);
      const storageSnapshot = await page.evaluate<StorageProbeResult>(() => {
        const runtimeWindow = globalThis as Record<string, unknown> & {
          localStorage?: { length: number; key(index: number): string | null };
          sessionStorage?: { length: number; key(index: number): string | null };
        };
        const localStorageKeys = Array.from({ length: runtimeWindow.localStorage?.length ?? 0 }, (_, index) =>
          runtimeWindow.localStorage?.key(index),
        ).filter((value): value is string => typeof value === "string");
        const sessionStorageKeys = Array.from({ length: runtimeWindow.sessionStorage?.length ?? 0 }, (_, index) =>
          runtimeWindow.sessionStorage?.key(index),
        ).filter((value): value is string => typeof value === "string");
        const interestingGlobals = Object.keys(runtimeWindow).filter((key) =>
          /(captcha|turnstile|grecaptcha|hcaptcha|geetest|arkose|fingerprint|device|crypto)/i.test(key),
        );

        return {
          localStorageKeys,
          sessionStorageKeys,
          interestingGlobals,
        };
      });
      storage = browserStorageSnapshotSchema.parse({
        ...storageSnapshot,
        interestingGlobals: inferInterestingGlobals(storageSnapshot.interestingGlobals),
        cookieNames: (await context.cookies()).map((cookie: { name: string }) => cookie.name).slice(0, 40),
      });

      const runtimeSignals = inferRuntimeSignals({
        pageText: html,
        requests,
        consoleMessages,
        pageErrors,
        interestingGlobals: storage.interestingGlobals,
      });

      return browserTraceSchema.parse({
        status: "captured",
        mode: "playwright",
        ...(finalUrl !== undefined ? { finalUrl } : {}),
        ...(domSnapshot !== undefined ? { domSnapshot } : {}),
        frameUrls: unique([...frameUrls]).slice(0, 40),
        requests: requests.slice(0, 160),
        consoleMessages: consoleMessages.slice(0, 60),
        pageErrors: unique(pageErrors).slice(0, 20),
        storage,
        runtimeSignals,
        notes: [
          "Playwright trace captured post-hydration DOM and network activity.",
          "Image, font, and media requests were aborted to keep tracing focused on application behavior.",
        ],
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown browser trace error.";
      return browserTraceSchema.parse({
        status: "failed",
        mode: "playwright",
        ...(finalUrl !== undefined ? { finalUrl } : {}),
        ...(domSnapshot !== undefined ? { domSnapshot } : {}),
        frameUrls: unique([...frameUrls]).slice(0, 40),
        requests: requests.slice(0, 160),
        consoleMessages: consoleMessages.slice(0, 60),
        pageErrors: unique(pageErrors).slice(0, 20),
        storage,
        notes: ["Browser-assisted tracing failed and the static pipeline continued."],
        error: message,
      });
    } finally {
      await context?.close().catch(() => undefined);
      await browser?.close().catch(() => undefined);
    }
  }
}
