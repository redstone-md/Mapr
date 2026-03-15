import type { BrowserTrace } from "./browser-trace";
import type { DomPageSnapshot } from "./dom-snapshot";
import type { FormattedArtifact } from "./formatter";
import type { ApiEndpoint, GraphQlEndpoint } from "./surface-analysis";
import {
  authFlowSchema,
  captchaFlowSchema,
  encryptionSignalSchema,
  fingerprintingSignalSchema,
  securityFindingSchema,
  type AuthFlow,
  type CaptchaFlow,
  type EncryptionSignal,
  type FingerprintingSignal,
  type SecurityFinding,
} from "./surface-analysis";

const authKeywordPattern = /\b(login|signin|signup|auth|oauth|session|token|password|mfa|2fa|verify|reset)\b/i;
const captchaProviderPatterns: Array<{ provider: string; pattern: RegExp }> = [
  { provider: "Cloudflare Turnstile", pattern: /\bturnstile\b/i },
  { provider: "Google reCAPTCHA", pattern: /\brecaptcha\b/i },
  { provider: "hCaptcha", pattern: /\bhcaptcha\b/i },
  { provider: "GeeTest", pattern: /\bgeetest\b/i },
  { provider: "Arkose Labs", pattern: /\barkose|funcaptcha\b/i },
  { provider: "Generic captcha", pattern: /\bcaptcha\b/i },
];
const fingerprintCollectors = [
  { label: "navigator fingerprinting", pattern: /navigator\.(userAgent|platform|languages|language|webdriver|hardwareConcurrency|deviceMemory)/gi },
  { label: "screen fingerprinting", pattern: /screen\.(width|height|availWidth|availHeight|colorDepth|pixelDepth)/gi },
  { label: "canvas fingerprinting", pattern: /(toDataURL|getImageData|measureText|canvas)/gi },
  { label: "webgl fingerprinting", pattern: /(WebGLRenderingContext|getParameter\(|WEBGL_debug_renderer_info)/gi },
  { label: "audio fingerprinting", pattern: /(AudioContext|OfflineAudioContext|AnalyserNode|createOscillator)/gi },
  { label: "timezone fingerprinting", pattern: /(Intl\.DateTimeFormat|resolvedOptions\(\)\.timeZone|getTimezoneOffset)/gi },
];
const encryptionPatterns = [
  /crypto\.subtle\.(encrypt|decrypt|digest|sign|verify|importKey|deriveBits|deriveKey)/gi,
  /\b(?:AES|RSA|SHA-1|SHA-256|SHA-384|SHA-512|HMAC|PBKDF2)\b/gi,
  /\b(?:CryptoJS|createCipheriv|createDecipheriv|btoa|atob)\b/gi,
];
const errorPattern = /["'`]([^"'`]*(?:invalid|expired|captcha|verify|unauthorized|forbidden|too many|rate limit|blocked|challenge)[^"'`]*)["'`]/gi;

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}

function hasMatch(pattern: RegExp, source: string): boolean {
  const cloned = new RegExp(pattern.source, pattern.flags);
  return cloned.test(source);
}

function takeMatches(pattern: RegExp, source: string, maxCount = 12): string[] {
  const cloned = new RegExp(pattern.source, pattern.flags);
  return [...source.matchAll(cloned)].map((match) => match[0] ?? "").filter(Boolean).slice(0, maxCount);
}

function clip(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 220);
}

function collectErrors(source: string): string[] {
  const cloned = new RegExp(errorPattern.source, errorPattern.flags);
  return [...source.matchAll(cloned)].map((match) => match[1] ?? "").filter(Boolean).slice(0, 12);
}

function inferTokenTouches(source: string): string[] {
  const touches = [];
  if (/\bcookie\b/i.test(source)) touches.push("cookie");
  if (/\blocalStorage\b/i.test(source)) touches.push("localStorage");
  if (/\bsessionStorage\b/i.test(source)) touches.push("sessionStorage");
  if (/\bindexedDB\b/i.test(source)) touches.push("indexedDB");
  if (/\bAuthorization\b/i.test(source)) touches.push("Authorization header");
  if (/\bBearer\b/i.test(source)) touches.push("Bearer token");
  return touches;
}

