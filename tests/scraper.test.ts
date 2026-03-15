import { describe, expect, test } from "bun:test";

import { BundleScraper, extractScriptUrls } from "../lib/scraper";

describe("extractScriptUrls", () => {
  test("extracts and resolves external script sources", () => {
    const html = `
      <html>
        <head>
          <script src="/assets/app.js"></script>
          <script src="https://cdn.example.com/vendor.js"></script>
          <script>console.log("inline")</script>
          <script src="/assets/app.js"></script>
        </head>
      </html>
    `;

    const scriptUrls = extractScriptUrls(html, "https://example.com/dashboard");
    expect(scriptUrls).toEqual([
      "https://example.com/assets/app.js",
      "https://cdn.example.com/vendor.js",
    ]);
  });
});

describe("BundleScraper", () => {
  test("fetches html and then downloads discovered bundles", async () => {
    const fetchLog: string[] = [];
    const fetcher = async (input: string | URL | Request): Promise<Response> => {
      const url = String(input);
      fetchLog.push(url);

      if (url === "https://example.com") {
        return new Response(
          `
            <html>
              <head>
                <script src="/static/runtime.js"></script>
                <script src="https://cdn.example.com/app.js"></script>
              </head>
            </html>
          `,
          { status: 200 },
        );
      }

      if (url === "https://example.com/static/runtime.js") {
        return new Response("console.log('runtime');", { status: 200 });
      }

      if (url === "https://cdn.example.com/app.js") {
        return new Response("console.log('app');", { status: 200 });
      }

      return new Response("missing", { status: 404, statusText: "Not Found" });
    };

    const scraper = new BundleScraper(fetcher);
    const result = await scraper.scrape("https://example.com");

    expect(fetchLog).toEqual([
      "https://example.com",
      "https://example.com/static/runtime.js",
      "https://cdn.example.com/app.js",
    ]);
    expect(result.scriptUrls).toEqual([
      "https://example.com/static/runtime.js",
      "https://cdn.example.com/app.js",
    ]);
    expect(result.bundles.map((bundle) => bundle.rawCode)).toEqual([
      "console.log('runtime');",
      "console.log('app');",
    ]);
  });
});
