import { Window } from "happy-dom";
import { z } from "zod";

export const domFormSnapshotSchema = z.object({
  action: z.string(),
  method: z.string(),
  inputNames: z.array(z.string()),
  inputTypes: z.array(z.string()),
  submitLabels: z.array(z.string()),
});

export const domPageSnapshotSchema = z.object({
  url: z.string().url(),
  title: z.string(),
  headings: z.array(z.string()),
  description: z.string().optional(),
  forms: z.array(domFormSnapshotSchema),
  buttons: z.array(z.string()),
  links: z.array(z.string()),
  iframes: z.array(z.string().url()),
  inlineStateHints: z.array(z.string()),
  dataAttributeKeys: z.array(z.string()),
  summary: z.string(),
});

export type DomPageSnapshot = z.infer<typeof domPageSnapshotSchema>;

function normalizeText(value: string | null | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > 0 ? normalized : undefined;
}

function extractControlLabel(element: { textContent: string | null; getAttribute(name: string): string | null } & Partial<{ value: string }>): string | undefined {
  return normalizeText(element.value) ?? normalizeText(element.textContent) ?? normalizeText(element.getAttribute("aria-label"));
}

type ElementLike = {
  textContent: string | null;
  getAttribute(name: string): string | null;
  dataset?: Record<string, string>;
};

type ParentLike = ElementLike & {
  getElementsByTagName(tagName: string): Iterable<ElementLike>;
};

function getElementsByTags(root: { getElementsByTagName(tagName: string): Iterable<ElementLike> }, tagNames: string[]): ElementLike[] {
  return tagNames.flatMap((tagName) => [...root.getElementsByTagName(tagName)]);
}

function toAbsoluteUrl(candidate: string | null, baseUrl: string): string | undefined {
  if (!candidate) {
    return undefined;
  }

  try {
    return new URL(candidate, baseUrl).toString();
  } catch {
    return undefined;
  }
}

function extractInlineStateHints(html: string): string[] {
  const hints = new Set<string>();
  const jsonScriptPattern = /<script[^>]*type=["']application\/(?:ld\+json|json)["'][^>]*?(?:id=["']([^"']+)["'])?[^>]*>/gi;
  const windowKeyPattern = /(?:window|globalThis|self)\.([A-Z_$][A-Z0-9_$]{2,})/g;
  let match: RegExpExecArray | null;

  while ((match = jsonScriptPattern.exec(html)) !== null) {
    if (match[1]) {
      hints.add(`json-script:${match[1]}`);
    } else {
      hints.add("json-script:inline");
    }
  }

  while ((match = windowKeyPattern.exec(html)) !== null) {
    if (match[1]) {
      hints.add(`global:${match[1]}`);
    }
  }

  return [...hints].sort().slice(0, 20);
}

function summarizeSnapshot(input: Omit<DomPageSnapshot, "summary">): string {
  const parts = [
    input.title ? `title "${input.title}"` : undefined,
    input.headings.length > 0 ? `${input.headings.length} heading(s)` : undefined,
    input.forms.length > 0 ? `${input.forms.length} form(s)` : undefined,
    input.buttons.length > 0 ? `${input.buttons.length} button label(s)` : undefined,
    input.iframes.length > 0 ? `${input.iframes.length} iframe(s)` : undefined,
    input.inlineStateHints.length > 0 ? `${input.inlineStateHints.length} inline state hint(s)` : undefined,
  ].filter((value): value is string => value !== undefined);

  return parts.join(", ") || "Minimal DOM surface detected.";
}

export class DomSnapshotBuilder {
  public build(html: string, pageUrl: string): DomPageSnapshot {
    const window = new Window({
      url: pageUrl,
      settings: {
        disableJavaScriptEvaluation: true,
        disableJavaScriptFileLoading: true,
      },
    });
    const document = window.document;
    document.write(html);
    const headings = getElementsByTags(document, ["h1", "h2", "h3"])
      .map((element) => normalizeText(element.textContent))
      .filter((value): value is string => value !== undefined)
      .slice(0, 12);
    const buttons = [
      ...getElementsByTags(document, ["button"]),
      ...getElementsByTags(document, ["input"]).filter((element) => ["submit", "button"].includes((element.getAttribute("type") ?? "").toLowerCase())),
    ]
      .map((element) => extractControlLabel(element as ElementLike & Partial<{ value: string }>))
      .filter((value): value is string => value !== undefined)
      .slice(0, 20);
    const links = getElementsByTags(document, ["a"])
      .filter((element) => normalizeText(element.getAttribute("href")) !== undefined)
      .map((element) => normalizeText(element.textContent) ?? normalizeText(element.getAttribute("aria-label")))
      .filter((value): value is string => value !== undefined)
      .slice(0, 20);
    const iframes = getElementsByTags(document, ["iframe"])
      .filter((element) => normalizeText(element.getAttribute("src")) !== undefined)
      .map((element) => toAbsoluteUrl(element.getAttribute("src"), pageUrl))
      .filter((value): value is string => value !== undefined)
      .slice(0, 10);
    const dataAttributeKeys = getElementsByTags(document, ["*"])
      .flatMap((element) => Object.keys(element.dataset ?? {}))
      .map((key) => `data-${key.replace(/[A-Z]/g, (match) => `-${match.toLowerCase()}`)}`)
      .filter((value, index, array) => array.indexOf(value) === index)
      .slice(0, 24);
    const forms = getElementsByTags(document, ["form"]).map((form) => {
      const formNode = form as unknown as ParentLike;
      const inputNames = [
        ...getElementsByTags(formNode, ["input"]),
        ...getElementsByTags(formNode, ["textarea", "select"]),
      ]
        .filter((element) => normalizeText(element.getAttribute("name")) !== undefined)
        .map((element) => normalizeText(element.getAttribute("name")))
        .filter((value): value is string => value !== undefined)
        .slice(0, 20);
      const inputTypes = getElementsByTags(formNode, ["input"])
        .filter((element) => normalizeText(element.getAttribute("type")) !== undefined)
        .map((element) => normalizeText(element.getAttribute("type")))
        .filter((value): value is string => value !== undefined)
        .slice(0, 20);
      const submitLabels = [
        ...getElementsByTags(formNode, ["button"]),
        ...getElementsByTags(formNode, ["input"]).filter(
          (element) => (element.getAttribute("type") ?? "").toLowerCase() === "submit",
        ),
      ]
        .map((element) => extractControlLabel(element as ElementLike & Partial<{ value: string }>))
        .filter((value): value is string => value !== undefined)
        .slice(0, 8);

      return {
        action: toAbsoluteUrl(form.getAttribute("action"), pageUrl) ?? pageUrl,
        method: normalizeText(form.getAttribute("method"))?.toUpperCase() ?? "GET",
        inputNames,
        inputTypes,
        submitLabels,
      };
    });

    const snapshot = {
      url: pageUrl,
      title: normalizeText(document.title) ?? "",
      headings,
      ...(normalizeText(getElementsByTags(document, ["meta"]).find((element) => (element.getAttribute("name") ?? "").toLowerCase() === "description")?.getAttribute("content")) !== undefined
        ? { description: normalizeText(getElementsByTags(document, ["meta"]).find((element) => (element.getAttribute("name") ?? "").toLowerCase() === "description")?.getAttribute("content"))! }
        : {}),
      forms,
      buttons,
      links,
      iframes,
      inlineStateHints: extractInlineStateHints(html),
      dataAttributeKeys,
    };

    return domPageSnapshotSchema.parse({
      ...snapshot,
      summary: summarizeSnapshot(snapshot),
    });
  }
}