function buildAuthFlow(domSnapshots: DomPageSnapshot[], apiEndpoints: ApiEndpoint[], artifacts: FormattedArtifact[]): AuthFlow[] {
  const authForms = domSnapshots.filter(
    (snapshot) =>
      snapshot.forms.some((form) => form.inputTypes.some((type) => ["password", "email", "tel"].includes(type.toLowerCase()))) ||
      authKeywordPattern.test(`${snapshot.title} ${snapshot.headings.join(" ")}`),
  );

  if (authForms.length === 0 && apiEndpoints.every((endpoint) => !authKeywordPattern.test(endpoint.url))) {
    return [];
  }

  const authEndpoints = apiEndpoints.filter((endpoint) => authKeywordPattern.test(endpoint.url) || authKeywordPattern.test(endpoint.purpose));
  const authErrors = unique(
    artifacts.flatMap((artifact) => collectErrors(artifact.formattedContent || artifact.content)).filter((entry) => authKeywordPattern.test(entry) || /captcha/i.test(entry)),
  );
  const tokenTouches = unique(artifacts.flatMap((artifact) => inferTokenTouches(artifact.formattedContent || artifact.content)));

  const steps = authForms.flatMap((snapshot) =>
    snapshot.forms.map((form) => ({
      title: `${form.method} ${form.action}`,
      description: `Form submits ${form.inputNames.join(", ") || form.inputTypes.join(", ") || "credential fields"} from ${snapshot.url}.`,
      endpoints: [form.action, ...authEndpoints.slice(0, 4).map((endpoint) => endpoint.url)],
      evidence: [snapshot.summary, ...form.submitLabels.slice(0, 2)],
    })),
  );

  return [
    authFlowSchema.parse({
      title: "Primary authentication flow",
      triggers: unique(
        authForms.flatMap((snapshot) => [snapshot.title, ...snapshot.headings, ...snapshot.buttons]).filter((entry) => authKeywordPattern.test(entry)),
      ).slice(0, 10),
      steps,
      tokens: tokenTouches,
      errors: authErrors,
      evidence: unique([
        ...authForms.map((snapshot) => `${snapshot.url}: ${snapshot.summary}`),
        ...authEndpoints.slice(0, 8).map((endpoint) => `${endpoint.url} via ${endpoint.methods.join(",") || "unknown method"}`),
      ]),
    }),
  ];
}

function mergeRuntimeAuthFlow(flow: AuthFlow, browserTrace: BrowserTrace | undefined): AuthFlow {
  if (!browserTrace || browserTrace.status !== "captured") {
    return flow;
  }

  return authFlowSchema.parse({
    ...flow,
    steps: [
      ...flow.steps,
      ...(browserTrace.runtimeSignals.authRequestUrls.length > 0
        ? [
            {
              title: "Runtime network activity",
              description: "Browser-assisted tracing observed auth-like requests after hydration.",
              endpoints: browserTrace.runtimeSignals.authRequestUrls,
              evidence: browserTrace.consoleMessages.slice(0, 4).map((entry) => `${entry.type}: ${entry.text}`),
            },
          ]
        : []),
    ],
    tokens: unique([
      ...flow.tokens,
      ...browserTrace.storage.cookieNames.map((cookie) => `cookie:${cookie}`),
      ...browserTrace.storage.localStorageKeys.map((key) => `localStorage:${key}`),
      ...browserTrace.storage.sessionStorageKeys.map((key) => `sessionStorage:${key}`),
    ]).slice(0, 20),
    errors: unique([...flow.errors, ...browserTrace.pageErrors, ...browserTrace.consoleMessages.map((entry) => entry.text)]).slice(0, 16),
    evidence: unique([
      ...flow.evidence,
      ...browserTrace.runtimeSignals.authRequestUrls,
      ...browserTrace.notes,
    ]).slice(0, 20),
  });
}

