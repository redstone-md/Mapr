import * as prettier from "prettier";
import { z } from "zod";

import { artifactTypeSchema, type DiscoveredArtifact } from "./artifacts";

export const DEFAULT_MAX_FORMAT_BYTES = 2 * 1024 * 1024;

const formatterOptionsSchema = z.object({
  maxFormatBytes: z.number().int().positive().default(DEFAULT_MAX_FORMAT_BYTES),
});

const formattedArtifactSchema = z.object({
  url: z.string().url(),
  type: artifactTypeSchema,
  content: z.string(),
  formattedContent: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  discoveredFrom: z.string().min(1),
  formattingSkipped: z.boolean(),
  formattingNote: z.string().optional(),
});

export type FormattedArtifact = z.infer<typeof formattedArtifactSchema>;

type FormatterOptions = z.input<typeof formatterOptionsSchema>;

function resolvePrettierParser(artifactType: FormattedArtifact["type"]): "babel" | "babel-ts" | "html" | "css" | "json" | null {
  switch (artifactType) {
    case "html":
      return "html";
    case "stylesheet":
      return "css";
    case "manifest":
    case "json":
      return "json";
    case "script":
    case "service-worker":
    case "worker":
      return "babel";
    case "wasm":
      return null;
  }
}

export class BundleFormatter {
  private readonly options: z.infer<typeof formatterOptionsSchema>;

  public constructor(options: FormatterOptions = {}) {
    this.options = formatterOptionsSchema.parse(options);
  }

  public async formatArtifacts(artifacts: DiscoveredArtifact[]): Promise<FormattedArtifact[]> {
    return Promise.all(artifacts.map((artifact) => this.formatArtifact(artifact)));
  }

  public async formatArtifact(artifact: DiscoveredArtifact): Promise<FormattedArtifact> {
    const validatedArtifact = z
      .object({
        url: z.string().url(),
        type: artifactTypeSchema,
        content: z.string(),
        sizeBytes: z.number().int().nonnegative(),
        discoveredFrom: z.string().min(1),
      })
      .parse(artifact);

    if (validatedArtifact.sizeBytes > this.options.maxFormatBytes) {
      return formattedArtifactSchema.parse({
        ...validatedArtifact,
        formattedContent: validatedArtifact.content,
        formattingSkipped: true,
        formattingNote: `Skipped formatting because the artifact exceeded ${this.options.maxFormatBytes} bytes.`,
      });
    }

    const parser = resolvePrettierParser(validatedArtifact.type);
    if (!parser) {
      return formattedArtifactSchema.parse({
        ...validatedArtifact,
        formattedContent: validatedArtifact.content,
        formattingSkipped: false,
        formattingNote: "Binary artifact summarized without additional formatting.",
      });
    }

    try {
      const formattedContent = await prettier.format(validatedArtifact.content, {
        parser,
        printWidth: 100,
        tabWidth: 2,
      });

      return formattedArtifactSchema.parse({
        ...validatedArtifact,
        formattedContent,
        formattingSkipped: false,
      });
    } catch (primaryError) {
      if (parser === "babel") {
        try {
          const formattedContent = await prettier.format(validatedArtifact.content, {
            parser: "babel-ts",
            printWidth: 100,
            tabWidth: 2,
          });

          return formattedArtifactSchema.parse({
            ...validatedArtifact,
            formattedContent,
            formattingSkipped: false,
          });
        } catch {
          const message = primaryError instanceof Error ? primaryError.message : "formatter error";
          return formattedArtifactSchema.parse({
            ...validatedArtifact,
            formattedContent: validatedArtifact.content,
            formattingSkipped: true,
            formattingNote: `Formatting failed and raw content was preserved: ${message}`,
          });
        }
      }

      const message = primaryError instanceof Error ? primaryError.message : "formatter error";
      return formattedArtifactSchema.parse({
        ...validatedArtifact,
        formattedContent: validatedArtifact.content,
        formattingSkipped: true,
        formattingNote: `Formatting failed and raw content was preserved: ${message}`,
      });
    }
  }
}
