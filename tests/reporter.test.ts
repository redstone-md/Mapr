import { describe, expect, test } from "bun:test";

import { ReportWriter } from "../lib/reporter";

describe("ReportWriter", () => {
  test("renders partial report status and analysis error details", () => {
    const writer = new ReportWriter();
    const markdown = writer.generateMarkdown({
      targetUrl: "https://example.com",
      htmlPages: ["https://example.com"],
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
  });
});
