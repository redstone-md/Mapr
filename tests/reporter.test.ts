import { describe, expect, test } from "bun:test";

import { ReportWriter } from "../lib/reporter";

describe("ReportWriter", () => {
  test("renders partial report status and analysis error details", () => {
    const writer = new ReportWriter();
    const markdown = writer.generateMarkdown({
      targetUrl: "https://example.com",
      htmlPages: ["https://example.com"],
      domSnapshots: [
        {
          url: "https://example.com",
          title: "Example Login",
          headings: ["Sign in"],
          forms: [
            {
              action: "https://example.com/login",
              method: "POST",
              inputNames: ["email", "password"],
              inputTypes: ["email", "password"],
              submitLabels: ["Continue"],
            },
          ],
          buttons: ["Continue"],
          links: ["Forgot password"],
          iframes: [],
          inlineStateHints: ["global:__INITIAL_STATE__"],
          dataAttributeKeys: ["data-testid"],
          summary: "title \"Example Login\", 1 heading(s), 1 form(s), 1 button label(s), 1 inline state hint(s)",
        },
      ],
      reportStatus: "partial",
      analysisError: "Provider rate limit hit during analysis.",
      artifacts: [
        {
          url: "https://example.com/assets/app.js",
          type: "script",
          content: "console.log('hi')",
          formattedContent: "console.log('hi');\n",
          sizeBytes: 18,
          discoveredFrom: "root",
          formattingSkipped: false,
        },
      ],
      analysis: {
        overview: "Partial analysis only.",
        entryPoints: [],
        initializationFlow: [],
        callGraph: [],
        restoredNames: [],
        notableLibraries: [],
        investigationTips: [],
        risks: [],
        artifactSummaries: [],
        analyzedChunkCount: 0,
      },
    });

    expect(markdown).toContain("Report status: partial");
    expect(markdown).toContain("Analysis ended early: Provider rate limit hit during analysis.");
    expect(markdown).toContain("## DOM Surface");
    expect(markdown).toContain("forms: POST https://example.com/login [email, password]");
  });
});
