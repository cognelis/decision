// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { PrReviewSnapshot } from "@cognelis/decision-protocol";
import { PrDiffDialog } from "../src/renderer/components/pages/pr-review/PrDiffDialog.js";
import { parsePrFileDiffs, visibleDiffHunks } from "../src/renderer/components/pages/pr-review/pr-diff-view.js";

const patch = [
  'diff --git a/src/main.ts b/src/main.ts\n--- a/src/main.ts\n+++ b/src/main.ts\n@@ -10,2 +10,2 @@\n const stable = true;\n-const value = 1;\n+const value = 2;\n',
  'diff --git a/docs/old.md b/docs/old.md\ndeleted file mode 100644\n--- a/docs/old.md\n+++ /dev/null\n@@ -1 +0,0 @@\n-old document\n',
  'diff --git a/src/new.ts b/src/new.ts\nnew file mode 100644\n--- /dev/null\n+++ b/src/new.ts\n@@ -0,0 +1 @@\n+<script>alert(1)</script>\n',
  'diff --git a/old.txt b/new.txt\nsimilarity index 100%\nrename from old.txt\nrename to new.txt\n',
  'diff --git a/image.png b/image.png\nindex 1234567..abcdef0 100644\nBinary files a/image.png and b/image.png differ\n',
].join('');
const connectionId = "00000000-0000-4000-8000-000000000001";
const snapshot: PrReviewSnapshot = { snapshotId: connectionId, reference: "org/repo#1", title: "查看变更", description: "说明保留", project: "repo", sourceCommit: "a".repeat(40), destinationCommit: "b".repeat(40), warnings: [], files: [
  { path: "src/main.ts", status: "modified" }, { path: "docs/old.md", status: "deleted" }, { path: "src/new.ts", status: "added" }, { path: "new.txt", status: "renamed" }, { path: "image.png", status: "modified" },
] };
const api = () => ({ loadPrReviewDiff: vi.fn(async () => ({ diff: patch })), loadPrReviewFile: vi.fn(async () => ({ content: "full file\nlast line", binary: false })) });
afterEach(() => { cleanup(); localStorage.clear(); });

it("browses directory files in unified and split views and handles deletion, rename, binary and markup safely", async () => {
  const client = api();
  render(<PrDiffDialog api={client} snapshot={snapshot} connectionId={connectionId} onClose={() => undefined} />);
  expect(await screen.findByText("const value = 2;")).toBeVisible();
  expect(document.querySelector(".diff-unified")).toBeInTheDocument();
  expect(client.loadPrReviewDiff).toHaveBeenCalledWith(expect.objectContaining({ sourceCommit: snapshot.sourceCommit, destinationCommit: snapshot.destinationCommit }));
  fireEvent.click(screen.getByRole("button", { name: "Side-by-Side" }));
  expect(document.querySelector(".diff-split")).toBeInTheDocument();
  expect(localStorage.getItem("decision.pr-review.diff-mode")).toBe("split");
  fireEvent.click(screen.getByRole("button", { name: "docs/old.md" }));
  expect(screen.getByText("old document")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "src/new.ts" }));
  expect(screen.getByText("<script>alert(1)</script>")).toBeVisible();
  expect(document.querySelector("script")).toBeNull();
  fireEvent.change(screen.getByRole("searchbox"), { target: { value: "new.txt" } });
  expect(screen.queryByRole("button", { name: "src/main.ts" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "new.txt" }));
  expect(screen.getByText(/原路径 old.txt/)).toBeVisible();
  expect(screen.getByText(/没有文本差异/)).toBeVisible();
  fireEvent.change(screen.getByRole("searchbox"), { target: { value: "" } });
  fireEvent.click(screen.getByRole("button", { name: "image.png" }));
  expect(screen.getByText("二进制文件，无法展示文本差异。")).toBeVisible();
  expect(client.loadPrReviewFile).not.toHaveBeenCalled();
});

