import { decodeGitDiffPath as headerPath } from "../shared/git-diff-path.js";
import { repositoryRelativePathSchema } from "@cognelis/decision-protocol";

/** `clipped`: a line no review group could hold, cut to its head with a note of what was left out. */
export interface DiffLine { text: string; old: number | null; new: number | null; changed: boolean; clipped?: true }
/** Only ordinary unified text patches get anchors; unsupported/binary patches remain visibly unread. */
export function parseReviewDiff(diff: string): Map<string, DiffLine[]> {
  const files = new Map<string, DiffLine[]>();
  let oldPath = "", path = "", old = 0, next = 0, inHunk = false;
  let remainingOld = 0, remainingNew = 0;
  const checkHunk = () => { if (remainingOld !== 0 || remainingNew !== 0) throw new Error("PR diff 被截断或格式不完整，请重新加载或拆分 PR。"); };
  for (const text of diff.split("\n")) {
    if (text.startsWith("diff --git ")) { checkHunk(); path = ""; oldPath = ""; inHunk = false; continue; }
    if (!inHunk && text.startsWith("--- ")) { oldPath = headerPath(text.slice(4))?.replace(/^(?:a\/|src:\/\/)/u, "") ?? ""; continue; }
    if (!inHunk && text.startsWith("+++ ")) {
      const candidate = headerPath(text.slice(4))?.replace(/^(?:b\/|dst:\/\/)/u, "");
      const parsed = repositoryRelativePathSchema.safeParse(candidate === "/dev/null" ? oldPath : candidate);
      path = parsed.success ? parsed.data : "";
      if (path) files.set(path, []);
      continue;
    }
    const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/u.exec(text);
    if (hunk) {
      checkHunk(); old = Number(hunk[1]); next = Number(hunk[3]);
      remainingOld = Number(hunk[2] ?? 1); remainingNew = Number(hunk[4] ?? 1);
      inHunk = true; continue;
    }
    if (!inHunk || !/^[ +\-]/u.test(text)) continue;
    const added = text.startsWith("+"), removed = text.startsWith("-");
    const line = { text, old: added ? null : old++, new: removed ? null : next++, changed: added || removed };
    // Unsupported paths do not erase the hunk's accounting or break sibling files.
    if (path) files.get(path)!.push(line);
    if (!added) remainingOld--;
    if (!removed) remainingNew--;
    if (remainingOld < 0 || remainingNew < 0) checkHunk();
    if (remainingOld === 0 && remainingNew === 0) inHunk = false;
  }
  checkHunk();
  return files;
}
