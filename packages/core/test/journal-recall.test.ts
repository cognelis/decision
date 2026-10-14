import type { JournalEntry } from "@cognelis/decision-core";
import { buildJournalRecall } from "@cognelis/decision-core";
import { tokenHashCache } from "../src/recall-text.js";
import { describe, expect, it } from "vitest";

/**
 * Recalling the reader's own preferences and ideas before a choice.
 *
 * The scoring is the easy half. The half that matters is that a recalled
 * record never arrives looking like a rule: the domain says a preference
 * allows exceptions and is not an adopted principle, and an idea is not a
 * commitment at all.
 */
const preference = (overrides: Partial<JournalEntry> = {}): JournalEntry =>
  ({
    id: "preference-rollback",
    kind: "preference",
    title: "先留回滚入口，再扩大发布",
    content: "不可逆的发布步骤要先有明确的回滚路径和负责人。",
    knowledgeStatus: "active",
    sourceKind: "app_manual",
    sourceForm: "user_original",
    project: "decision",
    occurredAt: null,
    sensitivity: "personal",
    context: null,
    rationale: null,
    tags: [],
    languages: [],
    appliesWhen: "改动一旦上线就难以撤回时。",
    exceptions: "只影响本机、随时可以重装的改动。",
    strength: "default",
    evidenceMaturity: "reviewed",
    createdAt: "2026-08-02T10:00:00.000Z",
    updatedAt: "2026-08-09T10:00:00.000Z",
    revision: 2,
    revisionEvents: [],
    ...overrides,
  }) as JournalEntry;

const idea = (overrides: Partial<JournalEntry> = {}): JournalEntry =>
  ({
    ...preference(),
    id: "idea-event-cache",
    kind: "idea",
    title: "缓存失效可以改成事件驱动",
    content: "与其定时清理，不如让写入端在提交后发一个失效事件。",
    knowledgeStatus: "inbox",
    ideaForm: "hypothesis",
    whyInteresting: "定时清理的窗口期一直是排查问题时的干扰项。",
    openQuestions: ["写入端能否可靠拿到受影响的键？"],
    nextTest: null,
    incubateUntil: null,
    appliesWhen: undefined,
    exceptions: undefined,
    strength: undefined,
    evidenceMaturity: undefined,
    ...overrides,
  }) as JournalEntry;

const rollbackQuestion = {
  question: "这次发布要不要先留回滚入口？",
  selectedAnswer: null,
  optionLabels: ["先留回滚入口", "直接全量发布"],
  context: "改动一旦上线就难以撤回。",
};

describe("tokenHashCache", () => {
  it("lets go of a record's hashes once a pass over every record no longer asks for it", () => {
    const cache = tokenHashCache();
    let made = 0;
    const texts = () => {
      made += 1;
      return ["缓存失效改成事件驱动"];
    };
    cache.hashes("kept", ["a"], texts);
    cache.hashes("deleted", ["b"], texts);
    cache.settle();
    cache.hashes("kept", ["a"], texts);
    cache.settle();
    expect(made).toBe(2);

    // Deleted or archived since, it was kept until a restart; let go, it is made again if it comes back.
    cache.hashes("deleted", ["b"], texts);
    expect(made).toBe(3);
  });
});

