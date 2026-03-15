import pc from "picocolors";

export function renderProgressBar(completed: number, total: number, width = 24): string {
  const safeTotal = Math.max(1, total);
  const ratio = Math.min(1, Math.max(0, completed / safeTotal));
  const filled = Math.round(ratio * width);
  const empty = Math.max(0, width - filled);

  return `${pc.cyan("[" + "=".repeat(filled) + "-".repeat(empty) + "]")} ${Math.round(ratio * 100)}%`;
}

const ansiPattern = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;

export interface AnalysisProgressLineInput {
  completed: number;
  total: number;
  elapsedMs: number;
  agent: string;
  state: "started" | "streaming" | "completed";
  artifactUrl: string;
  chunkIndex?: number;
  chunkCount?: number;
  estimatedOutputTokens?: number;
  outputTokens?: number;
  tokensPerSecond?: number;
  terminalWidth?: number;
}

export function stripAnsi(value: string): string {
  return value.replace(ansiPattern, "");
}

export function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }

  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }

  return `${seconds}s`;
}

export function estimateRemainingMs(completed: number, total: number, elapsedMs: number): number | undefined {
  if (completed <= 0 || total <= 0 || completed >= total || elapsedMs <= 0) {
    return undefined;
  }

  const averageMsPerStep = elapsedMs / completed;
  return Math.round(averageMsPerStep * Math.max(0, total - completed));
}

export function middleTruncate(value: string, maxLength: number): string {
  if (maxLength <= 0) {
    return "";
  }

  if (value.length <= maxLength) {
    return value;
  }

  if (maxLength <= 3) {
    return value.slice(0, maxLength);
  }

  const reserved = 3;
  const headLength = Math.max(1, Math.ceil((maxLength - reserved) * 0.7));
  const tailLength = Math.max(1, maxLength - reserved - headLength);

  return `${value.slice(0, headLength)}...${value.slice(-tailLength)}`;
}

function computeProgressBarWidth(terminalWidth: number): number {
  if (terminalWidth >= 140) {
    return 24;
  }

  if (terminalWidth >= 110) {
    return 20;
  }

  if (terminalWidth >= 90) {
    return 16;
  }

  return 12;
}

function formatAgentState(state: AnalysisProgressLineInput["state"]): string {
  if (state === "streaming") {
    return "streaming";
  }

  if (state === "completed") {
    return "completed";
  }

  return "running";
}

function formatChunkLabel(chunkIndex: number | undefined, chunkCount: number | undefined): string {
  if (chunkIndex === undefined || chunkCount === undefined) {
    return "";
  }

  return ` chunk ${chunkIndex}/${chunkCount}`;
}

function formatTelemetrySuffix(input: AnalysisProgressLineInput): string {
  const tokenCount = input.outputTokens ?? input.estimatedOutputTokens;
  if (tokenCount === undefined) {
    return "";
  }

  const tokenLabel = input.outputTokens !== undefined ? `${tokenCount} tok` : `~${tokenCount} tok`;
  const tpsLabel = input.tokensPerSecond !== undefined ? ` ${input.tokensPerSecond} tps` : "";
  return ` [${tokenLabel}${tpsLabel}]`;
}

export function renderAdaptiveAnalysisProgressLine(input: AnalysisProgressLineInput): string {
  const terminalWidth = Math.max(80, input.terminalWidth ?? process.stdout.columns ?? 120);
  const progressBar = renderProgressBar(input.completed, input.total, computeProgressBarWidth(terminalWidth));
  const prefix = `${progressBar} ${input.agent} agent ${formatAgentState(input.state)} `;
  const etaMs = estimateRemainingMs(input.completed, input.total, input.elapsedMs);
  const suffixCandidates = [
    `${formatChunkLabel(input.chunkIndex, input.chunkCount)}${formatTelemetrySuffix(input)}${
      etaMs !== undefined ? ` [eta ${formatDuration(etaMs)}]` : ""
    }`,
    `${formatChunkLabel(input.chunkIndex, input.chunkCount)}${formatTelemetrySuffix(input)}`,
    formatChunkLabel(input.chunkIndex, input.chunkCount),
    "",
  ];

  for (const suffix of suffixCandidates) {
    const availableUrlLength = terminalWidth - stripAnsi(prefix).length - stripAnsi(suffix).length;
    if (availableUrlLength < 4 && suffix.length > 0) {
      continue;
    }

    const artifactUrl = middleTruncate(input.artifactUrl, Math.max(1, availableUrlLength));
    const candidate = `${prefix}${artifactUrl}${suffix}`;
    if (stripAnsi(candidate).length <= terminalWidth) {
      return candidate;
    }
  }

  return `${prefix}${middleTruncate(input.artifactUrl, 8)}`;
}
