import * as cheerio from "cheerio";
import { z } from "zod";

export const artifactTypeSchema = z.enum([
  "html",
  "script",
  "service-worker",
  "worker",
  "source-map",
  "wasm",
]);

export const analyzableArtifactTypeSchema = z.enum([
  "script",
  "service-worker",
  "worker",
  "source-map",
  "wasm",
]);

export const discoveredArtifactSchema = z.object({
  url: z.string().url(),
  type: artifactTypeSchema,
  sizeBytes: z.number().int().nonnegative(),
  content: z.string(),
  discoveredFrom: z.string().min(1),
});

export const artifactCandidateSchema = z.object({
  url: z.string().url(),
  type: artifactTypeSchema,
  discoveredFrom: z.string().min(1),
});

export type ArtifactType = z.infer<typeof artifactTypeSchema>;
export type DiscoveredArtifact = z.infer<typeof discoveredArtifactSchema>;
export type ArtifactCandidate = z.infer<typeof artifactCandidateSchema>;

const binaryOrVisualAssetPattern =
  /\.(?:png|jpe?g|gif|webp|avif|svg|ico|bmp|tiff?|mp4|webm|mov|avi|mp3|wav|ogg|flac|aac|m4a|pdf|zip|gz|tar|7z|rar|woff2?|ttf|otf|eot)(?:$|[?#])/i;

function makeCandidate(url: string, type: ArtifactType, discoveredFrom: string): ArtifactCandidate | null {
  const parsed = artifactCandidateSchema.safeParse({ url, type, discoveredFrom });
  return parsed.success ? parsed.data : null;
}

function addCandidate(
  candidates: Map<string, ArtifactCandidate>,
  candidate: ArtifactCandidate | null,
  restrictToSameOrigin: boolean,
  origin: string,
): void {
  if (!candidate) {
    return;
  }

  if (restrictToSameOrigin && new URL(candidate.url).origin !== origin) {
    return;
  }

  if (!candidates.has(candidate.url)) {
    candidates.set(candidate.url, candidate);
  }
}

function resolveCandidateUrl(reference: string, baseUrl: string): string | null {
  if (!reference || reference.startsWith("data:") || reference.startsWith("blob:") || reference.startsWith("#")) {
    return null;
  }

  try {
    const absoluteUrl = new URL(reference, baseUrl).toString();
    if (binaryOrVisualAssetPattern.test(new URL(absoluteUrl).pathname)) {
      return null;
    }

    const parsed = z.string().url().safeParse(absoluteUrl);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function inferAssetTypeFromUrl(url: string, fallback: ArtifactType = "script"): ArtifactType {
  const pathname = new URL(url).pathname.toLowerCase();

  if (pathname.endsWith(".wasm")) {
    return "wasm";
  }

  if (pathname.endsWith(".map")) {
    return "source-map";
  }

  if (pathname.endsWith(".html") || pathname.endsWith(".htm")) {
    return "html";
  }

  return fallback;
}

function extractPageCandidate(reference: string, pageUrl: string, discoveredFrom: string): ArtifactCandidate | null {
  const resolvedUrl = resolveCandidateUrl(reference, pageUrl);
  if (!resolvedUrl) {
    return null;
  }

  const pathname = new URL(resolvedUrl).pathname.toLowerCase();
  const looksLikePage =
    pathname === "" ||
    pathname.endsWith("/") ||
    pathname.endsWith(".html") ||
    pathname.endsWith(".htm") ||
    !/\.[a-z0-9]+$/i.test(pathname);

  return looksLikePage ? makeCandidate(resolvedUrl, "html", discoveredFrom) : null;
}

function extractFromJavaScript(source: string, baseUrl: string, discoveredFrom: string): ArtifactCandidate[] {
  const candidates = new Map<string, ArtifactCandidate>();
  const regexDefinitions: Array<{ regex: RegExp; type: ArtifactType }> = [
    { regex: /(?:import|export)\s+(?:[^"'`]+?\s+from\s+)?["'`]([^"'`]+)["'`]/g, type: "script" },
    { regex: /import\(\s*["'`]([^"'`]+)["'`]\s*\)/g, type: "script" },
    { regex: /importScripts\(\s*["'`]([^"'`]+)["'`]\s*\)/g, type: "script" },
    { regex: /navigator\.serviceWorker\.register\(\s*(?:new\s+URL\(\s*)?["'`]([^"'`]+)["'`]/g, type: "service-worker" },
    { regex: /new\s+(?:SharedWorker|Worker)\(\s*(?:new\s+URL\(\s*)?["'`]([^"'`]+)["'`]/g, type: "worker" },
    { regex: /new\s+URL\(\s*["'`]([^"'`]+)["'`]\s*,\s*import\.meta\.url\s*\)/g, type: "script" },
    { regex: /["'`]([^"'`]+\.(?:m?js|cjs|wasm|map)(?:\?[^"'`]*)?)["'`]/g, type: "script" },
    { regex: /[@#]\s*sourceMappingURL=([^\s]+)/g, type: "source-map" },
  ];

  for (const definition of regexDefinitions) {
    let match: RegExpExecArray | null;
    while ((match = definition.regex.exec(source)) !== null) {
      const resolvedUrl = resolveCandidateUrl(match[1] ?? "", baseUrl);
      if (!resolvedUrl) {
        continue;
      }

      addCandidate(
        candidates,
        makeCandidate(resolvedUrl, inferAssetTypeFromUrl(resolvedUrl, definition.type), discoveredFrom),
        false,
        new URL(baseUrl).origin,
      );
    }
  }

  return [...candidates.values()];
}

export function isAnalyzableArtifactType(type: ArtifactType): type is z.infer<typeof analyzableArtifactTypeSchema> {
  return analyzableArtifactTypeSchema.safeParse(type).success;
}

export function extractArtifactCandidates(html: string, pageUrl: string): ArtifactCandidate[] {
  const $ = cheerio.load(html);
  const candidates = new Map<string, ArtifactCandidate>();
  const origin = new URL(pageUrl).origin;

  $("script[src]").each((_, element) => {
    const src = resolveCandidateUrl($(element).attr("src")?.trim() ?? "", pageUrl);
    addCandidate(candidates, makeCandidate(src ?? "", "script", "html:script"), false, origin);
  });

  $("link[href]").each((_, element) => {
    const href = resolveCandidateUrl($(element).attr("href")?.trim() ?? "", pageUrl);
    if (!href) {
      return;
    }

    const rel = ($(element).attr("rel") ?? "").toLowerCase();
    const asValue = ($(element).attr("as") ?? "").toLowerCase();

    if (rel.includes("modulepreload") || (rel.includes("preload") && asValue === "script")) {
      addCandidate(candidates, makeCandidate(href, inferAssetTypeFromUrl(href, "script"), "html:preload"), false, origin);
    }
  });

  $("a[href], iframe[src], form[action]").each((_, element) => {
    const attributeName = element.tagName === "iframe" ? "src" : element.tagName === "form" ? "action" : "href";
    const pageCandidate = extractPageCandidate($(element).attr(attributeName)?.trim() ?? "", pageUrl, `html:${element.tagName}`);
    addCandidate(candidates, pageCandidate, true, origin);
  });

  $("script:not([src])").each((_, element) => {
    const inlineSource = $(element).html() ?? "";
    for (const candidate of extractFromJavaScript(inlineSource, pageUrl, "html:inline-script")) {
      addCandidate(candidates, candidate, false, origin);
    }
  });

  return [...candidates.values()];
}

export function extractNestedCandidates(artifact: DiscoveredArtifact): ArtifactCandidate[] {
  if (artifact.type === "html") {
    return extractArtifactCandidates(artifact.content, artifact.url);
  }

  if (
    artifact.type === "script" ||
    artifact.type === "service-worker" ||
    artifact.type === "worker" ||
    artifact.type === "source-map"
  ) {
    return extractFromJavaScript(artifact.content, artifact.url, `${artifact.type}:code`);
  }

  return [];
}
