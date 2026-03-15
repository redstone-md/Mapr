import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";

import { RunArtifactsWriter } from "../lib/run-output";

const cleanupPaths: string[] = [];

afterEach(async () => {
  await Promise.all(cleanupPaths.splice(0, cleanupPaths.length).map((path) => rm(path, { recursive: true, force: true })));
});

describe("RunArtifactsWriter", () => {
  test("creates a run directory with report, metadata, and artifact files", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "mapr-run-"));
    cleanupPaths.push(outputDir);

    const writer = new RunArtifactsWriter();
    const result = await writer.writeRun({
      targetUrl: "https://example.com/login.html",
      htmlPages: ["https://example.com/login.html"],
      domSnapshots: [],
      reportStatus: "complete",
      artifacts: [
        {
          url: "https://example.com/assets/app.js",
          type: "script",
          content: "console.log('raw')",
          formattedContent: "console.log('formatted');\n",
          sizeBytes: 22,
          discoveredFrom: "root",
          formattingSkipped: false,
        },
      ],
      analysis: {
        overview: "ok",
        entryPoints: [{ symbol: "bootstrapApp", description: "main entry", evidence: "artifact summary" }],
        initializationFlow: [],
        callGraph: [{ caller: "bootstrapApp", callee: "renderLogin", rationale: "startup chain" }],
        restoredNames: [],
        notableLibraries: [],
        investigationTips: [],
        risks: [],
        artifactSummaries: [
          {
            url: "https://example.com/assets/app.js",
            type: "script",
            chunkCount: 1,
            summary: "bootstrapApp initializes renderLogin for the auth route.",
          },
        ],
        analyzedChunkCount: 1,
      },
      deterministicSurface: {
        apiEndpoints: [
          {
            url: "https://example.com/api/login",
            methods: ["POST"],
            sourceArtifactUrl: "https://example.com/assets/app.js",
            purpose: "Likely auth/session endpoint",
            requestFields: ["email", "password"],
            responseFields: [],
            evidence: ["fetch('/api/login')"],
          },
        ],
        openApiDocuments: [],
        graphQlEndpoints: [],
        graphQlOperations: [],
        authFlows: [
          {
            title: "Primary authentication flow",
            triggers: ["login"],
            steps: [],
            tokens: ["cookie"],
            errors: ["invalid password"],
            evidence: ["artifact"],
          },
        ],
        captchaFlows: [],
        fingerprintingSignals: [],
        encryptionSignals: [],
        securityFindings: [],
      },
      outputPathOverride: outputDir,
      runMetadata: { test: true },
    });

    const metadata = await readFile(join(result.runDirectory, "metadata.json"), "utf8");
    const manifest = await readFile(join(result.runDirectory, "artifacts", "index.json"), "utf8");
    const readme = await readFile(join(result.runDirectory, "README.md"), "utf8");
    const htmlReport = await readFile(join(result.runDirectory, "report.html"), "utf8");
    const browserTrace = await readFile(join(result.runDirectory, "browser-trace.json"), "utf8");

    expect(result.reportPath).toBe(join(outputDir, "report.md"));
    expect(metadata).toContain("\"test\": true");
    expect(manifest).toContain("\"rawPath\"");
    expect(readme).toContain("Disclaimer");
    expect(htmlReport).toContain("Interactive Code Map");
    expect(htmlReport).toContain("graph-svg");
    expect(htmlReport).toContain("preview-tab");
    expect(htmlReport).toContain("data-jump-artifact-by-url");
    expect(htmlReport).toContain('"summary"');
    expect(htmlReport).not.toContain("&quot;summary&quot;");
    expect(browserTrace.trim()).toBe("null");
  });
});
