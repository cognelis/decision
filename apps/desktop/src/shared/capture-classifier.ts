/**
 * Which engine reads a captured turn: the deterministic rules alone, the rules
 * plus this machine's Qwen 4B and nothing else (the default, IMP-153), or the
 * rules plus whichever model backend the fallback chain reaches first.
 *
 * This is the one model caller that runs unattended — every turn of every
 * Claude Code or Codex session, without the reader asking for it — so it is
 * also the one worth being able to turn off on its own, and the one that by
 * default never leaves the machine. Every other purpose (问答, 方法论提炼,
 * 技能与工作流草案) is something the reader starts.
 */
export const CAPTURE_CLASSIFIERS = ["local", "rules", "models"] as const;

export type CaptureClassifier = (typeof CAPTURE_CLASSIFIERS)[number];

export const DEFAULT_CAPTURE_CLASSIFIER: CaptureClassifier = "local";
