import { describe, expect, test } from "bun:test";

import { BundleScraper, extractArtifactCandidates } from "../lib/scraper";

const emptyWasm = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);

describe("extractArtifactCandidates", () => {
  test("extracts code artifacts and ignores image assets", () => {
    const html = `
      <html>
        <head>
          <link rel="stylesheet" href="/assets/app.css" />
          <link rel="modulepreload" href="/assets/preloaded.js" />
          <script src="/assets/app.js"></script>
          <script>
            navigator.serviceWorker.register('/sw.js');
            WebAssembly.instantiateStreaming(fetch('/assets/engine.wasm'));
            fetch('/assets/logo.png');
          </script>
        </head>
        <body>
          <a href="/dashboard">Dashboard</a>
          <iframe src="/frame"></iframe>
          <form action="/submit"></form>
        </body>
      </html>
    `;

    const candidates = extractArtifactCandidates(html, "https://example.com");

    expect(candidates.map((candidate) => `${candidate.type}:${candidate.url}`).sort()).toEqual(
      [
        "script:https://example.com/assets/app.js",
        "script:https://example.com/assets/preloaded.js",
        "html:https://example.com/dashboard",
        "html:https://example.com/frame",
        "html:https://example.com/submit",
        "service-worker:https://example.com/sw.js",
        "wasm:https://example.com/assets/engine.wasm",
      ].sort(),
    );
  });
});

