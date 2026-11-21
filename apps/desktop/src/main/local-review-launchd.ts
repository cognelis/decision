import type { ManagedChildProcessRunner } from "./model/cli/managed-child-process.js";

/** Discard PID/status columns immediately; never collect task configuration. */
export function reviewLaunchdLabels(stdout: string): string[] {
  const rows = stdout.trimEnd().split(/\r?\n/u);
  if (!/^PID\s+Status\s+Label\s*$/u.test(rows.shift() ?? "")) throw new Error("无法解析宿主 launchd 标签列表。");
  const labels = new Set<string>();
  for (const row of rows) {
    if (!row.trim()) continue;
    const match = /^(?:-|\d+)\s+-?\d+\s+(.+)$/u.exec(row);
    if (!match || !match[1]?.trim()) throw new Error("无法解析宿主 launchd 标签行。");
    labels.add(match[1].trim());
  }
  return [...labels].sort();
}
export class ReviewLaunchdLabels {
  constructor(private readonly runner: ManagedChildProcessRunner) {}
  async snapshot(): Promise<string[]> {
    if (process.platform !== "darwin") throw new Error("当前平台不支持宿主 launchd 标签对照。");
    const result = await this.runner.run({ provider: "local-review-launchd-observation", executable: "/bin/launchctl", args: ["list"], cwd: "/", environment: { PATH: "/usr/bin:/bin", LANG: "C" }, stdin: "", timeoutMs: 10000, maximumStdoutBytes: 2 * 1024 * 1024, maximumStderrBytes: 16000 });
    return reviewLaunchdLabels(result.stdout);
  }
}
export function addedReviewLaunchdLabels(before: readonly string[], after: readonly string[]): string[] {
  // ponytail: GUI launches and system activity routinely add application.* and
  // com.apple.* labels. This post-hoc hint ignores both to remain usable; an
  // attacker can reuse either prefix to evade the warning. This is not isolation.
  const previous = new Set(before); return [...new Set(after)].filter(label => !label.startsWith("application.") && !label.startsWith("com.apple.") && !previous.has(label)).sort();
}
export const REVIEW_LAUNCHD_WARNING = "可能新增宿主 launchd 任务；本组后续命令已停止，请检查任务详情中的标签。";
