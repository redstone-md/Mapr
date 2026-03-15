import { describe, expect, test } from "bun:test";

import { buildArtifactAnalysisPlan, estimateAgentTaskCount, getAgentPlanForChunk } from "../lib/analysis-planner";

describe("analysis planner", () => {
  test("prioritizes auth-like artifacts above generic search assets", () => {
    const highPlan = buildArtifactAnalysisPlan("https://example.com/login.html", {
      url: "https://example.com/assets/login-runtime.js",
      type: "script",
      discoveredFrom: "html:script",
      sizeBytes: 420000,
    });
    const lowPlan = buildArtifactAnalysisPlan("https://example.com/login.html", {
      url: "https://example.com/assets/search_result.js",
      type: "script",
      discoveredFrom: "form:action",
      sizeBytes: 420000,
    });

    expect(highPlan.priority).toBe("high");
    expect(lowPlan.priority).toBe("low");
    expect(highPlan.score).toBeGreaterThan(lowPlan.score);
  });

  test("uses a reduced swarm on later low-priority chunks", () => {
    const plan = buildArtifactAnalysisPlan("https://example.com/login.html", {
      url: "https://cdn.example.net/sdk/facebook.js",
      type: "script",
      discoveredFrom: "script:code",
      sizeBytes: 12000,
    });

    expect(plan.priority).toBe("low");
    expect(getAgentPlanForChunk(plan, 0)).toEqual(["scout", "synthesizer"]);
    expect(getAgentPlanForChunk(plan, 3)).toEqual(["synthesizer"]);
  });

  test("estimates adaptive task counts instead of fixed chunk x 5", () => {
    const taskCount = estimateAgentTaskCount(
      "https://example.com/login.html",
      [
        {
          url: "https://example.com/assets/login.js",
          type: "script",
          content: "",
          formattedContent: "",
          sizeBytes: 400000,
          discoveredFrom: "html:script",
          formattingSkipped: false,
        },
        {
          url: "https://example.com/assets/search_result.js",
          type: "script",
          content: "",
          formattedContent: "",
          sizeBytes: 400000,
          discoveredFrom: "form:action",
          formattingSkipped: false,
        },
      ],
      (artifact) => (artifact.url.includes("login") ? 3 : 4),
    );

    expect(taskCount).toBeLessThan(35);
    expect(taskCount).toBeGreaterThan(0);
  });
});
