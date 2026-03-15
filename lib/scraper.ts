import { Buffer } from "buffer";
import { z } from "zod";

import {
  artifactCandidateSchema,
  discoveredArtifactSchema,
  extractArtifactCandidates,
  extractNestedCandidates,
  isIgnoredContentType,
  isAnalyzableArtifactType,
  type ArtifactCandidate,
  type DiscoveredArtifact,
} from "./artifacts";
import { isAuthLikePathname } from "./url-patterns";
import { WasmModuleSummarizer } from "./wasm";

const MAPR_USER_AGENT = "mapr";

const httpUrlSchema = z
  .string()
  .trim()
  .url("Expected a valid URL.")
  .refine((value) => /^https?:\/\//.test(value), "Expected an http or https URL.");

const scraperOptionsSchema = z.object({
  maxPages: z.number().int().positive().default(20),
  maxArtifacts: z.number().int().positive().default(400),
  maxDepth: z.number().int().nonnegative().default(3),
});

export interface ScrapeResult {
  pageUrl: string;
  artifacts: DiscoveredArtifact[];
  htmlPages: string[];
  scriptUrls: string[];
}

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
type NumericScraperOptions = z.input<typeof scraperOptionsSchema>;
type QueueEntry = { candidate: ArtifactCandidate; depth: number };
type CrawlScope = "site" | "page";

export interface ScraperProgressEvent {
  message: string;
  url: string;
  type: ArtifactCandidate["type"];
  depth: number;
}

interface ScraperOptions extends NumericScraperOptions {
  onProgress?: (event: ScraperProgressEvent) => void;
}

function isPageCandidate(candidate: ArtifactCandidate, rootOrigin: string): boolean {
  return candidate.type === "html" && new URL(candidate.url).origin === rootOrigin;
}

function isRootLikeEntry(url: string): boolean {
  const pathname = new URL(url).pathname.toLowerCase();
  return pathname === "/" || pathname === "" || pathname.endsWith("/index.html") || pathname.endsWith("/index.htm");
}

function shouldFollowCandidate(candidate: ArtifactCandidate, rootOrigin: string): boolean {
  if (candidate.type === "html") {
    return new URL(candidate.url).origin === rootOrigin;
  }

  return true;
}

function parseSitemapXml(xml: string, rootOrigin: string): ArtifactCandidate[] {
  const candidates = new Map<string, ArtifactCandidate>();
  const regex = /<loc>([^<]+)<\/loc>/gi;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(xml)) !== null) {
    try {
      const url = new URL(match[1] ?? "").toString();
      if (new URL(url).origin !== rootOrigin) {
        continue;
      }

      const candidate = artifactCandidateSchema.safeParse({
        url,
        type: "html",
        discoveredFrom: "sitemap:loc",
      });

      if (candidate.success) {
        candidates.set(candidate.data.url, candidate.data);
      }
    } catch {
      continue;
    }
  }

  return [...candidates.values()];
}

function parseRobotsSitemaps(robotsText: string): string[] {
  return robotsText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^sitemap:/i.test(line))
    .map((line) => line.replace(/^sitemap:\s*/i, "").trim())
    .filter(Boolean);
}

function summarizeSourceMap(rawMap: string, mapUrl: string): string {
  try {
    const payload = z
      .object({
        version: z.number().optional(),
        file: z.string().optional(),
        sourceRoot: z.string().optional(),
        sources: z.array(z.string()).optional(),
        sourcesContent: z.array(z.string().nullable()).optional(),
      })
      .parse(JSON.parse(rawMap) as unknown);

    const sources = payload.sources ?? [];
    const sourcesContent = payload.sourcesContent ?? [];
    const lines = [`Source map: ${mapUrl}`, `Mapped sources: ${sources.length}`];

    for (let index = 0; index < sources.length; index += 1) {
      const sourceName = sources[index];
      const sourceContent = sourcesContent[index];
      if (!sourceName) {
        continue;
      }

      lines.push(`--- Source: ${sourceName}`);
      if (typeof sourceContent === "string" && sourceContent.length > 0) {
        lines.push(sourceContent);
      }
    }

    return lines.join("\n");
  } catch {
    return rawMap;
  }
}

export class BundleScraper {
  private readonly options: z.infer<typeof scraperOptionsSchema>;
  private readonly wasmSummarizer = new WasmModuleSummarizer();
  private readonly onProgress: ((event: ScraperProgressEvent) => void) | undefined;

