import { describe, expect, it } from "vitest";

import {
  createJournalEntry,
  normalizedLanguages,
  reviseJournalEntry,
} from "../src/index.js";

const now = new Date("2026-08-26T10:00:00.000Z");
const source = {
  sourceKind: "agent_capture" as const,
  sourceForm: "machine_summary" as const,
  project: "decision",
  occurredAt: "2026-08-26T09:55:00.000Z",
  sensitivity: "private" as const,
};

describe("journal entries", () => {
  it("records an explicit scoped autonomy preference as active", () => {
    const entry = createJournalEntry(
      {
        kind: "preference",
        title: "常规实现决策默认由系统自主完成",
        content: "普通可逆的方向与实现由系统自行判断并交付结果。",
        appliesWhen: "既定目标和仓库范围内的普通产品与工程取舍。",
        exceptions: "权限、付费、不可逆操作、公开范围或核心验收冲突。",
        strength: "default",
        evidenceMaturity: "self_declared",
        context: "用户明确要求不要反复确认，只接收结果。",
        rationale: "减少低价值打断。",
        tags: ["协作偏好"],
      },
      source,
      "entry-1",
      now,
    );

    expect(entry).toMatchObject({
      id: "entry-1",
      kind: "preference",
      knowledgeStatus: "active",
      revision: 1,
      sourceKind: "agent_capture",
      sourceForm: "machine_summary",
      sensitivity: "private",
      strength: "default",
      evidenceMaturity: "self_declared",
    });
    expect(entry.revisionEvents).toEqual([]);
  });

  it("keeps the languages a preference is about, each by one name, and none for a general one", () => {
    const draft = { kind: "preference" as const, title: "错误一律包一层上下文", content: "返回错误时用 fmt.Errorf 包装。" };
    const general = createJournalEntry(draft, source, "general-1", now);
    const specific = createJournalEntry({ ...draft, languages: [" Golang ", "go", "TS"] }, source, "go-1", now);

    expect(general.languages).toEqual([]);
    expect(specific.languages).toEqual(["go", "typescript"]);
    expect(normalizedLanguages(["C#", "c++", "Objective-C", "bash", "zsh"])).toEqual(["csharp", "cpp", "objective-c", "shell"]);
    expect(() => normalizedLanguages(["a", "b", "c", "d", "e", "f", "g", "h", "i"])).toThrow("at most 8");

    // A revision keeps the previous languages in its history.
    const revised = reviseJournalEntry(specific, { ...draft, languages: [] }, { changeNote: "其实各语言通用", sourceKind: "app_manual", sourceForm: "user_original" }, now);
    expect(revised.languages).toEqual([]);
    expect(revised.revisionEvents[0]?.previous.languages).toEqual(["go", "typescript"]);
  });

  it("keeps quick ideas in inbox and appends immutable revisions", () => {
    const entry = createJournalEntry(
      {
        kind: "idea",
        title: "用冲突记录检验偏好边界",
        content: "新决定与偏好冲突时触发重审。",
      },
      { ...source, sourceKind: "app_manual", sourceForm: "user_original" },
      "idea-1",
      now,
    );
    expect(entry.knowledgeStatus).toBe("inbox");

    const revised = reviseJournalEntry(
      entry,
      {
        kind: "idea",
        title: entry.title,
        content: entry.content,
        knowledgeStatus: "active",
        whyInteresting: "比固定周期提醒更少打扰。",
        openQuestions: ["怎样区分冲突和作用域不同？"],
        ideaForm: "hypothesis",
      },
      {
        changeNote: "补充验证价值",
        sourceKind: "app_manual",
        sourceForm: "user_original",
      },
      new Date("2026-08-27T10:00:00.000Z"),
    );

    expect(revised.revision).toBe(2);
    expect(revised.knowledgeStatus).toBe("active");
    expect(revised.revisionEvents).toHaveLength(1);
    expect(revised.revisionEvents[0]).toMatchObject({
      revision: 2,
      changeNote: "补充验证价值",
      previous: { content: entry.content, knowledgeStatus: "inbox" },
    });
    expect(entry.revisionEvents).toEqual([]);
  });

  it("rejects active unscoped preferences and empty revision notes", () => {
    expect(() =>
      createJournalEntry(
        {
          kind: "preference",
          title: "快速",
          content: "默认更快。",
          knowledgeStatus: "active",
        },
        source,
        "invalid",
        now,
      ),
    ).toThrow(/作用域和例外/u);

    const entry = createJournalEntry(
      { kind: "idea", title: "想法", content: "一个想法。" },
      source,
      "idea-2",
      now,
    );
    expect(() =>
      reviseJournalEntry(
        entry,
        { kind: "idea", title: entry.title, content: entry.content },
        { changeNote: " ", sourceKind: "agent_capture", sourceForm: "machine_summary" },
        now,
      ),
    ).toThrow(/变更原因/u);
  });
});
