import { describe, expect, test } from "bun:test";

import { FlowSurfaceDiscoverer } from "../lib/flow-discovery";

describe("FlowSurfaceDiscoverer", () => {
  test("extracts auth, captcha, fingerprinting, and encryption findings", () => {
    const discoverer = new FlowSurfaceDiscoverer();
    const result = discoverer.discover({
      domSnapshots: [
        {
          url: "https://example.com/login.html",
          title: "Sign in",
          headings: ["Account login"],
          forms: [
            {
              action: "https://example.com/api/login",
              method: "POST",
              inputNames: ["email", "password"],
              inputTypes: ["email", "password"],
              submitLabels: ["Continue"],
            },
          ],
          buttons: ["Continue"],
          links: ["Forgot password"],
          iframes: [],
          inlineStateHints: [],
          dataAttributeKeys: [],
          summary: "title \"Sign in\", 1 heading(s), 1 form(s), 1 button label(s)",
        },
      ],
      artifacts: [
        {
          url: "https://example.com/assets/auth.js",
          type: "script",
          content: "",
          formattedContent: `
            navigator.userAgent;
            screen.width;
            crypto.subtle.digest("SHA-256", payload);
            const error = "captcha required";
            const token = localStorage.getItem("token");
            turnstile.render("#captcha");
          `,
          sizeBytes: 200,
          discoveredFrom: "root",
          formattingSkipped: false,
        },
      ],
      apiEndpoints: [
        {
          url: "https://example.com/api/login",
          methods: ["POST"],
          sourceArtifactUrl: "https://example.com/assets/auth.js",
          purpose: "Likely auth/session endpoint",
          requestFields: ["email", "password"],
          responseFields: [],
          evidence: ["fetch('/api/login')"],
        },
        {
          url: "https://example.com/api/risk/challenge",
          methods: ["POST"],
          sourceArtifactUrl: "https://example.com/assets/auth.js",
          purpose: "Likely captcha or risk verification endpoint",
          requestFields: ["token"],
          responseFields: [],
          evidence: ["fetch('/api/risk/challenge')"],
        },
      ],
      graphQlEndpoints: [
        {
          url: "https://example.com/graphql",
          introspectionStatus: "supported",
          operationTypes: ["Query"],
          sampleFields: ["OBJECT:User"],
          evidence: ["query Viewer"],
        },
      ],
      browserTrace: {
        status: "captured",
        mode: "playwright",
        finalUrl: "https://example.com/login.html",
        frameUrls: ["https://example.com/login.html"],
        requests: [
          {
            url: "https://example.com/api/login",
            method: "POST",
            resourceType: "xhr",
            status: 200,
          },
          {
            url: "https://example.com/api/risk/challenge",
            method: "POST",
            resourceType: "fetch",
            status: 403,
          },
        ],
        consoleMessages: [{ type: "error", text: "captcha required" }],
        pageErrors: ["challenge blocked"],
        storage: {
          localStorageKeys: ["token"],
          sessionStorageKeys: [],
          cookieNames: ["sid"],
          interestingGlobals: ["turnstile"],
        },
        runtimeSignals: {
          captchaProviders: ["Cloudflare Turnstile"],
          authRequestUrls: ["https://example.com/api/login"],
          challengeRequestUrls: ["https://example.com/api/risk/challenge"],
          fingerprintingRequestUrls: ["https://example.com/api/device/profile"],
          encryptionHints: ["crypto.subtle.digest"],
        },
        notes: ["runtime auth path observed"],
      },
    });

    expect(result.authFlows.length).toBeGreaterThan(0);
    expect(result.captchaFlows.length).toBeGreaterThan(0);
    expect(result.fingerprintingSignals.length).toBeGreaterThan(0);
    expect(result.encryptionSignals.length).toBeGreaterThan(0);
    expect(result.securityFindings.some((finding) => finding.title.includes("GraphQL introspection"))).toBe(true);
    expect(result.authFlows[0]?.tokens.some((entry) => entry.includes("cookie:sid"))).toBe(true);
    expect(result.captchaFlows[0]?.endpoints).toContain("https://example.com/api/risk/challenge");
  });
});
