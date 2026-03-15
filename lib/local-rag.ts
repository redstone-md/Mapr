import { z } from "zod";

import type { FormattedArtifact } from "./formatter";

const ragOptionsSchema = z.object({
  segmentBytes: z.number().int().positive().default(16 * 1024),
  maxResults: z.number().int().positive().default(3),
});

const tokenPattern = /[a-zA-Z0-9_$.-]{2,}/g;

interface RagSegment {
  artifactUrl: string;
  segmentIndex: number;
  content: string;
  tokenWeights: Map<string, number>;
}

function tokenize(source: string): string[] {
  return (source.toLowerCase().match(tokenPattern) ?? []).slice(0, 4000);
}

function toTokenWeights(source: string): Map<string, number> {
  const weights = new Map<string, number>();

  for (const token of tokenize(source)) {
    weights.set(token, (weights.get(token) ?? 0) + 1);
  }

  return weights;
}

function segmentContent(source: string, segmentBytes: number): string[] {
  if (source.length === 0) {
    return [];
  }

  const segments: string[] = [];
  let cursor = 0;

  while (cursor < source.length) {
    const nextCursor = Math.min(source.length, cursor + segmentBytes);
    segments.push(source.slice(cursor, nextCursor));
    cursor = nextCursor;
  }

  return segments;
}

function scoreSegment(queryWeights: Map<string, number>, segmentWeights: Map<string, number>): number {
  let score = 0;

  for (const [token, queryWeight] of queryWeights.entries()) {
    score += queryWeight * (segmentWeights.get(token) ?? 0);
  }

  return score;
}

export interface LocalRagQuery {
  artifactUrl: string;
  query: string;
  excludeContent?: string;
}

export class LocalArtifactRag {
  private readonly options: z.infer<typeof ragOptionsSchema>;
  private readonly segmentsByArtifact = new Map<string, RagSegment[]>();

  public constructor(artifacts: FormattedArtifact[], options: z.input<typeof ragOptionsSchema> = {}) {
    this.options = ragOptionsSchema.parse(options);

    for (const artifact of artifacts) {
      const segments = segmentContent(artifact.formattedContent || artifact.content, this.options.segmentBytes).map(
        (content, segmentIndex) => ({
          artifactUrl: artifact.url,
          segmentIndex,
          content,
          tokenWeights: toTokenWeights(content),
        }),
      );

      this.segmentsByArtifact.set(artifact.url, segments);
    }
  }

  public query(input: LocalRagQuery): string[] {
    const queryWeights = toTokenWeights(input.query);
    const segments = this.segmentsByArtifact.get(input.artifactUrl) ?? [];
    const excludeSnippet = input.excludeContent?.slice(0, 256);

    return segments
      .filter((segment) => !excludeSnippet || !segment.content.includes(excludeSnippet))
      .map((segment) => ({
        score: scoreSegment(queryWeights, segment.tokenWeights),
        content: segment.content,
        segmentIndex: segment.segmentIndex,
      }))
      .filter((entry) => entry.score > 0)
      .sort((left, right) => right.score - left.score || left.segmentIndex - right.segmentIndex)
      .slice(0, this.options.maxResults)
      .map((entry) => entry.content);
  }
}