  public constructor(
    private readonly fetcher: FetchLike = fetch,
    options: ScraperOptions = {},
  ) {
    this.options = scraperOptionsSchema.parse(options);
    this.onProgress = options.onProgress;
  }

  public async scrape(pageUrl: string): Promise<ScrapeResult> {
    const validatedPageUrl = httpUrlSchema.parse(pageUrl);
    const rootOrigin = new URL(validatedPageUrl).origin;
    const crawlScope: CrawlScope = isRootLikeEntry(validatedPageUrl) ? "site" : "page";
    const visitedUrls = new Set<string>();
    const htmlPages = new Set<string>();
    const artifacts: DiscoveredArtifact[] = [];
    const queue: QueueEntry[] = [
      {
        candidate: artifactCandidateSchema.parse({
          url: validatedPageUrl,
          type: "html",
          discoveredFrom: "root",
        }),
        depth: 0,
      },
    ];

    if (crawlScope === "site") {
      queue.push(...(await this.discoverSupplementalPages(rootOrigin)).map((candidate) => ({ candidate, depth: 1 })));
    }

    while (queue.length > 0) {
      if (artifacts.length >= this.options.maxArtifacts) {
        break;
      }

      const entry = queue.shift();
      if (!entry || visitedUrls.has(entry.candidate.url)) {
        continue;
      }

      const { candidate, depth } = entry;

      if (depth > this.options.maxDepth) {
        this.emitProgress({
          message: `Skipping ${candidate.type} beyond crawl depth ${this.options.maxDepth}: ${candidate.url}`,
          url: candidate.url,
          type: candidate.type,
          depth,
        });
        continue;
      }

      if (!shouldFollowCandidate(candidate, rootOrigin)) {
        continue;
      }

      if (isPageCandidate(candidate, rootOrigin) && htmlPages.size >= this.options.maxPages && candidate.url !== validatedPageUrl) {
        continue;
      }

      visitedUrls.add(candidate.url);
      this.emitProgress({
        message: `Fetching ${candidate.type} depth ${depth}: ${candidate.url}`,
        url: candidate.url,
        type: candidate.type,
        depth,
      });

      const artifact = await this.fetchArtifact(candidate, depth, candidate.url === validatedPageUrl);
      if (!artifact) {
        continue;
      }

      if (artifact.type === "html") {
        htmlPages.add(artifact.url);
      }

      if (isAnalyzableArtifactType(artifact.type)) {
        artifacts.push(artifact);
      }

      const nestedCandidates = this.filterNestedCandidates(extractNestedCandidates(artifact), validatedPageUrl, crawlScope);
      for (const nestedCandidate of nestedCandidates) {
        if (!visitedUrls.has(nestedCandidate.url)) {
          queue.push({ candidate: nestedCandidate, depth: depth + 1 });
        }
      }

      if (nestedCandidates.length > 0) {
        this.emitProgress({
          message: `Discovered ${nestedCandidates.length} nested candidate(s) from ${artifact.url}`,
          url: artifact.url,
          type: artifact.type,
          depth,
        });
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

  private async discoverSupplementalPages(rootOrigin: string): Promise<ArtifactCandidate[]> {
    const candidates = new Map<string, ArtifactCandidate>();
    const directSitemapUrl = new URL("/sitemap.xml", rootOrigin).toString();
    const robotsUrl = new URL("/robots.txt", rootOrigin).toString();

    const robotsText = await this.fetchOptionalText(robotsUrl);
    const sitemapUrls = new Set<string>([directSitemapUrl]);

    if (robotsText) {
      for (const sitemapUrl of parseRobotsSitemaps(robotsText)) {
        try {
          const normalizedUrl = new URL(sitemapUrl, rootOrigin).toString();
          if (new URL(normalizedUrl).origin === rootOrigin) {
            sitemapUrls.add(normalizedUrl);
          }
        } catch {
          continue;
        }
      }
    }

    for (const sitemapUrl of sitemapUrls) {
      const sitemapXml = await this.fetchOptionalText(sitemapUrl);
      if (!sitemapXml) {
        continue;
      }

      for (const candidate of parseSitemapXml(sitemapXml, rootOrigin)) {
        candidates.set(candidate.url, candidate);
      }
    }

    return [...candidates.values()];
  }

  private async fetchArtifact(candidate: ArtifactCandidate, depth: number, required: boolean): Promise<DiscoveredArtifact | null> {
    const response = await this.fetchResponse(candidate.url, candidate.type, depth, required);
    if (!response) {
      return null;
    }

    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";

    if (isIgnoredContentType(contentType)) {
      this.emitProgress({
        message: `Skipping binary or font asset returned from ${candidate.url}`,
        url: candidate.url,
        type: candidate.type,
        depth,
      });
      return null;
    }

    if (candidate.type === "html" && !contentType.includes("text/html") && !contentType.includes("application/xhtml+xml")) {
      this.emitProgress({
        message: `Skipping non-HTML response for discovered page ${candidate.url}`,
        url: candidate.url,
        type: candidate.type,
        depth,
      });
      return null;
    }

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

    const rawContent = await response.text();
    const resolvedType = contentType.includes("text/html")
      ? "html"
      : contentType.includes("application/json") && candidate.type === "source-map"
        ? "source-map"
        : candidate.type;

    const content = resolvedType === "source-map" ? summarizeSourceMap(rawContent, candidate.url) : rawContent;

    return discoveredArtifactSchema.parse({
      url: candidate.url,
      type: resolvedType,
      sizeBytes: Buffer.byteLength(content, "utf8"),
      content,
      discoveredFrom: candidate.discoveredFrom,
    });
  }

  private async fetchResponse(
    url: string,
    artifactType: ArtifactCandidate["type"],
    depth: number,
    required: boolean,
  ): Promise<Response | null> {
    try {
      const response = await this.fetcher(url, {
        headers: {
          "user-agent": MAPR_USER_AGENT,
        },
      });

      if (!response.ok) {
        if (required) {
          throw new Error(`Failed to fetch ${artifactType} from ${url}: ${response.status} ${response.statusText}`);
        }

        this.emitProgress({
          message: `Skipping ${artifactType} after ${response.status} ${response.statusText}: ${url}`,
          url,
          type: artifactType,
          depth,
        });
        return null;
      }

      return response;
    } catch (error) {
      if (!required) {
        this.emitProgress({
          message: `Skipping ${artifactType} after fetch error: ${url}`,
          url,
          type: artifactType,
          depth,
        });
        return null;
      }

      if (error instanceof Error) {
        throw new Error(`Unable to fetch ${artifactType} artifact ${url}: ${error.message}`);
      }

      throw new Error(`Unable to fetch ${artifactType} artifact ${url}.`);
    }
  }

  private async fetchOptionalText(url: string): Promise<string | null> {
    try {
      const response = await this.fetcher(url, {
        headers: {
          "user-agent": MAPR_USER_AGENT,
        },
      });

      if (!response.ok) {
        return null;
      }

      return await response.text();
    } catch {
      return null;
    }
  }

  private emitProgress(event: ScraperProgressEvent): void {
    this.onProgress?.(event);
  }

  private filterNestedCandidates(
    candidates: ArtifactCandidate[],
    entryUrl: string,
    crawlScope: CrawlScope,
  ): ArtifactCandidate[] {
    if (crawlScope === "site") {
      return candidates;
    }

    const entryPath = new URL(entryUrl).pathname.toLowerCase();
    const entryStem = entryPath.replace(/(?:index)?\.html?$/i, "").replace(/\/+$/, "") || entryPath;
    const entryDirectory = entryPath.includes("/") ? entryPath.slice(0, entryPath.lastIndexOf("/") + 1) : "/";

    return candidates.filter((candidate) => {
      if (candidate.type !== "html") {
        return true;
      }

      const discoveredFrom = candidate.discoveredFrom.toLowerCase();
      if (discoveredFrom.includes("iframe")) {
        return true;
      }

      const candidatePath = new URL(candidate.url).pathname.toLowerCase();
      if (discoveredFrom.includes("form")) {
        return isAuthLikePathname(candidatePath);
      }

      if (candidatePath === entryPath) {
        return true;
      }

      if (entryDirectory !== "/") {
        return candidatePath.startsWith(entryDirectory);
      }

      if (entryStem !== entryPath && candidatePath.startsWith(entryStem)) {
        return true;
      }

      if (candidatePath.startsWith(`${entryPath}/`)) {
        return true;
      }

      return false;
    });
  }
}

export { extractArtifactCandidates };
