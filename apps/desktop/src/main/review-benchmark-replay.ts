import { LocalReviewGit } from "./local-review-git.js";
import { PrPlatformError, prDetailsSchema, type PrDetails, type PrReviewClient } from "./pr-platform-client.js";

const SHA = /^[a-f0-9]{40,64}$/u;
/** Git as the local review runs it: hooks, fsmonitor and attributes off, output capped. */
const git = new LocalReviewGit();
const validPath = (path: string) => {
  if (path.startsWith("/") || path.includes("\\") || path.split("/").some((part) => !part || part === "." || part === "..")) throw new Error("Invalid repository path");
  return path;
};

/** The repository's top directory, whatever directory in it is named: runs are kept by it. */
export const repositoryRoot = (directory: string): Promise<string | null> => git.topLevel(directory);

/** Where two commits' histories meet: a fixed version's base. */
export const mergeBase = async (directory: string, a: string, b: string): Promise<string> => {
  const base = await git.mergeBase(directory, a, b);
  if (!base) throw new Error(`提交 ${a.slice(0, 12)} 和 ${b.slice(0, 12)} 没有共同的祖先。`);
  return base;
};

/** A benchmark case as it is reviewed again: its title, and the three commits it is pinned to. */
export interface ReplayVersion { reference: string; repository: string; title: string; head: string; target: string; base: string }

/**
 * A PR read from a local repository's immutable Git objects at fixed commits (docs/pr-review-replay.md), as
 * scripts/replay-pr-review.mjs reads it: no checkout, fetch, hooks or working-tree files, no comments, no labels.
 */
export const replayClient = async (directory: string, version: ReplayVersion): Promise<PrReviewClient> => {
  for (const commit of [version.base, version.head, version.target]) {
    if (!SHA.test(commit) || !await git.commitExists(directory, commit)) throw new Error(`本地仓库里没有提交 ${commit.slice(0, 12)}`);
  }
  const diff = await git.treeDiff(directory, version.base, version.head);
  if (Buffer.byteLength(diff) > 2 * 1024 * 1024) throw new Error("改动超过 2 MiB，和线上评审一样不读。");
  const names = (await git.treeDiff(directory, version.base, version.head, true)).split("\0");
  const files: Array<{ path: string; status: string }> = [];
  for (let index = 0; index + 1 < names.length; index += 2) files.push({ path: validPath(names[index + 1]!), status: names[index] === "A" ? "added" : names[index] === "D" ? "deleted" : "modified" });
  const details: PrDetails = prDetailsSchema.parse({ title: version.title, description: "", source: { repository: version.repository, commit: version.head },
    destination: { repository: version.repository, commit: version.target }, base: version.base });
  const cache = new Map<string, string>();
  const client: PrReviewClient = {
    get: async () => structuredClone(details), files: async () => files, diff: async () => diff,
    readFileContent: async (pr, path, side, signal) => {
      const commit = side === "old" ? pr.base ?? version.base : pr.source.commit;
      const key = `${commit}:${validPath(path)}`;
      signal?.throwIfAborted();
      const kept = cache.get(key);
      if (kept !== undefined) return kept;
      const content = await git.blob(directory, commit, path);
      if (content === null) throw new PrPlatformError(404);
      if (Buffer.byteLength(content) > 2 * 1024 * 1024) throw new Error("Source exceeds 2 MiB");
      cache.set(key, content);
      while (cache.size > 50) cache.delete(cache.keys().next().value!);
      return content;
    },
    readFile: async (pr, path, start, signal) => (await client.readFileContent(pr, path, "new", signal)).split("\n").slice(start - 1, start + 79).join("\n"),
    repositoryFiles: async (pr, side) => {
      const tree = await git.treeFiles(directory, side === "old" ? pr.base ?? version.base : pr.source.commit);
      const paths = tree.split("\0").filter((entry) => /^100(?:644|755) blob /u.test(entry)).map((entry) => validPath(entry.slice(entry.indexOf("\t") + 1))).sort();
      return { paths: paths.slice(0, 20_000), complete: paths.length <= 20_000 };
    },
    comments: async () => [],
  };
  return client;
};
