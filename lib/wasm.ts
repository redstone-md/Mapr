import { z } from "zod";

const wasmInputSchema = z.object({
  url: z.string().url(),
  bytes: z.instanceof(Uint8Array),
});

function extractPrintableStrings(bytes: Uint8Array): string[] {
  const matches = new Set<string>();
  let current = "";

  for (const byte of bytes) {
    if (byte >= 32 && byte <= 126) {
      current += String.fromCharCode(byte);
      continue;
    }

    if (current.length >= 4) {
      matches.add(current);
    }

    current = "";
  }

  if (current.length >= 4) {
    matches.add(current);
  }

  return [...matches].slice(0, 20);
}

export class WasmModuleSummarizer {
  public summarize(input: { url: string; bytes: Uint8Array }): string {
    const validatedInput = wasmInputSchema.parse(input);

    try {
      const module = new WebAssembly.Module(validatedInput.bytes);
      const imports = WebAssembly.Module.imports(module);
      const exports = WebAssembly.Module.exports(module);
      const embeddedStrings = extractPrintableStrings(validatedInput.bytes);

      return [
        `WASM module: ${validatedInput.url}`,
        `Byte size: ${validatedInput.bytes.byteLength}`,
        `Imports: ${
          imports.length > 0
            ? imports.map((entry) => `${entry.module}.${entry.name} (${entry.kind})`).join(", ")
            : "none"
        }`,
        `Exports: ${exports.length > 0 ? exports.map((entry) => `${entry.name} (${entry.kind})`).join(", ") : "none"}`,
        `Embedded strings: ${embeddedStrings.length > 0 ? embeddedStrings.join(", ") : "none"}`,
      ].join("\n");
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown error";
      return [
        `WASM module: ${validatedInput.url}`,
        `Byte size: ${validatedInput.bytes.byteLength}`,
        `Binary summary unavailable: ${message}`,
      ].join("\n");
    }
  }
}