function buildCaptchaFlows(domSnapshots: DomPageSnapshot[], apiEndpoints: ApiEndpoint[], artifacts: FormattedArtifact[]): CaptchaFlow[] {
  const flows: CaptchaFlow[] = [];
  const combinedText = artifacts.map((artifact) => artifact.formattedContent || artifact.content).join("\n");

  for (const provider of captchaProviderPatterns) {
    if (!hasMatch(provider.pattern, combinedText) && !domSnapshots.some((snapshot) => hasMatch(provider.pattern, snapshot.summary))) {
      continue;
    }

    const relatedArtifacts = artifacts.filter((artifact) => hasMatch(provider.pattern, artifact.formattedContent || artifact.content));
    const endpoints = apiEndpoints.filter((endpoint) => hasMatch(provider.pattern, `${endpoint.url} ${endpoint.purpose}`) || /captcha|risk|challenge|verify/i.test(endpoint.url));
    const errors = unique(relatedArtifacts.flatMap((artifact) => collectErrors(artifact.formattedContent || artifact.content))).slice(0, 8);

    flows.push(
      captchaFlowSchema.parse({
        provider: provider.provider,
        triggers: unique(
          domSnapshots
            .flatMap((snapshot) => [snapshot.title, ...snapshot.headings, snapshot.summary])
            .filter((entry) => provider.pattern.test(entry) || /risk|verify|challenge|captcha/i.test(entry)),
        ).slice(0, 10),
        endpoints: endpoints.map((endpoint) => endpoint.url).slice(0, 12),
        requestFields: unique(endpoints.flatMap((endpoint) => endpoint.requestFields)).slice(0, 12),
        errors,
        evidence: unique(
          relatedArtifacts
            .map((artifact) => clip((artifact.formattedContent || artifact.content).slice(0, 260)))
            .concat(domSnapshots.filter((snapshot) => hasMatch(provider.pattern, snapshot.summary)).map((snapshot) => snapshot.summary)),
        ).slice(0, 10),
      }),
    );
  }

  return flows;
}

function mergeRuntimeCaptchaFlows(flows: CaptchaFlow[], browserTrace: BrowserTrace | undefined): CaptchaFlow[] {
  if (!browserTrace || browserTrace.status !== "captured") {
    return flows;
  }

  const runtimeProviders = browserTrace.runtimeSignals.captchaProviders;
  const runtimeEndpoints = browserTrace.runtimeSignals.challengeRequestUrls;
  const runtimeErrors = unique([...browserTrace.pageErrors, ...browserTrace.consoleMessages.map((entry) => entry.text)]).filter((entry) =>
    /(captcha|challenge|turnstile|recaptcha|hcaptcha|verify|risk)/i.test(entry),
  );

  if (runtimeProviders.length === 0 && runtimeEndpoints.length === 0 && runtimeErrors.length === 0) {
    return flows;
  }

  if (flows.length === 0) {
    return [
      captchaFlowSchema.parse({
        provider: runtimeProviders[0] ?? "Runtime challenge flow",
        triggers: runtimeErrors.slice(0, 6),
        endpoints: runtimeEndpoints,
        requestFields: [],
        errors: runtimeErrors.slice(0, 10),
        evidence: [...runtimeProviders, ...browserTrace.notes],
      }),
    ];
  }

  return flows.map((flow) =>
    captchaFlowSchema.parse({
      ...flow,
      provider: runtimeProviders[0] ?? flow.provider,
      endpoints: unique([...flow.endpoints, ...runtimeEndpoints]).slice(0, 12),
      errors: unique([...flow.errors, ...runtimeErrors]).slice(0, 12),
      evidence: unique([...flow.evidence, ...runtimeProviders, ...browserTrace.notes]).slice(0, 12),
    }),
  );
}