it("reads complete files lazily at the selected immutable side, with retries", async () => {
  const client = api();
  render(<PrDiffDialog api={client} snapshot={snapshot} connectionId={connectionId} onClose={() => undefined} />);
  await screen.findByText("const value = 2;");
  fireEvent.click(screen.getByRole("button", { name: "文件内容" }));
  expect(await screen.findByText("last line")).toBeVisible();
  expect(client.loadPrReviewFile).toHaveBeenLastCalledWith(expect.objectContaining({ path: "src/main.ts", side: "new", sourceCommit: snapshot.sourceCommit }));
  client.loadPrReviewFile.mockRejectedValueOnce(new Error("暂时无法读取"));
  fireEvent.change(screen.getByLabelText("文件提交版本"), { target: { value: "old" } });
  expect(await screen.findByText("暂时无法读取")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "重试读取文件" }));
  await screen.findByText("last line");
  expect(client.loadPrReviewFile).toHaveBeenLastCalledWith(expect.objectContaining({ side: "old", destinationCommit: snapshot.destinationCommit }));
  fireEvent.click(screen.getByRole("button", { name: "docs/old.md" }));
  await waitFor(() => expect(client.loadPrReviewFile).toHaveBeenLastCalledWith(expect.objectContaining({ path: "docs/old.md", side: "old" })));
  expect(screen.getByRole("option", { name: /源提交/ })).toBeDisabled();
});

it("displays loading errors without substituting another version and allows retry", async () => {
  const client = api();
  client.loadPrReviewDiff.mockRejectedValueOnce(new Error("PR 提交已变化"));
  render(<PrDiffDialog api={client} snapshot={snapshot} connectionId={connectionId} onClose={() => undefined} />);
  expect(await screen.findByRole("alert")).toHaveTextContent("PR 提交已变化");
  fireEvent.click(screen.getByRole("button", { name: "重试读取变更" }));
  await screen.findByText("const value = 2;");
  expect(client.loadPrReviewDiff).toHaveBeenCalledTimes(2);
});

it("does not replace the current file with a late response from the previously selected file", async () => {
  const client = api();
  let finish!: (value: { content: string; binary: boolean }) => void;
  client.loadPrReviewFile.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  render(<PrDiffDialog api={client} snapshot={snapshot} connectionId={connectionId} onClose={() => undefined} />);
  await screen.findByText("const value = 2;");
  fireEvent.click(screen.getByRole("button", { name: "文件内容" }));
  fireEvent.click(screen.getByRole("button", { name: "src/new.ts" }));
  await screen.findByText("last line");
  await act(async () => finish({ content: "late content", binary: false }));
  expect(screen.queryByText("late content")).toBeNull();
});

it("adapts Git quoted UTF-8, spaces and Bitbucket prefixes while keeping library line numbers", () => {
  const quoted = 'diff --git "src://\\344\\270\\255\\346\\226\\207.ts" "dst://\\344\\270\\255\\346\\226\\207.ts"\n--- "src://\\344\\270\\255\\346\\226\\207.ts"\n+++ "dst://\\344\\270\\255\\346\\226\\207.ts"\n@@ -4 +4 @@\n-old\n+new\n';
  const file = parsePrFileDiffs(quoted)[0]!;
  expect(file.newPath).toBe("中文.ts");
  expect(file.hunks[0]!.changes).toEqual([expect.objectContaining({ type: "delete", lineNumber: 4 }), expect.objectContaining({ type: "insert", lineNumber: 4 })]);
  const spaced = parsePrFileDiffs(patch.split('diff --git a/docs')[0]!.replaceAll("src/main.ts", "src/space name.ts"))[0]!;
  expect(spaced.newPath).toBe("src/space name.ts");
  const limited = visibleDiffHunks(file.hunks, 1);
  expect(limited[0]!.changes).toHaveLength(1);
  expect(file.hunks[0]!.changes).toHaveLength(2);
});

