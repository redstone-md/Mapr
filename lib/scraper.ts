import { Buffer } from "buffer";
import { z } from "zod";

import {
  artifactCandidateSchema,
  discoveredArtifactSchema,
  extractArtifactCandidates,
  extractNestedCandidates,
  type ArtifactCandidate,
  type DiscoveredArtifact,
} from "./artifacts";
import { WasmModuleSummarizer } from "./wasm";

const httpUrlSchema = z
  .string()
  .trim()
  .url("Expected a valid URL.")
  .refine((value) => /^https?:\/\//.test(value), "Expected an http or https URL.");

const scraperOptionsSchema = z.object({
  maxPages: z.number().int().positive().default(10),
  maxArtifacts: z.number().int().positive().default(200),
});

export interface ScrapeResult {
  pageUrl: string;
  artifacts: DiscoveredArtifact[];
  htmlPages: string[];
  scriptUrls: string[];
}

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
type ScraperOptions = z.input<typeof scraperOptionsSchema>;

function isPageCandidate(candidate: ArtifactCandidate, rootOrigin: string): boolean {
  return candidate.type === "html" && new URL(candidate.url).origin === rootOrigin;
}

function shouldFollowCandidate(candidate: ArtifactCandidate, rootOrigin: string): boolean {
  if (candidate.type === "html") {
    return new URL(candidate.url).origin === rootOrigin;
  }

  return true;
}

export class BundleScraper {
  private readonly options: z.infer<typeof scraperOptionsSchema>;
  private readonly wasmSummarizer = new WasmModuleSummarizer();

  public constructor(
    private readonly fetcher: FetchLike = fetch,
    options: ScraperOptions = {},
  ) {
    this.options = scraperOptionsSchema.parse(options);
  }

  public async scrape(pageUrl: string): Promise<ScrapeResult> {
    const validatedPageUrl = httpUrlSchema.parse(pageUrl);
    const rootOrigin = new URL(validatedPageUrl).origin;
    const visitedUrls = new Set<string>();
    const htmlPages = new Set<string>();
    const artifacts: DiscoveredArtifact[] = [];
    const queue: ArtifactCandidate[] = [
      artifactCandidateSchema.parse({
        url: validatedPageUrl,
        type: "html",
        discoveredFrom: "root",
      }),
    ];

    while (queue.length > 0) {
      if (artifacts.length >= this.options.maxArtifacts) {
        break;
      }

      const candidate = queue.shift();
      if (!candidate || visitedUrls.has(candidate.url)) {
        continue;
      }

      if (!shouldFollowCandidate(candidate, rootOrigin)) {
        continue;
      }

      if (isPageCandidate(candidate, rootOrigin) && htmlPages.size >= this.options.maxPages && candidate.url !== validatedPageUrl) {
        continue;
      }

      visitedUrls.add(candidate.url);
      const artifact = await this.fetchArtifact(candidate);
      artifacts.push(artifact);

      if (artifact.type === "html") {
        htmlPages.add(artifact.url);
      }

      const nestedCandidates = extractNestedCandidates(artifact);
      for (const nestedCandidate of nestedCandidates) {
        if (!visitedUrls.has(nestedCandidate.url)) {
          queue.push(nestedCandidate);
        }
      }
    }

    return {
      pageUrl: validatedPageUrl,
      artifacts,
      htmlPages: [...htmlPages],
      scriptUrls: artifacts
        .filter((artifact) => artifact.type === "script" || artifact.type === "service-worker" || artifact.type === "worker")
        .map((artifact) => artifact.url),
    };
  }

  private async fetchArtifact(candidate: ArtifactCandidate): Promise<DiscoveredArtifact> {
    const response = await this.fetchResponse(candidate.url, candidate.type);
    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";

    if (candidate.type === "wasm" || contentType.includes("application/wasm")) {
      const bytes = new Uint8Array(await response.arrayBuffer());
      return discoveredArtifactSchema.parse({
        url: candidate.url,
        type: "wasm",
        sizeBytes: bytes.byteLength,
        content: this.wasmSummarizer.summarize({
          url: candidate.url,
          bytes,
        }),
        discoveredFrom: candidate.discoveredFrom,
      });
    }

    const content = await response.text();
    const resolvedType = contentType.includes("text/html") ? "html" : candidate.type;

    return discoveredArtifactSchema.parse({
      url: candidate.url,
      type: resolvedType,
      sizeBytes: Buffer.byteLength(content, "utf8"),
      content,
      discoveredFrom: candidate.discoveredFrom,
    });
  }

  private async fetchResponse(url: string, artifactType: ArtifactCandidate["type"]): Promise<Response> {
    try {
      const response = await this.fetcher(url, {
        headers: {
          "user-agent": "mapr/0.2.0",
        },
      });

      if (!response.ok) {
        throw new Error(`Failed to fetch ${artifactType} from ${url}: ${response.status} ${response.statusText}`);
      }

      return response;
    } catch (error) {
      if (error instanceof Error) {
        throw new Error(`Unable to fetch ${artifactType} artifact ${url}: ${error.message}`);
      }

      throw new Error(`Unable to fetch ${artifactType} artifact ${url}.`);
    }
  }
}

export { extractArtifactCandidates };
