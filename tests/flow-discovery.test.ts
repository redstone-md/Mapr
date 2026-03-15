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
    });

    expect(result.authFlows.length).toBeGreaterThan(0);
    expect(result.captchaFlows.length).toBeGreaterThan(0);
    expect(result.fingerprintingSignals.length).toBeGreaterThan(0);
    expect(result.encryptionSignals.length).toBeGreaterThan(0);
    expect(result.securityFindings.some((finding) => finding.title.includes("GraphQL introspection"))).toBe(true);
  });
});