it("says a finding further down a long diff is not shown yet, and shows the diff down to it", async () => {
  const lines = Array.from({ length: 2_100 }, (_, index) => `+line ${index + 1}`);
  const client = { ...api(), loadPrReviewDiff: vi.fn(async () => ({ diff: `diff --git a/src/big.ts b/src/big.ts\n--- /dev/null\n+++ b/src/big.ts\n@@ -0,0 +1,2100 @@\n${lines.join("\n")}\n` })) };
  const big = { ...snapshot, files: [{ path: "src/big.ts", status: "added" }] };
  render(<PrDiffDialog api={client} snapshot={big} connectionId={connectionId} findings={[{ priority: "P2", title: "末尾的问题", body: "说明", path: "src/big.ts", side: "new", line: 2_050, decisionIndexes: [] }]} onClose={() => undefined} />);
  const list = await screen.findByRole("list", { name: "未显示在 diff 中的评审问题" });
  expect(list).toHaveTextContent("后面尚未显示");
  expect(screen.queryByText(/个在 diff 之外/u)).toBeNull();
  fireEvent.click(within(list).getByRole("button", { name: "显示到这一行" }));
  expect(await screen.findByRole("article", { name: "评审问题：末尾的问题" })).toBeVisible();
  expect(screen.getByText(/已定位到第 2050 行/u)).toBeVisible();
});

it("shows each review finding under its line, and lists those the diff does not reach", async () => {
  const client = api();
  const finding = (line: number, title: string, priority: "P1" | "P2" | "P3" = "P2") => ({ priority, title, body: `${title}的说明`, path: "src/main.ts", side: "new" as const, line, decisionIndexes: [] });
  render(<PrDiffDialog api={client} snapshot={snapshot} connectionId={connectionId} findings={[finding(11, "值被改写", "P1"), finding(40, "别处的问题", "P3"), { ...finding(1, "新文件的问题"), path: "src/new.ts" }]} onClose={() => undefined} />);
  const note = await screen.findByRole("article", { name: "评审问题：值被改写" });
  expect(note).toHaveTextContent("值被改写的说明");
  // Right under the line it is about.
  expect(note.closest("tr")?.previousElementSibling).toHaveTextContent("const value = 2;");
  expect(screen.getByText(/本文件 2 个问题，1 个在 diff 之外/u)).toBeVisible();
  expect(screen.getByRole("button", { name: "src/new.ts（1 个问题）" })).toBeVisible();
  const outside = screen.getByRole("list", { name: "未显示在 diff 中的评审问题" });
  expect(outside).toHaveTextContent("第 40 行 · 别处的问题");
  fireEvent.click(within(outside).getByRole("button", { name: "在文件内容中查看" }));
  expect(await screen.findByRole("list", { name: "文件内容" })).toBeVisible();
  expect(client.loadPrReviewFile).toHaveBeenCalledWith(expect.objectContaining({ path: "src/main.ts", side: "new" }));
});

it("walks the review findings in the directory's order, across files", async () => {
  const finding = (path: string, line: number, title: string, side: "old" | "new" = "new") => ({ priority: "P2" as const, title, body: `${title}的说明`, path, side, line, decisionIndexes: [] });
  render(<PrDiffDialog api={api()} snapshot={snapshot} connectionId={connectionId} onClose={() => undefined}
    findings={[finding("src/new.ts", 1, "新文件的问题"), finding("src/main.ts", 11, "值被改写"), finding("docs/old.md", 1, "删掉的文档", "old")]} />);
  await screen.findByText("const value = 2;");
  const nav = screen.getByRole("group", { name: "评审问题" });
  expect(nav).toHaveTextContent("3 个问题");
  // Folders before files, then by name: docs/ comes first.
  fireEvent.click(within(nav).getByRole("button", { name: "下一个问题" }));
  expect(await screen.findByRole("article", { name: "评审问题：删掉的文档" })).toBeVisible();
  expect(nav).toHaveTextContent("问题 1 / 3");
  fireEvent.click(within(nav).getByRole("button", { name: "下一个问题" }));
  expect(await screen.findByRole("article", { name: "评审问题：值被改写" })).toBeVisible();
  expect(screen.getByText(/已定位到第 11 行/u)).toBeVisible();
  fireEvent.click(within(nav).getByRole("button", { name: "上一个问题" }));
  fireEvent.click(within(nav).getByRole("button", { name: "上一个问题" }));
  expect(await screen.findByRole("article", { name: "评审问题：新文件的问题" })).toBeVisible();
  expect(nav).toHaveTextContent("问题 3 / 3");
});

