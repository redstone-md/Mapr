import * as cheerio from "cheerio";
import { Buffer } from "buffer";
import { z } from "zod";

const httpUrlSchema = z
  .string()
  .trim()
  .url("Expected a valid URL.")
  .refine((value) => /^https?:\/\//.test(value), "Expected an http or https URL.");

const scriptBundleSchema = z.object({
  url: httpUrlSchema,
  rawCode: z.string(),
  sizeBytes: z.number().int().nonnegative(),
});

export type ScriptBundle = z.infer<typeof scriptBundleSchema>;

export interface ScrapeResult {
  pageUrl: string;
  html: string;
  scriptUrls: string[];
  bundles: ScriptBundle[];
}

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export function extractScriptUrls(html: string, pageUrl: string): string[] {
  const validatedHtml = z.string().parse(html);
  const baseUrl = httpUrlSchema.parse(pageUrl);
  const $ = cheerio.load(validatedHtml);
  const discoveredUrls = new Set<string>();

  $("script[src]").each((_, element) => {
    const src = $(element).attr("src")?.trim();
    if (!src) {
      return;
    }

    try {
      const absoluteUrl = new URL(src, baseUrl).toString();
      const validatedUrl = httpUrlSchema.safeParse(absoluteUrl);
      if (validatedUrl.success) {
        discoveredUrls.add(validatedUrl.data);
      }
    } catch {
      return;
    }
  });

  return [...discoveredUrls];
}

export class BundleScraper {
  public constructor(private readonly fetcher: FetchLike = fetch) {}

  public async scrape(pageUrl: string): Promise<ScrapeResult> {
    const validatedPageUrl = httpUrlSchema.parse(pageUrl);
    const html = await this.fetchText(validatedPageUrl, "HTML document");
    const scriptUrls = extractScriptUrls(html, validatedPageUrl);
    const bundles: ScriptBundle[] = [];

    for (const scriptUrl of scriptUrls) {
      const rawCode = await this.fetchText(scriptUrl, `bundle ${scriptUrl}`);
      bundles.push(
        scriptBundleSchema.parse({
          url: scriptUrl,
          rawCode,
          sizeBytes: Buffer.byteLength(rawCode, "utf8"),
        }),
      );
    }

    return {
      pageUrl: validatedPageUrl,
      html,
      scriptUrls,
      bundles,
    };
  }

  private async fetchText(url: string, resourceLabel: string): Promise<string> {
    try {
      const response = await this.fetcher(url, {
        headers: {
          "user-agent": "mapr/0.1.0",
        },
      });

      if (!response.ok) {
        throw new Error(`Failed to fetch ${resourceLabel} from ${url}: ${response.status} ${response.statusText}`);
      }

      return await response.text();
    } catch (error) {
      if (error instanceof Error) {
        throw new Error(`Unable to fetch ${resourceLabel}: ${error.message}`);
      }

      throw new Error(`Unable to fetch ${resourceLabel}.`);
    }
  }
}
