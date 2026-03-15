import type { FormattedArtifact } from "./formatter";
import type { SwarmAgentName } from "./swarm-prompts";
import { SWARM_AGENT_ORDER } from "./swarm-prompts";
import { extractPathTokens, isAuthLikePathname, isLowSignalPathname } from "./url-patterns";

export type AnalysisPriority = "high" | "medium" | "low";

export interface ArtifactAnalysisPlan {
  priority: AnalysisPriority;
  score: number;
}

type ArtifactLike = Pick<FormattedArtifact, "url" | "type" | "discoveredFrom" | "sizeBytes">;

function isThirdPartySdkHost(hostname: string): boolean {
  return /(facebook|apple|google|twitter|kakao|line)\./i.test(hostname);
}

export function scoreArtifactRelevance(targetPageUrl: string, artifact: ArtifactLike): number {
  const targetUrl = new URL(targetPageUrl);
  const artifactUrl = new URL(artifact.url);
  const targetTokens = new Set(extractPathTokens(targetUrl.pathname));
  const artifactTokens = extractPathTokens(artifactUrl.pathname);
  let score = 0;

  score += artifactUrl.origin === targetUrl.origin ? 4 : -3;
  score += artifact.type === "wasm" || artifact.type === "worker" || artifact.type === "service-worker" ? 4 : 0;
  score += artifact.type === "source-map" ? 3 : 0;
  score += artifact.discoveredFrom.includes("html:script") || artifact.discoveredFrom.includes("html:inline-script") ? 3 : 0;
  score += artifact.discoveredFrom.includes("iframe") ? 3 : 0;
  score += artifact.discoveredFrom.includes("form") ? -2 : 0;
  score += artifact.sizeBytes > 350_000 ? 2 : 0;

  if (isAuthLikePathname(artifactUrl.pathname)) {
    score += 7;
  }

  if (isLowSignalPathname(artifactUrl.pathname)) {
    score -= 5;
  }

  if (isThirdPartySdkHost(artifactUrl.hostname)) {
    score -= 3;
  }

  for (const token of artifactTokens) {
    if (targetTokens.has(token)) {
      score += 4;
    }
  }

  return score;
}

export function buildArtifactAnalysisPlan(targetPageUrl: string, artifact: ArtifactLike): ArtifactAnalysisPlan {
  const score = scoreArtifactRelevance(targetPageUrl, artifact);
  if (score >= 12) {
    return { priority: "high", score };
  }

  if (score >= 6) {
    return { priority: "medium", score };
  }

  return { priority: "low", score };
}

export function orderArtifactsForAnalysis(targetPageUrl: string, artifacts: FormattedArtifact[]): FormattedArtifact[] {
  return [...artifacts].sort((left, right) => {
    const leftPlan = buildArtifactAnalysisPlan(targetPageUrl, left);
    const rightPlan = buildArtifactAnalysisPlan(targetPageUrl, right);
    if (rightPlan.score !== leftPlan.score) {
      return rightPlan.score - leftPlan.score;
    }

    return right.sizeBytes - left.sizeBytes;
  });
}

export function getAgentPlanForChunk(plan: ArtifactAnalysisPlan, chunkIndex: number): SwarmAgentName[] {
  if (plan.priority === "high") {
    return chunkIndex === 0 ? [...SWARM_AGENT_ORDER] : ["runtime", "security", "synthesizer"];
  }

  if (plan.priority === "medium") {
    return chunkIndex === 0 ? ["scout", "runtime", "security", "synthesizer"] : ["scout", "synthesizer"];
  }

  return chunkIndex === 0 ? ["scout", "synthesizer"] : ["synthesizer"];
}

export function estimateAgentTaskCount(
  targetPageUrl: string,
  artifacts: FormattedArtifact[],
  getChunkCount: (artifact: FormattedArtifact) => number,
): number {
  return Math.max(
    1,
    artifacts.reduce((sum, artifact) => {
      const plan = buildArtifactAnalysisPlan(targetPageUrl, artifact);
      const chunkCount = Math.max(0, getChunkCount(artifact));
      let artifactTasks = 0;

      for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex += 1) {
        artifactTasks += getAgentPlanForChunk(plan, chunkIndex).length;
      }

      return sum + artifactTasks;
    }, 0),
  );
}
