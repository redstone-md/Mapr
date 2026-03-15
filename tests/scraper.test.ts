import { describe, expect, test } from "bun:test";

import { BundleScraper, extractArtifactCandidates } from "../lib/scraper";

const emptyWasm = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);

describe("extractArtifactCandidates", () => {
  test("extracts scripts, stylesheets, manifests, service workers, wasm, and same-origin pages", () => {
    const html = `
      <html>
        <head>
          <link rel="stylesheet" href="/assets/app.css" />
          <link rel="manifest" href="/manifest.webmanifest" />
          <script src="/assets/app.js"></script>
          <script>
            navigator.serviceWorker.register('/sw.js');
            WebAssembly.instantiateStreaming(fetch('/assets/engine.wasm'));
          </script>
        </head>
        <body>
          <a href="/dashboard">Dashboard</a>
          <a href="https://external.example.com/">External</a>
        </body>
      </html>
    `;

    const candidates = extractArtifactCandidates(html, "https://example.com");
    expect(candidates.map((candidate) => `${candidate.type}:${candidate.url}`).sort()).toEqual(
      [
        "stylesheet:https://example.com/assets/app.css",
        "manifest:https://example.com/manifest.webmanifest",
        "script:https://example.com/assets/app.js",
        "html:https://example.com/dashboard",
        "service-worker:https://example.com/sw.js",
        "wasm:https://example.com/assets/engine.wasm",
      ].sort(),
    );
  });
});

describe("BundleScraper", () => {
  test("crawls multiple pages and downloads discovered website artifacts", async () => {
    const fetchLog: string[] = [];
    const fetcher = async (input: string | URL | Request): Promise<Response> => {
      const url = String(input);
      fetchLog.push(url);

      if (url === "https://example.com/") {
        return new Response(
          `
            <html>
              <head>
                <link rel="stylesheet" href="/assets/app.css" />
                <script src="/assets/app.js"></script>
                <script>navigator.serviceWorker.register('/sw.js')</script>
              </head>
              <body>
                <a href="/dashboard">Dashboard</a>
              </body>
            </html>
          `,
          { status: 200, headers: { "content-type": "text/html" } },
        );
      }

      if (url === "https://example.com/dashboard") {
        return new Response("<html><body>dashboard</body></html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        });
      }

      if (url === "https://example.com/assets/app.js") {
        return new Response(
          `
            import '/assets/chunk.js';
            WebAssembly.instantiateStreaming(fetch('/assets/engine.wasm'));
          `,
          { status: 200, headers: { "content-type": "application/javascript" } },
        );
      }

      if (url === "https://example.com/assets/chunk.js") {
        return new Response("console.log('chunk');", {
          status: 200,
          headers: { "content-type": "application/javascript" },
        });
      }

      if (url === "https://example.com/assets/app.css") {
        return new Response("body{background:url('/assets/bg.css')}", {
          status: 200,
          headers: { "content-type": "text/css" },
        });
      }

      if (url === "https://example.com/assets/bg.css") {
        return new Response(".app{color:red}", {
          status: 200,
          headers: { "content-type": "text/css" },
        });
      }

      if (url === "https://example.com/sw.js") {
        return new Response("self.addEventListener('fetch', () => {})", {
          status: 200,
          headers: { "content-type": "application/javascript" },
        });
      }

      if (url === "https://example.com/assets/engine.wasm") {
        return new Response(emptyWasm, {
          status: 200,
          headers: { "content-type": "application/wasm" },
        });
      }

      return new Response("missing", { status: 404, statusText: "Not Found" });
    };

    const scraper = new BundleScraper(fetcher, {
      maxPages: 5,
      maxArtifacts: 20,
    });
    const result = await scraper.scrape("https://example.com/");

    expect(fetchLog).toContain("https://example.com/");
    expect(result.htmlPages).toEqual(["https://example.com/", "https://example.com/dashboard"]);
    expect(result.artifacts.map((artifact) => artifact.type)).toContain("service-worker");
    expect(result.artifacts.map((artifact) => artifact.type)).toContain("wasm");
    expect(result.scriptUrls).toEqual([
      "https://example.com/assets/app.js",
      "https://example.com/sw.js",
      "https://example.com/assets/chunk.js",
    ]);
  });
});
