import { describe, expect, test } from "bun:test";
import { Buffer } from "buffer";

import { chunkTextByBytes } from "../lib/ai-analyzer";

describe("chunkTextByBytes", () => {
  test("returns a single chunk when input fits within the byte limit", () => {
    const source = "const ready = true;";
    const chunks = chunkTextByBytes(source, 1024);

    expect(chunks).toEqual([source]);
  });

  test("splits long text into chunks that stay within the requested limit", () => {
    const source = [
      "function boot(){console.log('boot');}\n",
      "function hydrate(){console.log('hydrate');}\n",
      "function mount(){console.log('mount');}\n",
      "boot();hydrate();mount();",
    ].join("");

    const chunks = chunkTextByBytes(source, 50);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join("")).toBe(source);

    for (const chunk of chunks) {
      expect(Buffer.byteLength(chunk, "utf8")).toBeLessThanOrEqual(50);
    }
  });
});
