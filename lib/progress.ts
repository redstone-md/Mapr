import pc from "picocolors";

export function renderProgressBar(completed: number, total: number, width = 24): string {
  const safeTotal = Math.max(1, total);
  const ratio = Math.min(1, Math.max(0, completed / safeTotal));
  const filled = Math.round(ratio * width);
  const empty = Math.max(0, width - filled);

  return `${pc.cyan("[" + "=".repeat(filled) + "-".repeat(empty) + "]")} ${Math.round(ratio * 100)}%`;
}
