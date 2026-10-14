import { describe, expect, it } from "vitest";

import {
  PROACTIVE_RECORD_VERSION,
  proactiveRecordRequestSchema,
  proactiveRecordResultSchema,
} from "../src/index.js";

describe("proactive record protocol", () => {
  it("lets only a decision come from a PR comment, and then only with the comment's link", () => {
    const base = {
      recordVersion: PROACTIVE_RECORD_VERSION,
      requestId: "record-pr",
      sourceClient: "manual",
      sourceForm: "user_paraphrase",
      sensitivity: "private",
      title: "src/request.ts:12 怎么处理？",
      content: "超时统一放在请求层处理。",
    } as const;
    const link = "https://code.example/projects/AI/repos/app/pull-requests/12/overview?commentId=5";

    expect(
      proactiveRecordRequestSchema.parse({ ...base, kind: "decision", sourceKind: "pr_comment", sourceUrl: link }),
    ).toMatchObject({ sourceKind: "pr_comment", sourceUrl: link });
    expect(proactiveRecordRequestSchema.safeParse({ ...base, kind: "decision", sourceKind: "pr_comment" }).success).toBe(false);
    expect(proactiveRecordRequestSchema.safeParse({ ...base, kind: "decision", sourceKind: "app_manual", sourceUrl: link }).success).toBe(false);
    expect(proactiveRecordRequestSchema.safeParse({ ...base, kind: "idea", sourceKind: "pr_comment" }).success).toBe(false);
  });

  it("takes the languages a preference or idea is about, on those two kinds only, and few of them", () => {
    const base = {
      recordVersion: PROACTIVE_RECORD_VERSION, requestId: "record-languages", sourceClient: "codex", sourceKind: "agent_capture",
      sourceForm: "machine_summary", title: "错误一律包一层上下文", content: "返回错误时用 fmt.Errorf 包装。",
    } as const;
    expect(proactiveRecordRequestSchema.parse({ ...base, kind: "preference", languages: ["go"] })).toMatchObject({ languages: ["go"] });
    expect(proactiveRecordRequestSchema.parse({ ...base, kind: "idea", languages: ["rust"] })).toMatchObject({ languages: ["rust"] });
    // Left out, as every released client does: a general entry.
    expect(proactiveRecordRequestSchema.parse({ ...base, kind: "preference" })).not.toHaveProperty("languages");
    expect(proactiveRecordRequestSchema.safeParse({ ...base, kind: "decision", languages: ["go"] }).success).toBe(false);
    expect(proactiveRecordRequestSchema.safeParse({ ...base, kind: "preference", languages: Array.from({ length: 9 }, (_, n) => `l${n}`) }).success).toBe(false);
  });

  it("accepts a bounded explicit preference request", () => {
    const request = proactiveRecordRequestSchema.parse({
      recordVersion: PROACTIVE_RECORD_VERSION,
      requestId: "record-1",
      sourceClient: "codex",
      sourceKind: "agent_capture",
      sourceForm: "machine_summary",
      sensitivity: "private",
      project: "decision",
      occurredAt: "2026-08-26T10:00:00.000Z",
      kind: "preference",
      title: "常规实现决策默认由系统自主完成",
      content: "普通可逆的方向与实现由系统判断并交付结果。",
      appliesWhen: "既定目标和仓库范围内。",
      exceptions: "权限、付费、不可逆操作或核心验收冲突。",
      strength: "default",
      evidenceMaturity: "self_declared",
      context: "用户明确表达。",
      rationale: "减少低价值打断。",
      tags: ["协作偏好"],
    });

    expect(request.kind).toBe("preference");
    expect(
      proactiveRecordResultSchema.parse({
        recordVersion: PROACTIVE_RECORD_VERSION,
        status: "created",
        recordKind: "preference",
        recordId: "entry-1",
        knowledgeStatus: "active",
        sensitivity: "private",
        storedTranscript: false,
      }),
    ).toMatchObject({ status: "created", storedTranscript: false });
  });

  it("rejects unknown fields, invalid dates, and incomplete active preferences", () => {
    const base = {
      recordVersion: PROACTIVE_RECORD_VERSION,
      requestId: "record-1",
      sourceClient: "manual",
      sourceKind: "app_manual",
      sourceForm: "user_original",
      sensitivity: "private",
      kind: "preference",
      title: "偏好",
      content: "默认先验证。",
      knowledgeStatus: "active",
    } as const;

    expect(() =>
      proactiveRecordRequestSchema.parse({ ...base, secret: "unexpected" }),
    ).toThrow();
    expect(() =>
      proactiveRecordRequestSchema.parse({
        ...base,
        occurredAt: "not-a-date",
      }),
    ).toThrow();
    expect(() => proactiveRecordRequestSchema.parse(base)).toThrow();
  });

  it("takes a journal title and open questions as one line each, which is how the note keeps them", () => {
    const idea = {
      recordVersion: PROACTIVE_RECORD_VERSION,
      requestId: "record-lines",
      sourceClient: "codex",
      sourceKind: "agent_capture",
      sourceForm: "machine_summary",
      kind: "idea",
      title: "复盘提醒节奏",
      content: "按风险分级提醒。",
    } as const;

    expect(proactiveRecordRequestSchema.safeParse(idea).success).toBe(true);
    expect(proactiveRecordRequestSchema.safeParse({ ...idea, title: "复盘\n提醒节奏" }).success).toBe(false);
    expect(proactiveRecordRequestSchema.safeParse({ ...idea, openQuestions: ["高风险：提前 7 天\n低风险：提前 1 天"] }).success).toBe(false);
  });

  it("keeps decision-only and idea-only fields disjoint", () => {
    expect(() =>
      proactiveRecordRequestSchema.parse({
        recordVersion: PROACTIVE_RECORD_VERSION,
        requestId: "record-2",
        sourceClient: "manual",
        sourceKind: "offline_conversation",
        sourceForm: "user_paraphrase",
        sensitivity: "private",
        kind: "decision",
        title: "确定试点范围",
        content: "先在一个团队试点。",
        ideaForm: "hypothesis",
      }),
    ).toThrow();
  });
});
