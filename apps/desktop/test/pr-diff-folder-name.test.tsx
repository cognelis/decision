// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { PrReviewSnapshot } from "@cognelis/decision-protocol";
import { PrDiffDialog } from "../src/renderer/components/pages/pr-review/PrDiffDialog.js";

afterEach(() => { cleanup(); localStorage.clear(); });

const patch = 'diff --git a/v1/main.ts b/v1/main.ts\n--- a/v1/main.ts\n+++ b/v1/main.ts\n@@ -1 +1 @@\n-const value = 1;\n+const value = 2;\n';
const connectionId = "00000000-0000-4000-8000-000000000001";
const snapshot: PrReviewSnapshot = { snapshotId: connectionId, reference: "org/repo#1", title: "查看变更", description: "", project: "repo", sourceCommit: "a".repeat(40), destinationCommit: "b".repeat(40), warnings: [],
  files: [{ path: "v1/main.ts", status: "modified" }, { path: "v1/other.ts", status: "modified" }] };

/*
 * The directory's folder rows read "<name><count>" with nothing between: the folder "v1" with two files was announced
 * as "v12" by a screen reader (and "src" with one file as "src1").
 */
it("announces a folder's name apart from its file count", async () => {
  render(<PrDiffDialog api={{ loadPrReviewDiff: vi.fn(async () => ({ diff: patch })), loadPrReviewFile: vi.fn(async () => ({ content: "", binary: false })) }} snapshot={snapshot} connectionId={connectionId} onClose={() => undefined} />);
  await screen.findByText("const value = 2;");
  const summary = [...document.querySelectorAll("summary")].find(element => element.textContent?.startsWith("v1"))!;
  expect(summary).toHaveAttribute("aria-label", "v1，2 个文件");
});
