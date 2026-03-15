import * as prettier from "prettier";
import { z } from "zod";

import { artifactTypeSchema, type DiscoveredArtifact } from "./artifacts";

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

function resolvePrettierParser(artifactType: FormattedArtifact["type"]): "babel" | "babel-ts" | "html" | "css" | "json" | null {
  switch (artifactType) {
    case "html":
      return "html";
    case "source-map":
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
