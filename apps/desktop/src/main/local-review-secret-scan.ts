import { decodeGitDiffPath } from "../shared/git-diff-path.js";
import { reviewPath, type ReviewArtifact } from "./local-review-git.js";

export interface ReviewSecretFinding { path: string; line: number }
// ponytail: fixed shape rules are a last-resort guard, not proof that credentials
// cannot be read or leaked. Encoded, split or unfamiliar secrets can evade them.
const SECRET_SHAPES = [
  /sk-ant-/iu,
  /["']auth_mode["']\s*:\s*["']chatgpt["']/iu,
  /["'](?:access_?token|refresh_?token|id_?token)["']\s*:\s*["'][^"'\s]{8,}/iu,
  /["'](?:claudeAiOauth|OPENAI_API_KEY)["']\s*:\s*(?:\{|["'][^"'\s]{8,})/iu,
  /^\s*keychain:\s*["']/u,
  /^\s*class:\s*["'](?:genp|inet|keys|cert)["']/u,
  /["'](?:acct|svce|srvr|ptcl)["']\s*<blob>\s*=/u,
] as const;

/** Only added hunk lines are scanned. Never return a matching value or excerpt. */
export function reviewSecretFindings(diff: string): ReviewSecretFinding[] {
  const findings: ReviewSecretFinding[] = [];
  let path: string | null = null, line = 0, inHunk = false;
  for (const text of diff.split("\n")) {
    if (text.startsWith("diff --git ")) { path = null; inHunk = false; continue; }
    if (!inHunk && text.startsWith("+++ ")) {
      const decoded = decodeGitDiffPath(text.slice(4));
      if (decoded === null) throw new Error("敏感内容扫描无法解析文件路径，未推送。");
      path = decoded === "/dev/null" ? null : reviewPath(decoded.replace(/^b\//u, ""));
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/u.exec(text);
    if (hunk) { inHunk = true; line = Number(hunk[1]); continue; }
    if (!inHunk) continue;
    if (text.startsWith("+")) {
      if (!path) throw new Error("敏感内容扫描缺少新增文件路径，未推送。");
      if (SECRET_SHAPES.some(shape => shape.test(text.slice(1)))) findings.push({ path, line });
      line++;
    } else if (text.startsWith(" ")) line++;
  }
  return findings;
}

export function scanReviewArtifact(artifact: ReviewArtifact | null) {
  return artifact ? { ...artifact, secretFindings: reviewSecretFindings(artifact.diff) } : null;
}
