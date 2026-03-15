import * as cheerio from "cheerio";
import { z } from "zod";

export const artifactTypeSchema = z.enum([
  "html",
  "script",
  "service-worker",
  "worker",
  "stylesheet",
  "manifest",
  "json",
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

  if (pathname.endsWith(".css")) {
    return "stylesheet";
  }

  if (pathname.endsWith(".json")) {
    return "json";
  }

  if (pathname.endsWith(".webmanifest") || pathname.endsWith("manifest.json")) {
    return "manifest";
  }

  if (pathname.endsWith(".html") || pathname.endsWith(".htm")) {
    return "html";
  }

  return fallback;
}

function extractFromJavaScript(source: string, baseUrl: string, discoveredFrom: string): ArtifactCandidate[] {
  const candidates = new Map<string, ArtifactCandidate>();
  const regexDefinitions: Array<{ regex: RegExp; type: ArtifactType }> = [
    { regex: /(?:import|export)\s+(?:[^"'`]+?\s+from\s+)?["'`]([^"'`]+)["'`]/g, type: "script" },
    { regex: /import\(\s*["'`]([^"'`]+)["'`]\s*\)/g, type: "script" },
    { regex: /navigator\.serviceWorker\.register\(\s*(?:new\s+URL\(\s*)?["'`]([^"'`]+)["'`]/g, type: "service-worker" },
    { regex: /new\s+(?:SharedWorker|Worker)\(\s*(?:new\s+URL\(\s*)?["'`]([^"'`]+)["'`]/g, type: "worker" },
    { regex: /["'`]([^"'`]+\.wasm(?:\?[^"'`]*)?)["'`]/g, type: "wasm" },
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

function extractFromCss(source: string, baseUrl: string, discoveredFrom: string): ArtifactCandidate[] {
  const candidates = new Map<string, ArtifactCandidate>();
  const regexDefinitions = [
    /@import\s+(?:url\()?["']?([^"'()]+)["']?\)?/g,
    /url\(\s*["']?([^"'()]+)["']?\s*\)/g,
  ];

  for (const regex of regexDefinitions) {
    let match: RegExpExecArray | null;
    while ((match = regex.exec(source)) !== null) {
      const resolvedUrl = resolveCandidateUrl(match[1] ?? "", baseUrl);
      if (!resolvedUrl) {
        continue;
      }

      addCandidate(
        candidates,
        makeCandidate(resolvedUrl, inferAssetTypeFromUrl(resolvedUrl, "stylesheet"), discoveredFrom),
        false,
        new URL(baseUrl).origin,
      );
    }
  }

  return [...candidates.values()];
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

    if (rel.includes("manifest")) {
      addCandidate(candidates, makeCandidate(href, "manifest", "html:manifest"), false, origin);
      return;
    }

    if (rel.includes("stylesheet")) {
      addCandidate(candidates, makeCandidate(href, "stylesheet", "html:stylesheet"), false, origin);
      return;
    }

    if (rel.includes("modulepreload") || (rel.includes("preload") && asValue === "script")) {
      addCandidate(candidates, makeCandidate(href, "script", "html:preload"), false, origin);
    }
  });

  $("a[href]").each((_, element) => {
    const href = resolveCandidateUrl($(element).attr("href")?.trim() ?? "", pageUrl);
    if (!href) {
      return;
    }

    const url = new URL(href);
    const isSameOrigin = url.origin === origin;
    const pathname = url.pathname.toLowerCase();
    const looksLikePage =
      pathname === "" ||
      pathname.endsWith("/") ||
      pathname.endsWith(".html") ||
      pathname.endsWith(".htm") ||
      !/\.[a-z0-9]+$/i.test(pathname);

    if (isSameOrigin && looksLikePage) {
      addCandidate(candidates, makeCandidate(href, "html", "html:anchor"), true, origin);
    }
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

  if (artifact.type === "script" || artifact.type === "service-worker" || artifact.type === "worker") {
    return extractFromJavaScript(artifact.content, artifact.url, `${artifact.type}:code`);
  }

  if (artifact.type === "stylesheet") {
    return extractFromCss(artifact.content, artifact.url, "stylesheet:code");
  }

  return [];
}
