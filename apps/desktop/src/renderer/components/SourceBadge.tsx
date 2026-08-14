import type { SourceClient } from "@cognelis/decision-protocol";

const labels: Record<SourceClient, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  test: "Test",
};

export const SourceBadge = ({ source }: { source: SourceClient }) => (
  <span className={`source-badge source-${source}`}>{labels[source]}</span>
);
