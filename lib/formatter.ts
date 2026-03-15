import { Buffer } from "buffer";
import * as prettier from "prettier";
import { z } from "zod";

import type { ScriptBundle } from "./scraper";

export const DEFAULT_MAX_FORMAT_BYTES = 2 * 1024 * 1024;

const formatterOptionsSchema = z.object({
  maxFormatBytes: z.number().int().positive().default(DEFAULT_MAX_FORMAT_BYTES),
});

const formattedBundleSchema = z.object({
  url: z.string().url(),
  rawCode: z.string(),
  formattedCode: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  formattingSkipped: z.boolean(),
  formattingNote: z.string().optional(),
});

export type FormattedBundle = z.infer<typeof formattedBundleSchema>;

type FormatterOptions = z.input<typeof formatterOptionsSchema>;

export class BundleFormatter {
  private readonly options: z.infer<typeof formatterOptionsSchema>;

  public constructor(options: FormatterOptions = {}) {
    this.options = formatterOptionsSchema.parse(options);
  }

  public async formatBundles(bundles: ScriptBundle[]): Promise<FormattedBundle[]> {
    return Promise.all(bundles.map((bundle) => this.formatBundle(bundle)));
  }

  public async formatBundle(bundle: ScriptBundle): Promise<FormattedBundle> {
    const validatedBundle = z
      .object({
        url: z.string().url(),
        rawCode: z.string(),
        sizeBytes: z.number().int().nonnegative(),
      })
      .parse(bundle);

    if (validatedBundle.sizeBytes > this.options.maxFormatBytes) {
      return formattedBundleSchema.parse({
        ...validatedBundle,
        formattedCode: validatedBundle.rawCode,
        formattingSkipped: true,
        formattingNote: `Skipped formatting because the bundle exceeded ${this.options.maxFormatBytes} bytes.`,
      });
    }

    try {
      const formattedCode = await prettier.format(validatedBundle.rawCode, {
        parser: "babel",
        printWidth: 100,
        tabWidth: 2,
      });

      return formattedBundleSchema.parse({
        ...validatedBundle,
        formattedCode,
        formattingSkipped: false,
      });
    } catch (primaryError) {
      try {
        const formattedCode = await prettier.format(validatedBundle.rawCode, {
          parser: "babel-ts",
          printWidth: 100,
          tabWidth: 2,
        });

        return formattedBundleSchema.parse({
          ...validatedBundle,
          formattedCode,
          formattingSkipped: false,
        });
      } catch {
        const primaryMessage = primaryError instanceof Error ? primaryError.message : "formatter error";
        return formattedBundleSchema.parse({
          ...validatedBundle,
          formattedCode: validatedBundle.rawCode,
          formattingSkipped: true,
          formattingNote: `Formatting failed and raw code was preserved: ${primaryMessage}`,
        });
      }
    }
  }

  public getSizeInBytes(source: string): number {
    return Buffer.byteLength(z.string().parse(source), "utf8");
  }
}