describe("BundleScraper", () => {
  test("crawls same-origin pages, follows iframe pages, expands with sitemap, and skips binary/font artifacts", async () => {
    const fetchLog: string[] = [];
    const fetcher = async (input: string | URL | Request): Promise<Response> => {
      const url = String(input);
      fetchLog.push(url);

      if (url === "https://example.com/robots.txt") {
        return new Response("Sitemap: https://example.com/sitemap.xml", { status: 200 });
      }

      if (url === "https://example.com/sitemap.xml") {
        return new Response(
          `<?xml version="1.0" encoding="UTF-8"?><urlset><url><loc>https://example.com/offers</loc></url></urlset>`,
          { status: 200, headers: { "content-type": "application/xml" } },
        );
      }

      if (url === "https://example.com/") {
        return new Response(
          `
            <html>
              <head>
                <script src="/assets/app.js"></script>
                <script>navigator.serviceWorker.register('/sw.js')</script>
              </head>
              <body>
                <a href="/dashboard">Dashboard</a>
                <a href="/font-route">FontRoute</a>
                <iframe src="/embedded/login"></iframe>
                <img src="/assets/logo.png" />
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

      if (url === "https://example.com/embedded/login") {
        return new Response(
          `<html><head><script src="/assets/frame.js"></script></head><body>iframe</body></html>`,
          { status: 200, headers: { "content-type": "text/html" } },
        );
      }

      if (url === "https://example.com/offers") {
        return new Response(
          `<html><head><script src="/assets/offers.js"></script></head><body>offers</body></html>`,
          { status: 200, headers: { "content-type": "text/html" } },
        );
      }

      if (url === "https://example.com/assets/app.js") {
        return new Response(
          `
            import '/assets/chunk.js';
            WebAssembly.instantiateStreaming(fetch('/assets/engine.wasm'));
            //# sourceMappingURL=/assets/app.js.map
            fetch('/assets/logo.png');
          `,
          { status: 200, headers: { "content-type": "application/javascript" } },
        );
      }

      if (url === "https://example.com/assets/offers.js") {
        return new Response("console.log('offers');", {
          status: 200,
          headers: { "content-type": "application/javascript" },
        });
      }

      if (url === "https://example.com/assets/chunk.js") {
        return new Response("console.log('chunk');", {
          status: 200,
          headers: { "content-type": "application/javascript" },
        });
      }

      if (url === "https://example.com/assets/frame.js") {
        return new Response("console.log('iframe-js');", {
          status: 200,
          headers: { "content-type": "application/javascript" },
        });
      }

      if (url === "https://example.com/assets/app.js.map") {
        return new Response(
          JSON.stringify({
            version: 3,
            sources: ["src/app.ts"],
            sourcesContent: ["export function boot(){ console.log('boot'); }"],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
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

      if (url === "https://example.com/assets/logo.png") {
        return new Response("png", { status: 200, headers: { "content-type": "image/png" } });
      }

      if (url === "https://example.com/font-route") {
        return new Response("font", { status: 200, headers: { "content-type": "font/woff2" } });
      }

      return new Response("missing", { status: 404, statusText: "Not Found" });
    };

    const scraper = new BundleScraper(fetcher, {
      maxPages: 10,
      maxArtifacts: 20,
    });
    const result = await scraper.scrape("https://example.com/");

    expect(fetchLog).toContain("https://example.com/robots.txt");
    expect(fetchLog).toContain("https://example.com/sitemap.xml");
    expect(fetchLog).toContain("https://example.com/offers");
    expect(fetchLog).toContain("https://example.com/embedded/login");
    expect(fetchLog).toContain("https://example.com/assets/frame.js");
    expect(fetchLog).toContain("https://example.com/font-route");
    expect(fetchLog).not.toContain("https://example.com/assets/logo.png");
    expect(result.htmlPages.sort()).toEqual(
      [
        "https://example.com/offers",
        "https://example.com/",
        "https://example.com/dashboard",
        "https://example.com/embedded/login",
      ].sort(),
    );
    expect(result.artifacts.map((artifact) => artifact.type).sort()).toEqual(
      (["script", "script", "script", "script", "service-worker", "source-map", "wasm"] as const).slice().sort(),
    );
    expect(result.scriptUrls.sort()).toEqual(
      [
        "https://example.com/assets/offers.js",
        "https://example.com/assets/app.js",
        "https://example.com/assets/frame.js",
        "https://example.com/sw.js",
        "https://example.com/assets/chunk.js",
      ].sort(),
    );
    expect(result.artifacts.find((artifact) => artifact.type === "source-map")?.content).toContain("src/app.ts");
  });

  test("keeps page-scoped crawl tight for deep entry URLs", async () => {
    const fetchLog: string[] = [];
    const fetcher = async (input: string | URL | Request): Promise<Response> => {
      const url = String(input);
      fetchLog.push(url);

      if (url === "https://example.com/login.html") {
        return new Response(
          `
            <html>
              <head><script src="/assets/login.js"></script></head>
              <body>
                <a href="/dashboard">Dashboard</a>
                <a href="/signup.html">Signup</a>
                <iframe src="/embedded/login-frame.html"></iframe>
              </body>
            </html>
          `,
          { status: 200, headers: { "content-type": "text/html" } },
        );
      }

      if (url === "https://example.com/assets/login.js") {
        return new Response("import '/assets/login-chunk.js';", {
          status: 200,
          headers: { "content-type": "application/javascript" },
        });
      }

      if (url === "https://example.com/assets/login-chunk.js") {
        return new Response("console.log('login chunk');", {
          status: 200,
          headers: { "content-type": "application/javascript" },
        });
      }

      if (url === "https://example.com/embedded/login-frame.html") {
        return new Response(`<html><head><script src="/assets/frame-login.js"></script></head></html>`, {
          status: 200,
          headers: { "content-type": "text/html" },
        });
      }

      if (url === "https://example.com/assets/frame-login.js") {
        return new Response("console.log('frame login');", {
          status: 200,
          headers: { "content-type": "application/javascript" },
        });
      }

      return new Response("missing", { status: 404, statusText: "Not Found" });
    };

    const scraper = new BundleScraper(fetcher, {
      maxPages: 10,
      maxArtifacts: 20,
      maxDepth: 3,
    });
    const result = await scraper.scrape("https://example.com/login.html");

    expect(fetchLog).not.toContain("https://example.com/robots.txt");
    expect(fetchLog).not.toContain("https://example.com/sitemap.xml");
    expect(fetchLog).not.toContain("https://example.com/dashboard");
    expect(fetchLog).not.toContain("https://example.com/signup.html");
    expect(fetchLog).toContain("https://example.com/embedded/login-frame.html");
    expect(result.htmlPages.sort()).toEqual(
      ["https://example.com/login.html", "https://example.com/embedded/login-frame.html"].sort(),
    );
    expect(result.scriptUrls.sort()).toEqual(
      [
        "https://example.com/assets/login.js",
        "https://example.com/assets/login-chunk.js",
        "https://example.com/assets/frame-login.js",
      ].sort(),
    );
  });

  test("continues when nested artifacts return 404", async () => {
    const progressMessages: string[] = [];
    const fetcher = async (input: string | URL | Request): Promise<Response> => {
      const url = String(input);

      if (url === "https://example.com/") {
        return new Response(`<html><head><script src="/assets/app.js"></script></head></html>`, {
          status: 200,
          headers: { "content-type": "text/html" },
        });
      }

      if (url === "https://example.com/assets/app.js") {
        return new Response("import '/assets/missing.js'; console.log('ok');", {
          status: 200,
          headers: { "content-type": "application/javascript" },
        });
      }

      if (url === "https://example.com/assets/missing.js") {
        return new Response("missing", { status: 404, statusText: "Not Found" });
      }

      return new Response("missing", { status: 404, statusText: "Not Found" });
    };

    const scraper = new BundleScraper(fetcher, {
      onProgress(event) {
        progressMessages.push(event.message);
      },
    });
    const result = await scraper.scrape("https://example.com/");

    expect(result.scriptUrls).toEqual(["https://example.com/assets/app.js"]);
    expect(progressMessages.some((message) => message.includes("Skipping script after 404 Not Found"))).toBe(true);
  });
});
