import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";

import {
  TextDecisionAnalyzer,
  type DecisionBand,
} from "../src/index.js";

const analyzer = new TextDecisionAnalyzer();

interface CorpusCase {
  name: string;
  humanDecision: boolean;
  expectedBand: DecisionBand;
  userText?: string;
  assistantText: string;
}

const corpus: CorpusCase[] = [
  {
    name: "explicit Chinese choice without a question mark",
    humanDecision: true,
    expectedBand: "high",
    userText: "继续开发 Decision。",
    assistantText: [
      "规则方案延迟低，本地模型召回更高。",
      "",
      "1. 先规则后模型",
      "2. 直接本地模型",
      "",
      "请选择一种方案",
    ].join("\n"),
  },
  {
    name: "direct yes or no question",
    humanDecision: true,
    expectedBand: "high",
    assistantText: "现在继续吗？",
  },
  {
    name: "Chinese alternatives without an ordinal",
    humanDecision: true,
    expectedBand: "high",
    assistantText: "采用 A 还是 B？",
  },
  {
    name: "English alternatives",
    humanDecision: true,
    expectedBand: "high",
    assistantText:
      "1. Rules first\n2. Local model first\n\nWhich approach do you prefer?",
  },
  {
    name: "implicit confirmation wait",
    humanDecision: true,
    expectedBand: "medium",
    assistantText:
      "本地规则成本最低。我倾向先做规则版本，等你确认后再继续。",
  },
  {
    name: "answered rhetorical question",
    humanDecision: false,
    expectedBand: "low",
    assistantText: "为什么这样做？因为它可以随时重建。",
  },
  {
    name: "test status",
    humanDecision: false,
    expectedBand: "low",
    assistantText: "测试是否通过：否",
  },
  {
    name: "question in code",
    humanDecision: false,
    expectedBand: "low",
    assistantText:
      "```ts\nconst value = ready ? first : second;\n```",
  },
  {
    name: "quoted prior question",
    humanDecision: false,
    expectedBand: "low",
    assistantText:
      "> 用户之前问：是否使用缓存？\n\n我已经完成实现。",
  },
  {
    name: "information request",
    humanDecision: false,
    expectedBand: "low",
    assistantText: "请提供 API key。",
  },
  {
    name: "assistant continues after asking",
    humanDecision: false,
    expectedBand: "low",
    assistantText: "你想怎么做？我建议先补测试。我现在开始执行。",
  },
];

const completed = (item: CorpusCase) => {
  const pending = analyzer.analyze({
    userText: item.userText ?? null,
    assistantText: item.assistantText,
  });
  if (pending === null) {
    return "low" as const;
  }
  return analyzer.complete(
    pending,
    item.humanDecision ? "按你的建议" : "继续开发另一个任务",
  ).band;
};

