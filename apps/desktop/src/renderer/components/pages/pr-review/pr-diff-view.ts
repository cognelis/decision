import { parseDiff, type FileData, type HunkData } from "react-diff-view";
import { decodeGitDiffPath } from "../../../../shared/git-diff-path.js";

const pathOf = (value: string | undefined) => value === undefined ? undefined :
  decodeGitDiffPath(value)?.replace(/^(?:a\/|b\/|src:\/\/|dst:\/\/)/u, "");

/** Keep the library's hunk renderer/parser; adapt host-specific and Git-quoted filenames. */
export function parsePrFileDiffs(text: string): FileData[] {
  return text.split(/(?=^diff --git )/mu).filter(part => part.startsWith("diff --git ")).map(part => {
    const metadata = part.split(/^@@ /mu, 1)[0]!;
    const oldHeader = /^--- (.+)$/mu.exec(metadata)?.[1];
    const newHeader = /^\+\+\+ (.+)$/mu.exec(metadata)?.[1];
    const renameFrom = /^rename from (.+)$/mu.exec(metadata)?.[1];
    const renameTo = /^rename to (.+)$/mu.exec(metadata)?.[1];
    const file = parseDiff(part.replace(/\r\n/gu, "\n"), { nearbySequences: "zip" })[0];
    if (!file) throw new Error("无法解析此 PR 的文件变更。");
    const firstLine = /^diff --git ("(?:\\.|[^"])*"|(?:a\/|src:\/\/).*?) ("(?:\\.|[^"])*"|(?:b\/|dst:\/\/).*)$/mu.exec(metadata);
    const oldPath = pathOf(oldHeader ?? firstLine?.[1]);
    const newPath = pathOf(newHeader ?? firstLine?.[2]);
    return { ...file,
      oldPath: renameFrom ? decodeGitDiffPath(renameFrom) ?? file.oldPath : oldPath ?? file.oldPath,
      newPath: renameTo ? decodeGitDiffPath(renameTo) ?? file.newPath : newPath ?? file.newPath,
      type: renameTo ? "rename" : oldPath === "/dev/null" ? "add" : newPath === "/dev/null" ? "delete" : file.type,
      isBinary: /^Binary files |^GIT binary patch/mu.test(metadata) || Boolean(file.isBinary),
    };
  });
}

/** Bound the initial DOM size; reveal more of the same hunks on demand. */
export function visibleDiffHunks(hunks: HunkData[], limit: number): HunkData[] {
  const result: HunkData[] = [];
  for (const hunk of hunks) {
    if (limit <= 0) break;
    const changes = hunk.changes.slice(0, limit);
    result.push({ ...hunk, changes, oldLines: changes.filter(line => line.type !== "insert").length, newLines: changes.filter(line => line.type !== "delete").length });
    limit -= changes.length;
  }
  return result;
}
