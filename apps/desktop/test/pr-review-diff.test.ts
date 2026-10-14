import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { parseReviewDiff } from "../src/main/pr-review-diff.js";

it.each(["git", "bitbucket"])("reads %s quoted UTF-8 paths without mistaking a complete hunk for truncation", async (platform) => {
  const directory = await mkdtemp(join(tmpdir(), "pr-diff-"));
  try {
    await mkdir(join(directory, "before")); await mkdir(join(directory, "after"));
    await writeFile(join(directory, "before", "中文.md"), "old\n");
    await writeFile(join(directory, "after", "中文.md"), "new\n");
    const diff = spawnSync("git", ["-c", "core.quotePath=true", "diff", "--no-index", "--", "before/中文.md", "after/中文.md"], { cwd: directory, encoding: "utf8" });
    expect(diff.status).toBe(1);
    expect(diff.stdout).toContain('+++ "b/after/');
    expect(parseReviewDiff(platform === "bitbucket" ? diff.stdout.replaceAll('"a/', '"src://').replaceAll('"b/', '"dst://') : diff.stdout).get("after/中文.md")).toEqual([
      { text: "-old", old: 1, new: null, changed: true },
      { text: "+new", old: null, new: 1, changed: true },
    ]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it("keeps counting unsupported paths and preserves readable sibling files and deletion anchors", () => {
  const unsupported = 'diff --git a/a b/a\n--- /dev/null\n+++ "b/a\\nname"\n@@ -0,0 +1 @@\n+data\n';
  const deletion = 'diff --git a/a b/a\n--- "a/space name.md"\n+++ /dev/null\n@@ -7 +0,0 @@\n-old\n';
  expect([...parseReviewDiff(unsupported + deletion)]).toEqual([["space name.md", [{ text: "-old", old: 7, new: null, changed: true }]]]);
  expect(() => parseReviewDiff(unsupported.replace('+data\n', ''))).toThrow(/截断/);
});

it("accepts CRLF metadata while retaining source line endings and rejects actual truncation", () => {
  const patch = 'diff --git a/a.md b/a.md\r\n--- a/a.md\r\n+++ b/a.md\r\n@@ -1 +1 @@\r\n-old\r\n+new\r\n';
  expect(parseReviewDiff(patch).get("a.md")?.[1]).toEqual({ text: "+new\r", old: null, new: 1, changed: true });
  expect(() => parseReviewDiff(patch.replace('+new\r\n', ''))).toThrow(/截断/);
});