describe("TextDecisionAnalyzer", () => {
  it("extracts options, question and bounded context", () => {
    const analysis = analyzer.analyze({
      userText: "继续开发 Decision。",
      assistantText: [
        "规则方案延迟低，本地模型召回更高。",
        "",
        "1. 先规则后模型",
        "2. 直接本地模型",
        "",
        "请选择一种方案",
      ].join("\n"),
    });

    expect(analysis).toMatchObject({
      question: "请选择一种方案",
      options: [
        { id: "1", label: "先规则后模型" },
        { id: "2", label: "直接本地模型" },
      ],
      context: {
        taskBackground: "继续开发 Decision。",
        decisionFraming:
          "规则方案延迟低，本地模型召回更高。",
      },
      detectorVersion: "rules-v1",
    });
    expect(analysis?.preScore).toBeGreaterThanOrEqual(75);
  });

  it("keeps multiple numbered subquestions as one request", () => {
    const analysis = analyzer.analyze({
      userText: "规划下一阶段。",
      assistantText: [
        "请一次决定以下事项：",
        "1. 先做采集还是回顾？",
        "2. 规则还是本地模型？",
      ].join("\n"),
    });

    expect(analysis?.question).toBe(
      "请一次决定以下事项：\n1. 先做采集还是回顾？\n2. 规则还是本地模型？",
    );
  });

  it("keeps action bullets after 然后 as decision context", () => {
    const analysis = analyzer.analyze({
      userText: "调整，但是位置需要斟酌一下。",
      assistantText: [
        "建议采用方案 1：",
        "",
        "然后：",
        "",
        "- 删除 `application/dto/internal/file.create.input.ts`。",
        "- `FileRepo.createFile(dto)` 改为 `createFile(file)`。",
        "- 增加架构回归断言。",
        "",
        "按这个方案执行可以吗？",
      ].join("\n"),
    });

    expect(analysis).toMatchObject({
      question: "按这个方案执行可以吗？",
      options: [],
      context: {
        decisionFraming: expect.stringContaining(
          "- 增加架构回归断言。",
        ),
      },
    });
  });

  it("still recognizes bullet choices after a choice heading", () => {
    const analysis = analyzer.analyze({
      userText: "继续开发。",
      assistantText: [
        "可选方案：",
        "",
        "- 规则优先",
        "- 模型优先",
        "",
        "请选择一种方案",
      ].join("\n"),
    });

    expect(analysis).toMatchObject({
      options: [
        { label: "规则优先" },
        { label: "模型优先" },
      ],
      context: {
        decisionFraming: "可选方案：",
      },
    });
  });

  it.each(corpus)(
    "classifies $name as $expectedBand",
    (item) => {
      expect(completed(item)).toBe(item.expectedBand);
    },
  );

  it("matches short, combined and option-label answers", () => {
    const pending = analyzer.analyze({
      userText: "选择路线。",
      assistantText:
        "1. 先规则\n2. 先模型\n3. 先规则再模型\n\n请选择方案",
    });
    if (pending === null) {
      throw new Error("expected a pending analysis");
    }

    for (const answer of [
      "1",
      "可以",
      "不要",
      "先 1 后 3",
      "按你的建议",
      "先规则再模型",
    ]) {
      expect(analyzer.complete(pending, answer).band).toBe(
        "high",
      );
    }
  });

  it("treats a direct no-punctuation alternative as a clear decision", () => {
    const pending = analyzer.analyze({
      userText: "继续开发功能。",
      assistantText: "先补测试还是先改实现",
    });
    if (pending === null) {
      throw new Error("expected a pending analysis");
    }

    expect(
      analyzer.complete(pending, "先补测试"),
    ).toMatchObject({
      band: "high",
      signals: expect.arrayContaining([
        "has_inline_alternatives",
        "answer_lexically_related",
      ]),
    });
  });

  it("recognizes English or-choices with a neutral post-question tail", () => {
    const pending = analyzer.analyze({
      userText: "Choose the implementation order.",
      assistantText:
        "Tests first or implementation first? Both are viable.",
    });

    expect(pending).toMatchObject({
      signals: expect.arrayContaining(["has_inline_alternatives"]),
    });
    expect(analyzer.complete(pending!, "Tests first.")).toMatchObject({
      band: "high",
      signals: expect.arrayContaining(["answer_lexically_related"]),
    });
  });

  it("keeps an explicit Chinese confirmation after the choice question", () => {
    const pending = analyzer.analyze({
      userText: "确认错误展示策略。",
      assistantText:
        "错误信息对外展示详细原因还是统一提示？请确认。",
    });

    expect(pending).not.toBeNull();
    expect(analyzer.complete(pending!, "统一提示。").band).toBe("high");
  });

  it("does not treat neutral viability after a question as a concession", () => {
    const pending = analyzer.analyze({
      userText: "Choose pagination.",
      assistantText: "分页使用游标还是页码？两者都能实现。",
    });

    expect(analyzer.complete(pending!, "使用游标。").band).toBe("high");
  });

  it("recognizes English alternatives followed by an explicit chooser", () => {
    const pending = analyzer.analyze({
      userText: "Choose the storage boundary.",
      assistantText:
        "We can share the table or create a bounded table. Please choose.",
    });

    expect(analyzer.complete(pending!, "Create a bounded table.").band).toBe(
      "high",
    );
  });

  it.each([
    "I recommend removing the compatibility branch. Please confirm before I continue.",
    "The rollout can proceed, but the final call is yours.",
    "建议先关闭实验入口。确认后我再执行。",
  ])("recognizes bounded approval framing: %s", (assistantText) => {
    expect(
      analyzer.analyze({ userText: "Review the action.", assistantText }),
    ).not.toBeNull();
  });

  it.each([
    "Should we split the module? I decided to keep one module and I am implementing it now.",
    "Diff:\n- Should we use A?\n+ Use B by default.\nThe patch is complete.",
  ])("rejects a self-resolved post-question tail: %s", (assistantText) => {
    expect(
      analyzer.analyze({ userText: "Continue the task.", assistantText }),
    ).toBeNull();
  });

  it("keeps a repository-path information request out of choice detection", () => {
    expect(
      analyzer.analyze({
        userText: "Open the repository.",
        assistantText: "这个仓库放在哪个路径？",
      }),
    ).toBeNull();
  });

  it("recognizes punctuated approval without bypassing implicit review", () => {
    const english = analyzer.analyze({
      userText: "Review the migration.",
      assistantText: "The migration is ready and awaiting your confirmation.",
    });
    const chinese = analyzer.analyze({
      userText: "确认下一步。",
      assistantText: "迁移脚本已准备好，等待你的确认。",
    });

    expect(analyzer.complete(english!, "Go ahead.")).toMatchObject({
      band: "medium",
      signals: expect.arrayContaining(["answer_is_explicit_approval"]),
    });
    expect(analyzer.complete(chinese!, "继续。")).toMatchObject({
      band: "medium",
      signals: expect.arrayContaining(["answer_is_explicit_approval"]),
    });
  });

  it("keeps an approved implicit recommendation in candidate review", () => {
    const pending = analyzer.analyze({
      userText: "提高普通文本决策的采集质量。",
      assistantText:
        "本地规则成本最低。我倾向先做规则版本，等你确认后再继续。",
    });

    expect(analyzer.complete(pending!, "可以")).toMatchObject({
      band: "medium",
      signals: expect.arrayContaining(["implicit_confirmation_cap"]),
    });
  });

  it("uses weaker directional approval with the strength of its framing", () => {
    const strong = analyzer.analyze({
      userText: "Confirm the public API.",
      assistantText:
        "Renaming the public method is a product trade-off, so I will wait for your confirmation.",
    });
    const bounded = analyzer.analyze({
      userText: "Confirm the rollout.",
      assistantText:
        "The rollout can proceed, but the final call is yours.",
    });

    expect(analyzer.complete(strong!, "Do not rename it.").band).toBe("medium");
    expect(analyzer.complete(strong!, "Keep the old name.").band).toBe(
      "medium",
    );
    expect(analyzer.complete(bounded!, "Do not roll it out yet.").band).toBe(
      "medium",
    );
  });

  it.each([
    {
      assistantText: "先修测试还是先调整接口？",
      answer: "先修测试。另外，请解释接口为什么会破坏兼容性。",
    },
    {
      assistantText: "Fix the tests first or change the API first?",
      answer: "Fix the tests first, and explain why the API breaks compatibility.",
    },
  ])("caps a related mixed answer at medium", ({ assistantText, answer }) => {
    const pending = analyzer.analyze({
      userText: "Choose the next step.",
      assistantText,
    });

    expect(analyzer.complete(pending!, answer)).toMatchObject({
      band: "medium",
      signals: expect.arrayContaining(["answer_is_mixed"]),
    });
  });

  it("still rejects an unrelated new task after an English alternative", () => {
    const pending = analyzer.analyze({
      userText: "Choose the next step.",
      assistantText: "Fix caching or build search first?",
    });

    expect(
      analyzer.complete(pending!, "Please add an export button."),
    ).toMatchObject({
      band: "low",
      signals: expect.arrayContaining(["unrelated_new_task"]),
    });
  });

  it("rejects an explanatory concessive alternatives sentence", () => {
    expect(
      analyzer.analyze({
        userText: "继续当前任务。",
        assistantText:
          "无论使用 SQLite 还是 JSON，都可以支持这个流程。",
      }),
    ).toBeNull();
  });

  it("rejects a clearly unrelated next task", () => {
    const pending = analyzer.analyze({
      userText: "选择路线。",
      assistantText: "先做规则还是先做模型？",
    });
    if (pending === null) {
      throw new Error("expected a pending analysis");
    }

    expect(
      analyzer.complete(
        pending,
        "帮我实现一个新的登录页面，并添加 OAuth。",
      ),
    ).toMatchObject({
      band: "low",
      signals: expect.arrayContaining(["unrelated_new_task"]),
    });
  });

  it("does not preserve a high request score across a topic change", () => {
    const pending = analyzer.analyze({
      userText: "继续当前任务。",
      assistantText: "现在继续吗？",
    });
    if (pending === null) {
      throw new Error("expected a pending analysis");
    }

    expect(
      analyzer.complete(pending, "换个话题"),
    ).toMatchObject({
      band: "low",
      signals: expect.arrayContaining(["unrelated_new_task"]),
    });
  });

  it("bounds combined context to 6000 characters", () => {
    const analysis = analyzer.analyze({
      userText: `任务背景 ${"甲".repeat(3_900)}`,
      assistantText:
        `约束 ${"乙".repeat(3_900)}\n\n` +
        "1. 方案一\n2. 方案二\n\n请选择一种方案",
    });

    const context = analysis?.context;
    expect(
      (context?.taskBackground?.length ?? 0) +
        (context?.decisionFraming?.length ?? 0),
    ).toBeLessThanOrEqual(6_000);
    expect(context?.truncated).toBe(true);
  });

  it("meets corpus precision and recall thresholds", () => {
    const results = corpus.map((item) => ({
      ...item,
      actualBand: completed(item),
    }));
    const high = results.filter(
      (item) => item.actualBand === "high",
    );
    const highTrue = high.filter((item) => item.humanDecision);
    const positives = results.filter((item) => item.humanDecision);
    const recalled = positives.filter(
      (item) => item.actualBand !== "low",
    );

    expect(highTrue.length / high.length).toBeGreaterThanOrEqual(
      0.95,
    );
    expect(
      recalled.length / positives.length,
    ).toBeGreaterThanOrEqual(0.9);
  });

  it("analyzes a bounded 64 KiB turn within the local budget", () => {
    const input = {
      userText: "继续开发。",
      assistantText:
        `${"背景说明。".repeat(10_000)}\n\n` +
        "1. 先规则\n2. 先模型\n\n请选择方案",
    };
    const durations = Array.from({ length: 200 }, () => {
      const start = performance.now();
      analyzer.analyze(input);
      return performance.now() - start;
    }).sort((left, right) => left - right);
    const p95 =
      durations[Math.floor(durations.length * 0.95)] ??
      Number.POSITIVE_INFINITY;

    expect(p95).toBeLessThanOrEqual(150);
  });
});
