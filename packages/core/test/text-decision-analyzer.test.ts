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
  it.each(["确认", "执行", "批准", "执行吧"])("recognizes short approval %s only after an open request", (answer) => {
    const pending = analyzer.analyze({ userText: null, assistantText: "修改尚未发布。请回复确认，我就提交并推送。" });
    expect(pending).not.toBeNull();
    expect(analyzer.complete(pending!, answer).band).not.toBe("low");
    expect(analyzer.analyze({ userText: null, assistantText: "修改已完成，测试通过。" })).toBeNull();
  });
  it("preserves approval with an added task as a mixed answer", () => {
    const pending = analyzer.analyze({ userText: null, assistantText: "要我现在发布吗？" })!;
    const completed = analyzer.complete(pending, "确认，另外创建一个测试任务。");
    expect(completed.band).not.toBe("low");
    expect(completed.signals).toContain("answer_is_mixed");
    expect(completed.signals).not.toContain("unrelated_new_task");
  });
  it("separates completed status, task numbers and partial scope approval", () => {
    const pending = analyzer.analyze({ userText: null, assistantText: "1. 实现复制\n2. 增加导航\n\n要我现在做吗？" })!;
    expect(analyzer.complete(pending, "合并了")).toMatchObject({ band: "low", signals: expect.arrayContaining(["answer_is_status_update"]) });
    expect(analyzer.complete(pending, "处理1、2即可，3不用").band).not.toBe("low");
    expect(analyzer.complete(pending, "PR①已合入，建PR②").signals).not.toContain("answer_matches_option");
  });
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

  it("does not turn a batch of questions into a list of choices", () => {
    // A real capture: seven independent design questions, each with its own
    // recommendation, became seven mutually exclusive options whose labels
    // were whole paragraphs. They are not alternatives — nobody offered a
    // choice between them.
    const analysis = analyzer.analyze({
      userText: null,
      assistantText: [
        "这轮评审有几处要你定：",
        "",
        "1. **`name` 加进 tenant 的公共类型，还是留在本地类型。** 建议进 tenant。",
        "2. **converter 用静态类还是模块函数。** 建议随既有惯例。",
        "3. **未解析成员视图是否收窄。** 建议本次逐字节保持。",
        "4. **服务改名为 hydrator。** 建议独立 PR 只做改名。",
      ].join("\n"),
    });

    expect(analysis?.options ?? []).toEqual([]);
    // The text itself is still the request, so the reader sees all of it.
    expect(analysis?.question).toContain("converter 用静态类还是模块函数");
  });

  it("reads an item that recommends itself as a question, not a choice", () => {
    // The second real capture: the items carry their own 建议 rather than
    // their own 还是, and only three of seven read as questions. An option
    // does not recommend itself — that mark alone gives the batch away.
    const analysis = analyzer.analyze({
      userText: null,
      assistantText: [
        "几处要你定：",
        "",
        "1. **第 1 步是否与本次同 PR。** 建议拆开先合：它没有行为变化。",
        "2. **物化器直接消费 tenant 的 PO 类型。** 建议照做，少一层转换。",
        "3. **ADR 需要同步。** 建议本次一起改掉。",
      ].join("\n"),
    });

    expect(analysis?.options ?? []).toEqual([]);
  });

  it("keeps real options when only one of them happens to read as a question", () => {
    // The threshold is what separates "these items are questions" from "one
    // option's prose contains 还是". Requiring a single such item would throw
    // away a genuine pair of alternatives.
    const analysis = analyzer.analyze({
      userText: null,
      assistantText: [
        "两种切换方式：",
        "",
        "1. 一次性同步改，两个仓库同版本发布。",
        "2. 后端过渡期双写，前端改完后再摘掉，还是要留一个开关。",
        "",
        "你希望走哪一种？",
      ].join("\n"),
    });

    expect(analysis?.options).toHaveLength(2);
  });

  it("still reads a plain numbered list as the choices it is", () => {
    const analysis = analyzer.analyze({
      userText: null,
      assistantText: [
        "两种实现方式：",
        "",
        "1. 先规则后模型",
        "2. 直接本地模型",
        "",
        "请选择一种方案",
      ].join("\n"),
    });

    expect(analysis?.options.map((option) => option.label)).toEqual([
      "先规则后模型",
      "直接本地模型",
    ]);
  });

  it("keeps the decision when the message closes on another remark", () => {
    // The same design question, with a closing note after the recommendation.
    // The reader answered the options, not the note, so the note is framing.
    const analysis = analyzer.analyze({
      userText: null,
      assistantText: [
        "**问题 9（契约怎么切换）**：`_display` 是线上契约，旧前端配新后端会丢标签。",
        "",
        "- **A**：一次性同步改，两个仓库同版本发布。",
        "- **B**：后端过渡期双写，前端改完后再摘掉。",
        "",
        "我建议 **A**。同版本发布本来就是这个项目的发版惯例。",
        "",
        "还有一处待定，我不替你决定：MCP 返回的键叫 `display`。要不要一并改成 `title`，等这题定了我再问。",
      ].join("\n"),
    });

    expect(analysis?.question).toBe(
      "**问题 9（契约怎么切换）**：`_display` 是线上契约，旧前端配新后端会丢标签。",
    );
    expect(analysis?.signals).toContain("options_before_closing_remark");
    // The emphasis is markup, not the option's name.
    expect(analysis?.options.map((option) => option.id)).toEqual(["A", "B"]);
    expect(analysis?.options[0]?.label).toBe(
      "一次性同步改，两个仓库同版本发布。",
    );
    expect(
      analyzer.complete(analysis!, "A").signals,
    ).toContain("answer_matches_option");
    // The closing remark is still shown; it is part of what was said.
    expect(analysis?.context?.decisionFraming).toContain("还有一处待定");
  });

  it("needs the recommendation to name an option, not merely exist", () => {
    // A list of finished work followed by advice and a question: nothing here
    // asks the reader to pick from the list, and pairing them would invent a
    // decision out of a progress report.
    const analysis = analyzer.analyze({
      userText: null,
      assistantText: [
        "我做了两处改动：",
        "",
        "- 改了缓存键的拼法。",
        "- 改了失效时间。",
        "",
        "我建议接下来先补一轮回归测试。",
        "",
        "要不要我现在就跑？",
      ].join("\n"),
    });

    expect(analysis?.signals ?? []).not.toContain(
      "options_before_closing_remark",
    );
    expect(analysis?.options ?? []).toEqual([]);
  });

  it("reads a design question that ends on a recommendation", () => {
    // The shape a design conversation actually takes: a numbered question, an
    // option per bullet, and a recommendation instead of a question mark.
    // Nothing here matches the choice-prompt vocabulary, so the whole exchange
    // used to be invisible.
    const analysis = analyzer.analyze({
      userText: "继续。",
      assistantText: [
        "问题 21（修订）：",
        "",
        "- A: 只做读取兜底，不写迁移也不改 seed。",
        "- B: seed metadata 直接写 data_title，读取端不做兜底。",
        "- C: 在 B 的基础上保留读取兜底，作为过渡期安全网。",
        "",
        "我建议 C。B 的问题是迁移脚本本来人在发版时手动跑，和代码上线之间没有任何强制顺序保证。",
      ].join("\n"),
    });

    expect(analysis).not.toBeNull();
    expect(analysis?.signals).toContain("recommends_one_option");
    // The letter is what the reader types back, so it has to be the id.
    expect(analysis?.options.map((option) => option.id)).toEqual([
      "A",
      "B",
      "C",
    ]);
    expect(analysis?.options[0]?.label).toBe(
      "只做读取兜底，不写迁移也不改 seed。",
    );
  });

  it("needs options under the recommendation, not just the word", () => {
    // "我建议" on its own is prose. Only a laid-out choice makes it a decision
    // point, or every explanatory paragraph would become a candidate.
    expect(
      analyzer.analyze({
        userText: "继续。",
        assistantText:
          "我看了一遍缓存层。\n\n我建议先把失效逻辑抽出来，再谈并发。",
      }),
    ).toBeNull();
  });

  it("lands a bare letter on the option it names", () => {
    const pending = analyzer.analyze({
      userText: "选一个。",
      assistantText: [
        "问题 22：",
        "",
        "- A: 维持现状写死 name。",
        "- B: 让用户在导入映射时选定匹配字段。",
        "- C: 改用生效标题字段里的第一个文本类字段。",
        "",
        "我建议 B。",
      ].join("\n"),
    });
    if (pending === null) {
      throw new Error("expected a pending analysis");
    }

    for (const answer of ["A", "a", "先A，记下来，完成后继续走那条线"]) {
      expect(analyzer.complete(pending, answer).band).toBe("high");
    }
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
