import { describe, expect, test } from "bun:test";

import { LocalArtifactRag } from "../lib/local-rag";

describe("LocalArtifactRag", () => {
  test("retrieves sibling segments relevant to the query", () => {
    const splitRag = new LocalArtifactRag(
      [
        {
          url: "https://example.com/assets/app.js",
          type: "script",
          content: [
            "function login(){return fetch('/api/login')}\n",
            "const cacheToken = window.localStorage.getItem('token')\n",
            "function renderDashboard(){console.log('dashboard')}\n",
          ].join(""),
          formattedContent: [
            "function login(){return fetch('/api/login')}\n",
            "const cacheToken = window.localStorage.getItem('token')\n",
            "function renderDashboard(){console.log('dashboard')}\n",
          ].join(""),
          sizeBytes: 128,
          discoveredFrom: "test",
          formattingSkipped: false,
        },
      ],
      { segmentBytes: 40, maxResults: 2 },
    );

    const results = splitRag.query({
      artifactUrl: "https://example.com/assets/app.js",
      query: "token localStorage auth session",
      excludeContent: "renderDashboard",
    });

    expect(results.length).toBeGreaterThan(0);
    expect(results.join("\n")).toContain("token");
  });
});