describe("buildJournalRecall", () => {
  it("recalls a general preference in any language and a language-specific one only where its languages meet", () => {
    const general = preference({ id: "general" });
    const goOnly = preference({ id: "go-only", languages: ["go"] });
    const recalled = (languages: string[] | null) =>
      buildJournalRecall([general, goOnly], rollbackQuestion, 5, languages).map((match) => match.recordId).sort();

    expect(recalled(["typescript"])).toEqual(["general"]);
    expect(recalled(["go", "typescript"])).toEqual(["general", "go-only"]);
    // Not known (an older client, a repository with no manifest): every one, as before languages were kept.
    expect(recalled(null)).toEqual(["general", "go-only"]);
    expect(recalled([])).toEqual(["general", "go-only"]);
    // Code in TypeScript is code in JavaScript too, C++ in C: kept for the one, it holds in the other — and not back.
    const jsOnly = preference({ id: "js-only", languages: ["javascript"] });
    const cOnly = preference({ id: "c-only", languages: ["c"] });
    const holding = (languages: string[]) => buildJournalRecall([jsOnly, cOnly], rollbackQuestion, 5, languages).map((match) => match.recordId).sort();
    expect(holding(["typescript"])).toEqual(["js-only"]);
    expect(holding(["cpp"])).toEqual(["c-only"]);
    expect(holding(["python"])).toEqual([]);
    // Said, so the agent sees what it is kept for.
    expect(buildJournalRecall([goOnly], rollbackQuestion, 5, ["go"])[0]?.reason).toContain("适用语言：Go。");
    expect(buildJournalRecall([general], rollbackQuestion, 5, ["go"])[0]?.reason).not.toContain("适用语言");
  });

  it("says what a recalled preference is allowed to be used as", () => {
    const [match] = buildJournalRecall([preference()], rollbackQuestion);

    expect(match?.recordId).toBe("preference-rollback");
    expect(match?.kind).toBe("preference");
    // Without this a caller has a record that reads exactly like a rule.
    expect(match?.standing).toContain("允许例外");
    expect(match?.standing).toContain("不是已采纳原则");
    expect(match?.reason).toContain("不是已采纳原则");
    // The reader is the agent: "你自己的立场" made it the agent's.
    expect(match?.reason).toMatch(/只作为用户自己的偏好提醒。$/u);
  });

  it("never calls a recalled record a strong reason, however close the text", () => {
    // Scored on its own question, so the overlap is as high as it can get.
    const record = preference();
    const [match] = buildJournalRecall([record], {
      question: record.title,
      selectedAnswer: null,
      optionLabels: [record.content],
      context: record.content,
    });

    expect(match?.score).toBeGreaterThan(24);
    // "strong" is what an accepted principle earns. A stance that allows
    // exceptions cannot borrow it, whatever the text overlap says.
    expect(match?.strength).toBe("possible");
  });

  it("finds a preference by a word glued to Chinese, on either side", () => {
    const [match] = buildJournalRecall(
      [preference({ id: "preference-redis", title: "会话缓存统一用Redis", content: "会话缓存统一用Redis，禁止本地内存兜底。", appliesWhen: "需要跨进程共享会话时。" })],
      { question: "要不要给Redis缓存加过期时间？", selectedAnswer: null, optionLabels: ["加过期时间", "不加"], context: "会话缓存越来越大。" },
    );

    expect(match?.recordId).toBe("preference-redis");
    expect(match?.matchedTerms).toContain("redis");
  });

  it("keeps the conditions that qualify a preference with it", () => {
    const [match] = buildJournalRecall([preference()], rollbackQuestion);

    // A preference without its exceptions is a rule with the escape hatch
    // quietly removed.
    expect(match?.qualifier).toContain("只影响本机");
    expect(match?.qualifier).toContain("改动一旦上线");
  });

  it("carries an idea's open questions rather than only its claim", () => {
    const [match] = buildJournalRecall([idea()], {
      ...rollbackQuestion,
      question: "缓存失效用定时清理还是事件驱动？",
      optionLabels: ["定时清理", "事件驱动"],
      context: "定时清理的窗口期一直是干扰项。",
    });

    expect(match?.kind).toBe("idea");
    expect(match?.qualifier).toContain("未决问题");
    expect(match?.standing).toContain("尚未形成承诺");
    expect(match?.reason).toMatch(/只作为用户自己的想法提醒。$/u);
  });

  it("leaves archived records where the reader put them", () => {
    const archived = preference({ knowledgeStatus: "archived" });

    // Archiving is the reader saying they are done with it; recalling it
    // anyway would undo that with no way to say so.
    expect(buildJournalRecall([archived], rollbackQuestion)).toEqual([]);
  });

  it("scores a record again once its text has changed under the same id", () => {
    const before = preference({ id: "preference-changing", title: "界面字体统一", content: "界面字体统一用一种。", appliesWhen: null, exceptions: null });
    expect(buildJournalRecall([before], rollbackQuestion)).toEqual([]);

    // Edited in Obsidian into one about rollbacks: scored as it was before, it stayed out of every consultation.
    const after = { ...before, title: "先留回滚入口，再扩大发布", content: "不可逆的发布步骤要先有明确的回滚路径和负责人。" } as JournalEntry;
    expect(buildJournalRecall([after], rollbackQuestion).map((match) => match.recordId)).toEqual(["preference-changing"]);
  });

  it("recalls again from thousands of records in a fraction of the first time", () => {
    const entries = Array.from({ length: 5_000 }, (_, n) =>
      preference({ id: `preference-${n}`, title: `第${n}条：先留回滚入口`, content: `发布步骤${n}要先有回滚路径和负责人。`.repeat(8) }));
    buildJournalRecall(entries, rollbackQuestion);

    const started = performance.now();
    for (let round = 0; round < 20; round += 1) buildJournalRecall(entries, rollbackQuestion);
    // Tokenized again on every call, each consultation held the main process for a fifth of a second.
    expect(performance.now() - started).toBeLessThan(500);
  });

  it("stays quiet on a question it has nothing to say about", () => {
    expect(
      buildJournalRecall([preference()], {
        question: "字体用哪一款？",
        selectedAnswer: null,
        optionLabels: ["Inter", "思源黑体"],
        context: null,
      }),
    ).toEqual([]);
  });
});