function buildFingerprintingSignals(apiEndpoints: ApiEndpoint[], artifacts: FormattedArtifact[]): FingerprintingSignal[] {
  const signals: FingerprintingSignal[] = [];

  for (const collector of fingerprintCollectors) {
    const matchingArtifacts = artifacts.filter((artifact) => hasMatch(collector.pattern, artifact.formattedContent || artifact.content));
    if (matchingArtifacts.length === 0) {
      continue;
    }

    const dataPoints = unique(matchingArtifacts.flatMap((artifact) => takeMatches(collector.pattern, artifact.formattedContent || artifact.content))).slice(0, 12);
    const destinations = apiEndpoints
      .filter((endpoint) => /telemetry|track|collect|event|risk|device|fingerprint|profile/i.test(`${endpoint.url} ${endpoint.purpose}`))
      .map((endpoint) => endpoint.url)
      .slice(0, 8);

    signals.push(
      fingerprintingSignalSchema.parse({
        collector: collector.label,
        dataPoints,
        destinationUrls: destinations,
        purpose:
          destinations.length > 0
            ? "Collected browser/device traits appear to be forwarded into telemetry, anti-abuse, or risk endpoints."
            : "Collected browser/device traits appear to support client-side risk, telemetry, or anti-automation logic.",
        evidence: matchingArtifacts.map((artifact) => `${artifact.url}: ${clip((artifact.formattedContent || artifact.content).slice(0, 260))}`).slice(0, 8),
      }),
    );
  }

  return signals;
}

function mergeRuntimeFingerprintingSignals(signals: FingerprintingSignal[], browserTrace: BrowserTrace | undefined): FingerprintingSignal[] {
  if (!browserTrace || browserTrace.status !== "captured" || browserTrace.runtimeSignals.fingerprintingRequestUrls.length === 0) {
    return signals;
  }

  if (signals.length === 0) {
    return [
      fingerprintingSignalSchema.parse({
        collector: "runtime telemetry and device profiling",
        dataPoints: browserTrace.storage.interestingGlobals,
        destinationUrls: browserTrace.runtimeSignals.fingerprintingRequestUrls,
        purpose: "Browser-assisted tracing observed likely telemetry or device-risk network activity after hydration.",
        evidence: browserTrace.notes,
      }),
    ];
  }

  return signals.map((signal) =>
    fingerprintingSignalSchema.parse({
      ...signal,
      destinationUrls: unique([...signal.destinationUrls, ...browserTrace.runtimeSignals.fingerprintingRequestUrls]).slice(0, 10),
      evidence: unique([...signal.evidence, ...browserTrace.notes]).slice(0, 12),
    }),
  );
}

function buildEncryptionSignals(apiEndpoints: ApiEndpoint[], artifacts: FormattedArtifact[]): EncryptionSignal[] {
  const signals: EncryptionSignal[] = [];

  for (const pattern of encryptionPatterns) {
    const matchingArtifacts = artifacts.filter((artifact) => hasMatch(pattern, artifact.formattedContent || artifact.content));
    if (matchingArtifacts.length === 0) {
      continue;
    }

    const algorithmHints = unique(matchingArtifacts.flatMap((artifact) => takeMatches(pattern, artifact.formattedContent || artifact.content))).slice(0, 12);
    signals.push(
      encryptionSignalSchema.parse({
        algorithmHints,
        inputs: unique(
          matchingArtifacts.flatMap((artifact) => takeMatches(/\b(?:token|password|payload|fingerprint|deviceId|signature|nonce|timestamp)\b/gi, artifact.formattedContent || artifact.content)),
        ).slice(0, 12),
        outputs: unique(
          matchingArtifacts.flatMap((artifact) => takeMatches(/\b(?:ciphertext|digest|signature|hash|encrypted|token)\b/gi, artifact.formattedContent || artifact.content)),
        ).slice(0, 12),
        destinationUrls: apiEndpoints
          .filter((endpoint) => /sign|token|auth|risk|device|verify/i.test(`${endpoint.url} ${endpoint.purpose}`))
          .map((endpoint) => endpoint.url)
          .slice(0, 8),
        evidence: matchingArtifacts.map((artifact) => `${artifact.url}: ${clip((artifact.formattedContent || artifact.content).slice(0, 260))}`).slice(0, 8),
      }),
    );
  }

  return signals;
}

