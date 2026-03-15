import { describe, expect, test } from "bun:test";

import {
  estimateRemainingMs,
  formatDuration,
  middleTruncate,
  renderAdaptiveAnalysisProgressLine,
  stripAnsi,
} from "../lib/progress";

describe("progress helpers", () => {
  test("estimates remaining time from completed work", () => {
    expect(estimateRemainingMs(2, 6, 20_000)).toBe(40_000);
    expect(estimateRemainingMs(0, 6, 20_000)).toBeUndefined();
    expect(estimateRemainingMs(6, 6, 20_000)).toBeUndefined();
  });

  test("formats eta durations compactly", () => {
    expect(formatDuration(8_000)).toBe("8s");
    expect(formatDuration(102_000)).toBe("1m 42s");
    expect(formatDuration(7_560_000)).toBe("2h 6m");
  });

  test("middle truncates long urls", () => {
    const truncated = middleTruncate("https://example.com/assets/vendors-long-file.js", 24);

    expect(truncated).toStartWith("https://example");
    expect(truncated).toEndWith(".js");
    expect(truncated).toContain("...");
    expect(truncated.length).toBeLessThanOrEqual(24);
    expect(middleTruncate("short", 24)).toBe("short");
  });

  test("renders adaptive progress lines with truncated url on narrow terminals", () => {
    const rendered = stripAnsi(
      renderAdaptiveAnalysisProgressLine({
        completed: 5,
        total: 40,
        elapsedMs: 100_000,
        agent: "synthesizer",
        state: "streaming",
        artifactUrl: "https://static.kwcdn.com/m-assets/assets/js/vendors_be331c4579e24f659de3bf8342e2adff.js",
        chunkIndex: 4,
        chunkCount: 7,
        estimatedOutputTokens: 94,
        tokensPerSecond: 6.3,
        terminalWidth: 96,
      }),
    );

    expect(rendered).toContain("synthesizer agent streaming");
    expect(rendered).toContain("chunk 4/7");
    expect(rendered).toContain("[~94 tok 6.3 tps]");
    expect(rendered).toContain("...");
    expect(rendered.length).toBeLessThanOrEqual(96);
  });

  test("keeps eta when the terminal has enough room", () => {
    const rendered = stripAnsi(
      renderAdaptiveAnalysisProgressLine({
        completed: 5,
        total: 40,
        elapsedMs: 100_000,
        agent: "runtime",
        state: "streaming",
        artifactUrl: "https://static.kwcdn.com/m-assets/assets/js/vendors_be331c4579e24f659de3bf8342e2adff.js",
        chunkIndex: 4,
        chunkCount: 7,
        estimatedOutputTokens: 94,
        tokensPerSecond: 6.3,
        terminalWidth: 140,
      }),
    );

    expect(rendered).toContain("[eta 11m 40s]");
    expect(rendered.length).toBeLessThanOrEqual(140);
  });
});
