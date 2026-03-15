import type { AgentMemo, ChunkAnalysis } from "./analysis-schema";
import type { SwarmAgentName } from "./swarm-prompts";

export function createFallbackAgentMemo(agent: Exclude<SwarmAgentName, "synthesizer">, error: Error): AgentMemo {
  return {
    role: agent,
    summary: `${agent} agent failed after retries: ${error.message}`,
    observations: [],
    evidence: [],
    nextQuestions: [`Retry ${agent} analysis for this chunk manually if the finding is important.`],
  };
}

export function createFallbackChunkAnalysis(input: {
  artifactUrl: string;
  memory: Partial<Record<SwarmAgentName, unknown>>;
  error: Error;
}): ChunkAnalysis {
  const memoSummaries = Object.values(input.memory)
    .filter((entry): entry is AgentMemo => typeof entry === "object" && entry !== null && "summary" in entry)
    .map((entry) => entry.summary.trim())
    .filter(Boolean);

  return {
    entryPoints: [],
    initializationFlow: [],
    callGraph: [],
    restoredNames: [],
    summary:
      memoSummaries.join(" ").trim() ||
      `Chunk analysis for ${input.artifactUrl} fell back after retries: ${input.error.message}`,
    notableLibraries: [],
    investigationTips: [
      `Chunk synthesis fell back after retries: ${input.error.message}`,
      "Re-run with lower concurrency or inspect this chunk manually if it is critical.",
    ],
    risks: [],
  };
}