function mergeRuntimeEncryptionSignals(signals: EncryptionSignal[], browserTrace: BrowserTrace | undefined): EncryptionSignal[] {
  if (!browserTrace || browserTrace.status !== "captured" || browserTrace.runtimeSignals.encryptionHints.length === 0) {
    return signals;
  }

  if (signals.length === 0) {
    return [
      encryptionSignalSchema.parse({
        algorithmHints: browserTrace.runtimeSignals.encryptionHints,
        inputs: [],
        outputs: [],
        destinationUrls: browserTrace.runtimeSignals.authRequestUrls,
        evidence: browserTrace.notes,
      }),
    ];
  }

  return signals.map((signal) =>
    encryptionSignalSchema.parse({
      ...signal,
      algorithmHints: unique([...signal.algorithmHints, ...browserTrace.runtimeSignals.encryptionHints]).slice(0, 12),
      destinationUrls: unique([...signal.destinationUrls, ...browserTrace.runtimeSignals.authRequestUrls]).slice(0, 10),
      evidence: unique([...signal.evidence, ...browserTrace.notes]).slice(0, 12),
    }),
  );
}

function buildSecurityFindings(
  authFlows: AuthFlow[],
  captchaFlows: CaptchaFlow[],
  fingerprintingSignals: FingerprintingSignal[],
  graphQlEndpoints: GraphQlEndpoint[],
): SecurityFinding[] {
  const findings: SecurityFinding[] = [];

  if (graphQlEndpoints.some((endpoint) => endpoint.introspectionStatus === "supported")) {
    findings.push(
      securityFindingSchema.parse({
        severity: "medium",
        title: "GraphQL introspection is enabled",
        detail: "Same-origin GraphQL introspection responded successfully, which may disclose schema surface to unauthenticated clients.",
        remediation: "Disable production introspection where possible or gate it behind authentication.",
        evidence: graphQlEndpoints.filter((endpoint) => endpoint.introspectionStatus === "supported").map((endpoint) => endpoint.url),
      }),
    );
  }

  if (fingerprintingSignals.length > 0) {
    findings.push(
      securityFindingSchema.parse({
        severity: "low",
        title: "Client fingerprinting logic is present",
        detail: "The frontend collects device or browser traits that appear to support telemetry, risk scoring, or bot detection.",
        remediation: "Review data minimization, consent, and retention requirements for collected browser/device traits.",
        evidence: fingerprintingSignals.map((signal) => signal.collector),
      }),
    );
  }

  if (captchaFlows.length === 0 && authFlows.length > 0) {
    findings.push(
      securityFindingSchema.parse({
        severity: "low",
        title: "No obvious captcha challenge was detected on auth flow",
        detail: "The analyzed auth surface did not expose an obvious captcha or challenge gate in static assets.",
        remediation: "Confirm rate-limiting, MFA escalation, and anti-automation controls on the server side.",
        evidence: authFlows.map((flow) => flow.title),
      }),
    );
  }

  return findings;
}

export class FlowSurfaceDiscoverer {
  public discover(input: {
    domSnapshots: DomPageSnapshot[];
    artifacts: FormattedArtifact[];
    apiEndpoints: ApiEndpoint[];
    graphQlEndpoints: GraphQlEndpoint[];
    browserTrace?: BrowserTrace;
  }): {
    authFlows: AuthFlow[];
    captchaFlows: CaptchaFlow[];
    fingerprintingSignals: FingerprintingSignal[];
    encryptionSignals: EncryptionSignal[];
    securityFindings: SecurityFinding[];
  } {
    const authFlows = buildAuthFlow(input.domSnapshots, input.apiEndpoints, input.artifacts).map((flow) =>
      mergeRuntimeAuthFlow(flow, input.browserTrace),
    );
    const captchaFlows = mergeRuntimeCaptchaFlows(buildCaptchaFlows(input.domSnapshots, input.apiEndpoints, input.artifacts), input.browserTrace);
    const fingerprintingSignals = mergeRuntimeFingerprintingSignals(
      buildFingerprintingSignals(input.apiEndpoints, input.artifacts),
      input.browserTrace,
    );
    const encryptionSignals = mergeRuntimeEncryptionSignals(
      buildEncryptionSignals(input.apiEndpoints, input.artifacts),
      input.browserTrace,
    );
    const securityFindings = buildSecurityFindings(authFlows, captchaFlows, fingerprintingSignals, input.graphQlEndpoints);

    return {
      authFlows,
      captchaFlows,
      fingerprintingSignals,
      encryptionSignals,
      securityFindings,
    };
  }
}
