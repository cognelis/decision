import { describe, expect, it } from "vitest";

import { prCommentRespondSchema, prCommentResponse, prCommentTitle, prResponseOf, prResponseReply, prReviewMarkOf } from "../src/pr-review-responses.js";
import { prFindingMarker } from "../src/pr-review-basis.js";

describe("standard replies (作者回应)", () => {
  it("reads back what it writes, and nothing without its closing line", () => {
    const reply = prResponseReply("intended", "  文件名统一用 UTC。 ");
    expect(reply).toBe("**有意为之**：文件名统一用 UTC。\n\n— Paraself 作者回应");
    expect(prResponseOf(reply)).toEqual({ kind: "intended", words: "文件名统一用 UTC。" });
    // As a platform may give it back: trailing space, a colon of the other width.
    expect(prResponseOf("**误报**:没有这个分支。\n\n— Paraself 作者回应\n")).toEqual({ kind: "wrong", words: "没有这个分支。" });
    expect(prResponseOf("**误报**：说在前面，但没有结尾那一行")).toBeNull();
    expect(prResponseOf("**随便**：……\n\n— Paraself 作者回应")).toBeNull();
  });

  it("takes the author's latest standard reply in a thread, never someone else's", () => {
    const replies = [
      { id: "1", author: "A", mine: true, createdAt: "1", body: prResponseReply("wontfix", "先不改。") },
      { id: "2", author: "B", mine: false, createdAt: "2", body: prResponseReply("fixed", "别人代答。") },
      { id: "3", author: "A", mine: true, createdAt: "3", body: prResponseReply("later", "已建待办「x」。") },
    ];
    expect(prCommentResponse({ replies })).toEqual({ kind: "later", words: "已建待办「x」。", at: "3" });
    expect(prCommentResponse({ replies: replies.slice(1, 2) })).toBeNull();
  });

  it("needs a reason for 不修, not for 转后续", () => {
    const base = { connectionId: "00000000-0000-4000-8000-000000000001", reference: "org/app#1", commentId: "11" };
    expect(prCommentRespondSchema.safeParse({ ...base, kind: "wrong", reason: " " }).success).toBe(false);
    expect(prCommentRespondSchema.safeParse({ ...base, kind: "later" }).success).toBe(true);
  });
});

describe("a pre-review comment's closing line", () => {
  it("says its priority and basis, and whether it is only a suggestion", () => {
    const finding = { priority: "P1", body: "违反 REVIEW.md 第 2 条。", decisionIndexes: [] };
    expect(prReviewMarkOf(`正文\n\n${prFindingMarker(finding, ["REVIEW.md"])}`)).toEqual({ priority: "P1", basis: "依据 REVIEW.md", suggestion: false });
    expect(prReviewMarkOf(`正文\n\n${prFindingMarker({ ...finding, priority: "P2", body: "和以前的决定不一致。", decisionIndexes: [1] }, [])}`)).toEqual({ priority: "P2", basis: "审阅人的个人经验，仓库暂无此规则", suggestion: true });
    expect(prReviewMarkOf(`正文\n\n${prFindingMarker({ ...finding, body: "空指针。" }, [])}`)).toEqual({ priority: "P1", basis: null, suggestion: false });
    expect(prReviewMarkOf("普通评论")).toBeNull();
  });

  it("titles a comment by its own heading, else its first line", () => {
    expect(prCommentTitle("**P1 · 续期没查吊销**\n\n正文")).toBe("续期没查吊销");
    expect(prCommentTitle("\n> 能不能拆小一点？\n第二行")).toBe("能不能拆小一点？");
    expect(prCommentTitle("")).toBe("（空评论）");
  });
});

describe("本轮变化 in the description", () => {
  it("replaces the last round's section, or adds one at the end, leaving the rest as written", async () => {
    const { prDescriptionWithRound } = await import("../src/pr-review-responses.js");
    expect(prDescriptionWithRound("## 验证\n单测。", "第一轮")).toBe("## 验证\n单测。\n\n## 本轮变化\n\n第一轮");
    expect(prDescriptionWithRound("## 验证\n单测。\n\n## 本轮变化\n\n第一轮\n\n## 撤回\n回滚。", "第二轮")).toBe("## 验证\n单测。\n\n## 本轮变化\n\n第二轮\n\n## 撤回\n回滚。");
    expect(prDescriptionWithRound("## 本轮变化\n旧的", "新的")).toBe("## 本轮变化\n\n新的");
    expect(prDescriptionWithRound("", "第一轮")).toBe("## 本轮变化\n\n第一轮");
  });
});