it("walks two findings on one line one after the other", async () => {
  const finding = (line: number, title: string, path = "src/main.ts") => ({ priority: "P2" as const, title, body: `${title}的说明`, path, side: "new" as const, line, decisionIndexes: [] });
  render(<PrDiffDialog api={api()} snapshot={snapshot} connectionId={connectionId} onClose={() => undefined}
    findings={[finding(11, "甲"), finding(11, "乙"), finding(1, "丙", "src/new.ts")]} />);
  await screen.findByText("const value = 2;");
  const nav = screen.getByRole("group", { name: "评审问题" });
  const next = within(nav).getByRole("button", { name: "下一个问题" });
  fireEvent.click(next);
  expect(nav).toHaveTextContent("问题 1 / 3");
  fireEvent.click(next);
  expect(nav).toHaveTextContent("问题 2 / 3");
  fireEvent.click(next);
  expect(nav).toHaveTextContent("问题 3 / 3");
  expect(await screen.findByRole("article", { name: "评审问题：丙" })).toBeVisible();
  fireEvent.click(within(nav).getByRole("button", { name: "上一个问题" }));
  expect(nav).toHaveTextContent("问题 2 / 3");
});

it("walks the findings with N and P, but not while typing a file path", async () => {
  const finding = (path: string, line: number, title: string) => ({ priority: "P2" as const, title, body: `${title}的说明`, path, side: "new" as const, line, decisionIndexes: [] });
  render(<PrDiffDialog api={api()} snapshot={snapshot} connectionId={connectionId} onClose={() => undefined}
    findings={[finding("src/main.ts", 11, "值被改写"), finding("src/new.ts", 1, "新文件的问题")]} />);
  await screen.findByText("const value = 2;");
  const nav = screen.getByRole("group", { name: "评审问题" });
  // The dialog opens on its close button: the keys work from there too.
  fireEvent.keyDown(screen.getByRole("button", { name: "关闭PR 详情" }), { key: "n" });
  expect(nav).toHaveTextContent("问题 1 / 2");
  fireEvent.keyDown(screen.getByLabelText("src/main.ts 变更内容"), { key: "n" });
  expect(nav).toHaveTextContent("问题 2 / 2");
  fireEvent.keyDown(screen.getByRole("searchbox"), { key: "p" });
  expect(nav).toHaveTextContent("问题 2 / 2");
  expect(within(nav).getByRole("button", { name: "下一个问题" })).toHaveAttribute("aria-keyshortcuts", "N");
});

it("narrows the directory to the files the review found something in", async () => {
  const finding = (path: string, line: number) => ({ priority: "P2" as const, title: `${path} 的问题`, body: "说明", path, side: "new" as const, line, decisionIndexes: [] });
  render(<PrDiffDialog api={api()} snapshot={snapshot} connectionId={connectionId} onClose={() => undefined} findings={[finding("src/main.ts", 11), finding("src/new.ts", 1)]} />);
  await screen.findByText("const value = 2;");
  const directory = screen.getByRole("navigation", { name: "变更文件" });
  expect(within(directory).getByRole("button", { name: "image.png" })).toBeVisible();
  fireEvent.click(screen.getByRole("checkbox", { name: "只看有问题的文件（2）" }));
  expect(within(directory).queryByRole("button", { name: "image.png" })).toBeNull();
  expect(within(directory).queryByRole("button", { name: "docs/old.md" })).toBeNull();
  expect(within(directory).getByRole("button", { name: "src/main.ts（1 个问题）" })).toBeVisible();
  expect(within(directory).getByRole("button", { name: "src/new.ts（1 个问题）" })).toBeVisible();
  // A click leaves focus on the box; N still steps, since a checkbox takes no typing.
  const only = screen.getByRole("checkbox", { name: "只看有问题的文件（2）" });
  only.focus();
  fireEvent.keyDown(only, { key: "n" });
  expect(screen.getByRole("group", { name: "评审问题" })).toHaveTextContent("问题 1 / 2");
});
