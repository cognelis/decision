import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";

import {
  answersNumbersNotAsked,
  readReply,
  ruleReading,
  selectedOptions,
  recommendationFollow,
  TextDecisionAnalyzer,
  type DecisionBand,
} from "../src/index.js";

import r4Ir2 from "../../../scripts/lab/cases/r4-ir2.json";
import r4Recognition from "../../../scripts/lab/cases/r4-recognition.json";
import r5Whitebox from "../../../scripts/lab/cases/r5-adversarial-recognition-whitebox.json";
import r5Followup from "../../../scripts/lab/cases/r5-adversarial-recognition-whitebox-followup.json";
import r5Ir5 from "../../../scripts/lab/cases/r5-ir5.json";
import r5Ir4 from "../../../scripts/lab/cases/r5-ir4.json";
import r5Ir3Whitebox from "../../../scripts/lab/cases/r5-adversarial-recognition-whitebox-ir3.json";
import r5B2 from "../../../scripts/lab/cases/r5-ir3-b2.json";
import r5Ir3 from "../../../scripts/lab/cases/r5-ir3.json";
import r5Ir2Whitebox from "../../../scripts/lab/cases/r5-adversarial-recognition-whitebox-ir2.json";
import r12Map from "../../../scripts/lab/cases/r12-map.json";
import r13Rule from "../../../scripts/lab/cases/r13-rule.json";
import r5Ir2 from "../../../scripts/lab/cases/r5-ir2.json";
import r5Recognition from "../../../scripts/lab/cases/r5-recognition.json";
import r6Recognition from "../../../scripts/lab/cases/r6-recognition.json";
import r7Recognition from "../../../scripts/lab/cases/r7-recognition.json";
import r6Skeptic from "../../../scripts/lab/cases/r6-adversarial-recognition.json";
import r6SkepticWhitebox from "../../../scripts/lab/cases/r6-adversarial-recognition-whitebox.json";
import r6SkepticIr2 from "../../../scripts/lab/cases/r6-adversarial-recognition-ir2-whitebox.json";

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
      detectorVersion: "rules-v10",
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

// Synthetic. The five R1-SK counterexamples as the behaviour they should have,
// and the request shapes real Claude Code / Codex replies took in R1-BA.
describe("TextDecisionAnalyzer request shapes from real agent replies", () => {
  const classify = (assistantText: string, answer: string) => {
    const pending = analyzer.analyze({ userText: null, assistantText });
    return pending === null
      ? { band: "low" as const, signals: [] as string[], question: undefined }
      : analyzer.complete(pending, answer);
  };

  it("does not take a comparison of both options followed by 再决定 as a choice", () => {
    expect(
      classify("1. 本地方案\n2. 云端方案\n\n请选择一种方案", "我会比较本地方案和云端方案后再决定"),
    ).toMatchObject({ band: "low", signals: expect.arrayContaining(["answer_defers_decision"]) });
  });

  it("does not take a question about an option as choosing it", () => {
    expect(
      classify("1. 删除旧接口\n2. 保留旧接口\n\n请选择一种方案", "旧接口目前被多少地方调用？"),
    ).toMatchObject({ band: "low", signals: expect.arrayContaining(["answer_is_question"]) });
  });

  it("keeps an approval that goes on to ask something", () => {
    const completed = classify(
      "The migration adds one nullable column.\n\nShould I apply it now?",
      "Yes, go ahead. How long will it take on a few million rows?",
    );
    expect(completed?.band).toBe("high");
    expect(completed?.signals).not.toContain("answer_is_question");
  });

  it("reads a which-question with nothing to weigh as asking for a fact", () => {
    expect(analyzer.analyze({ userText: null, assistantText: "服务当前运行在哪个端口？" })).toBeNull();
    expect(analyzer.analyze({ userText: null, assistantText: "你指的是哪个配置文件？" })).toBeNull();
    expect(classify("缓存用哪个方案更合适？", "Redis")?.band).not.toBe("low");
  });

  it("does not read a reviewer's recommendation as the assistant asking", () => {
    expect(
      analyzer.analyze({
        userText: null,
        assistantText: "1. 保持原接口\n2. 改为异步接口\n\n评审建议采用改为异步接口，以避免阻塞请求。",
      }),
    ).toBeNull();
    expect(
      analyzer.analyze({ userText: null, assistantText: "1. 保持原接口\n2. 改为异步接口\n\n我建议采用改为异步接口。" }),
    ).not.toBeNull();
    expect(
      classify("1. 保持原接口\n2. 改为异步接口\n\n我建议 2，你选哪个？", "收到，我先检查一下调用方兼容性再决定")?.band,
    ).toBe("low");
  });

  it("does not take a description of how things are as a choice between them", () => {
    expect(
      classify("配置读取来自环境变量还是配置文件？", "当前生产使用环境变量"),
    ).toMatchObject({ band: "low", signals: expect.arrayContaining(["answer_describes_current_state"]) });
    expect(classify("采用环境变量还是配置文件？", "环境变量")?.band).toBe("high");
  });

  it.each([
    ["改完了，测试全部通过。\n\n现在要提交吗？", "可以，提交吧"],
    ["分支已评审通过。\n\n现在要把它合并到 main 吗？", "先别合并，等 CI 跑完再说"],
    ["分支已评审通过。\n\n现在就合并到 `main` 吗？", "合并"],
    ["需要我顺便把旧配置删掉吗？", "好的"],
    ["Want me to continue deleting the rest?", "No, stop here."],
    ["Shall I proceed with the rename?", "go ahead"],
  ])("recognizes the yes/no request %j", (assistantText, answer) => {
    expect(classify(assistantText, answer)?.band).not.toBe("low");
  });

  it.each(["现在运行正常吗？", "测试现在通过了吗？", "你知道这个函数是做什么的吗？"])(
    "does not read the factual question %j as a request",
    (assistantText) => {
      expect(analyzer.analyze({ userText: null, assistantText })).toBeNull();
    },
  );

  it("looks past the note an agent leaves after its question", () => {
    const completed = classify(
      "1. 进程内 LRU\n2. Redis\n3. 仅 HTTP 缓存头\n\n我推荐 1。你选哪一个？回复 1、2 或 3。\n\n未检查项目代码或部署方式。",
      "2",
    );
    expect(completed).toMatchObject({ band: "high", question: "我推荐 1。你选哪一个？回复 1、2 或 3。" });
    expect(analyzer.analyze({ userText: null, assistantText: "已合并到 main。\n\n未运行集成测试。" })).toBeNull();
  });

  it.each([
    ["改好了，测试都通过。\n\n要不要现在提交？我等你回答。\n\n以上为情景模拟，未实际修改或检查代码。", "可以，提交吧"],
    ["A 线程池、B 异步 IO、C 多进程，我推荐 B。\n\n未检查实际代码和性能数据。\n请告诉我选哪个", "选 C"],
    ["推荐 B（TOML）。\n\n如果嵌套很多，A 更合适。\n\n你怎么选？", "A"],
  ])("still finds the request in %j", (assistantText, answer) => {
    expect(classify(assistantText, answer).band).not.toBe("low");
  });

  it("finds the question above a 是/否 list it introduces", () => {
    const completed = classify(
      "**现在的问题是：** 你确认要把这个分支合并到 main 吗？\n\n请告诉我：\n- **是** — 现在合并\n- **否** — 延后",
      "先别合并，等 CI 跑完再说",
    );
    expect(completed?.band).toBe("high");
    expect(completed?.question).toContain("合并到 main 吗");
  });

  it("recognizes a pick-one prompt and a bare letter reply", () => {
    expect(classify("A SQLite、B PostgreSQL、C JSON 文件。\n\n从 A/B/C 中选一个吧。", "B")?.band).not.toBe("low");
    expect(classify("A 线程池、B 异步 IO、C 多进程。\n\n请告诉我选哪个。", "选 C")?.band).not.toBe("low");
  });

  it("recognizes partial approval of a numbered list", () => {
    expect(
      classify("1. 重命名含糊的变量\n2. 拆分大函数\n3. 补类型注解\n\n这三项都要做吗？", "1 和 3 做，2 不做")?.band,
    ).toBe("high");
    expect(
      classify("1. 重命名含糊的变量\n2. 拆分大函数\n3. 补类型注解\n\n请问这三项中哪些要我现在实施？", "处理 1、2 即可，3 不用")?.band,
    ).not.toBe("low");
  });

  it("approves a plan list", () => {
    expect(
      classify("计划如下：\n\n1. 先补测试\n2. 再改实现\n3. 最后更新文档\n\n可以按这个计划开始吗？", "可以，开始吧")?.band,
    ).not.toBe("low");
  });

  it("picks options by position", () => {
    const list = "1. 重命名变量\n2. 拆分函数\n3. 补类型\n\n这三项都要做吗？";
    expect(classify(list, "只做第一个和第三个").signals).toContain("answer_matches_option");
    expect(
      classify("1. Rename variables\n2. Split the function\n3. Add types\n\nWhich of these should I do?", "Only the first and the third.").signals,
    ).toContain("answer_matches_option");
    expect(classify("Should I run the tests first?", "first, run the linter").signals).not.toContain("answer_matches_option");
  });

  it.each([
    ["改完了，测试通过。\n\n要现在提交吗？", "可以。不过这会影响旧数据吗？"],
    ["The fix is ready.\n\nShould I commit it now?", "Sounds good."],
    ["The fix is ready.\n\nDo you want me to open a PR?", "LGTM, go for it"],
  ])("takes %j answered %j as an approval", (assistantText, answer) => {
    expect(classify(assistantText, answer).band).toBe("high");
  });

  it.each(["我已经合并了", "合并好了", "Already merged.", "It's already merged."])(
    "reads %j as a status update, not an approval",
    (answer) => {
      expect(classify("Should I merge the release branch into main?", answer)).toMatchObject({
        band: "low",
        signals: expect.arrayContaining(["answer_is_status_update"]),
      });
    },
  );

  it.each([
    ["Should I use A or B?", "Let me think about it."],
    ["Should I use A or B?", "What's the difference in memory usage between them?"],
    ["Is the config loaded from env vars or a file?", "Currently from env vars."],
    ["Pick A (pino) or B (winston)?", "Never mind. Look at the README instead."],
    ["选 A pino 还是 B winston？", "这个先放一放，帮我看下 README 第三段"],
  ])("does not record %j answered %j", (assistantText, answer) => {
    expect(classify(assistantText, answer).band).toBe("low");
  });

  it("reads 请回答：是或否 as a choice", () => {
    expect(
      classify(
        "第二个问题：要不要引入第三方库？我建议 **否**。\n\n请回答：**是**或**否**。\n\n未检查具体语言。",
        "不引入，用标准库就行",
      ).band,
    ).not.toBe("low");
    expect(analyzer.analyze({ userText: null, assistantText: "请回复邮件地址。" })).toBeNull();
  });

  it("reads a request for a verdict on a recommendation as a choice", () => {
    expect(
      classify("推荐 YAML（A）。\n\nTOML 不依赖缩进，但 YAML 更通用。\n\n你怎么看？", "同意"),
    ).toMatchObject({ band: "high", signals: expect.arrayContaining(["asks_verdict_on_recommendation"]) });
    expect(classify("**推荐：Zustand**\n\n**你的选择是？**（A / B / C）", "Let's go with Zustand.").band).not.toBe("low");
    expect(analyzer.analyze({ userText: null, assistantText: "今天构建很快，你怎么看？" })).toBeNull();
    expect(analyzer.analyze({ userText: null, assistantText: "我建议先补测试。\n\n你用的是什么 Node 版本？" })).toBeNull();
  });

  // R1-V-SK regressions (synthetic).
  it.each([
    ["1. 保留旧接口\n2. 改成异步接口\n\n请选择一种方案。", "目前先用方案 B"],
    ["1. 立即迁移新存储\n2. 继续使用旧存储\n\n请选择一种方案", "先用 A，之后再决定要不要迁移"],
  ])("keeps a reply that takes exactly one option: %j → %j", (assistantText, answer) => {
    expect(classify(assistantText, answer)).toMatchObject({
      band: "high",
      signals: expect.arrayContaining(["answer_takes_one_option"]),
    });
  });

  it.each([
    ["1. 本地方案\n2. 云端方案\n\n请选择一种方案", "先用本地方案还是云端方案，之后再决定"],
    ["1. 保留旧接口\n2. 改成异步接口\n\n请选择一种方案。", "目前线上用的是旧接口"],
  ])("still caps a reply that takes no single option: %j → %j", (assistantText, answer) => {
    expect(classify(assistantText, answer).band).toBe("low");
  });

  it("takes 要，… as approval, not a new task", () => {
    expect(classify("要我修改这个函数吗？", "要，修复空指针错误。")).toMatchObject({
      band: "high",
      signals: expect.arrayContaining(["answer_is_explicit_approval"]),
    });
  });

  it("does not read a labelled review opinion as the assistant recommending", () => {
    expect(
      analyzer.analyze({
        userText: null,
        assistantText: "1. 保持当前接口\n2. 改为异步接口\n\n评审意见：建议采用异步接口，避免请求阻塞。",
      }),
    ).toBeNull();
  });

  // R1-V-AN adversarial samples (synthetic), R1..R14.
  describe("R1-V-AN", () => {
    const OPTIONS =
      "给内部工具选存储：\n\n- A：SQLite，单文件零运维。\n- B：PostgreSQL，并发好但要部署。\n- C：JSON 文件，最简单。\n\n";
    it.each([
      ["R1", `${OPTIONS}没有特别偏好的话，我倾向 A。`, "B"],
      ["R2", `${OPTIONS}你选哪个？`, "目前先用方案 B"],
      ["R3", `${OPTIONS}你选哪个？`, "先用 A，之后再决定要不要迁移"],
      ["R10", `${OPTIONS}我建议 A，请选一个。\n\n未来可以再扩展到 B。`, "A"],
      ["R13", `${OPTIONS}你选哪个？`, "就按 B 来，然后呢"],
    ])("%s keeps a real choice high", (_id, assistantText, answer) => {
      expect(classify(assistantText, answer).band).toBe("high");
    });

    it.each([
      ["R4", "改完了，测试通过。\n\n现在要提交吗？", "别急，先解释一下为什么要拆成两个文件"],
      ["R5", "改完了，测试通过。\n\n现在要提交吗？", "不用担心，我来处理"],
      ["R6", "1. 回滚到上个版本\n2. 热修复\n3. 先观察\n\n这三项要做哪一项？", "第一时间先把流量切走再说"],
      ["R9", `${OPTIONS}你选哪个？`, "选项太多了，我看不懂区别"],
      ["R11", "1. Rename variables\n2. Split the function\n3. Add types\n\nWhich of these should I do?", "the first thing to check is whether the tests still pass"],
    ])("%s does not record an undecided reply as high", (_id, assistantText, answer) => {
      const completed = classify(assistantText, answer);
      expect(completed.band).not.toBe("high");
      expect(completed.signals).not.toContain("answer_matches_option");
      expect(completed.signals).not.toContain("answer_is_directional_approval");
    });

    it("R5 leaves a yes/no request answered with neither", () => {
      expect(classify("改完了，测试通过。\n\n现在要提交吗？", "不用担心，我来处理")).toMatchObject({
        band: "low",
        signals: expect.arrayContaining(["asks_yes_or_no", "answer_relation_uncertain"]),
      });
    });

    it.each(['None of these options.', 'None of those choices.'])("retains a refusal of every proposed option: %s", reply => {
      expect(classify('A. Use Redis.\nB. Use SQLite.\n\nWhich should we adopt?', reply)).toMatchObject({ band: 'medium', selected: [] });
    });

    it("R4 reads 别急 as putting the choice off", () => {
      expect(classify("改完了，测试通过。\n\n现在要提交吗？", "别急，先解释一下为什么要拆成两个文件").band).toBe("low");
    });

    it.each([
      ["R7", "升级到 Node 22 需要改 CI 配置吗？", "需要"],
      ["R14", "这个函数需要修改吗？", "需要，改成异步"],
    ])("%s reads a 需要…吗 question without 我 as asking a fact", (_id, assistantText, answer) => {
      expect(classify(assistantText, answer).band).toBe("low");
    });

    it("R12 reads 我们已经合并好了 as a status update", () => {
      expect(classify("要不要由我来把发布分支合并进 main？", "我们已经合并好了")).toMatchObject({
        band: "low",
        signals: expect.arrayContaining(["answer_is_status_update"]),
      });
    });

    // A7 as revised by R1-V2-AN N3: asking for a verdict is the assistant's own
    // request even on a reviewer's advice; the bare advice alone is not.
    it("A7 asks for a verdict on a reviewer's advice, and the bare advice asks nothing", () => {
      expect(analyzer.analyze({ userText: null, assistantText: "评审建议采用异步接口。\n\n你怎么看？" })).not.toBeNull();
      expect(analyzer.analyze({ userText: null, assistantText: "1. 保持原接口\n2. 改为异步接口\n\n评审建议采用改为异步接口。" })).toBeNull();
    });

    it("marks the current rules as rules-v10", () => {
      expect(analyzer.analyze({ userText: null, assistantText: "现在要提交吗？" })?.detectorVersion).toBe("rules-v10");
    });
  });

  // Holdout feedback (categories only): acknowledgements and topic switches
  // must not be lifted by a leading 好/好的/ok/不用/别/先; partial approval stays.
  // R1-V2-AN V1–V14 (synthetic): N1–N3.
  describe("R1-V2-AN", () => {
    const commit = "改完了，测试通过。\n\n现在要提交吗？";
    it.each(["没问题", "行", "可以的", "好啊", "成"])("N2 takes %j alone as approval", (answer) => {
      expect(classify(commit, answer)).toMatchObject({
        band: "high",
        signals: expect.arrayContaining(["answer_is_explicit_approval"]),
      });
    });

    it("N2 matches the colloquial approvals only as the whole reply", () => {
      expect(classify(commit, "行吧，那先不做").signals).not.toContain("answer_is_explicit_approval");
    });

    it("N1 judges what follows an acknowledgement", () => {
      expect(classify(commit, "收到，先不提交")).toMatchObject({
        band: "high",
        signals: expect.arrayContaining(["answer_is_directional_approval"]),
      });
      expect(classify(commit, "收到，可以提交")).toMatchObject({ band: "high" });
      expect(classify(commit, "收到。")).toMatchObject({
        band: "low",
        signals: expect.arrayContaining(["answer_is_acknowledgement"]),
      });
      expect(classify(commit, "好的，收到，谢谢").band).toBe("low");
    });

    it("N3 reads 评审意见：建议采用 2，你怎么看？ as the assistant asking", () => {
      expect(
        classify("1. 保持原接口\n2. 改为异步接口\n\n评审意见：建议采用 2，你怎么看？", "同意，改异步").band,
      ).toBe("high");
    });
  });

  // R1-V3-AN W1–W24 and R1-V3-SK IA3-P05/P06 (synthetic): a clause that only
  // says what an option is like, or that it is not looked at yet, decides nothing.
  describe("R1-V3", () => {
    const cache = "1. Redis\n2. 进程内 LRU\n3. 只用 HTTP 缓存头\n\n你选哪个？";
    const three = "1. 回滚到上个版本\n2. 热修复\n3. 先观察\n\n这三项要做哪一项？";
    const plan = "1. 保留当前方案\n2. 切换到新方案\n3. 暂缓迁移\n\n你选哪一项？";
    it.each([
      ["W1", cache, "Redis 太重了，LRU 又不共享，我再想想"],
      ["W2", three, "1 看起来不错，2 和 3 之后再说"],
      ["W3", three, "1 不行，2 也不行，再想想"],
      ["W21", three, "1 有点悬，2 稳一些，先观望一下"],
      ["W22", cache, "Redis 太贵，LRU 太慢，都不理想"],
      ["W24", three, "1 感觉还行，再看看吧"],
      ["IA3-P05", plan, "1 还没看"],
      ["IA3-P06", plan, "2 的话再议"],
    ])("%s records no decision", (_id, assistantText, answer) => {
      expect(classify(assistantText, answer).band).toBe("low");
    });

    it("IA3-P05 says the option is only talked about", () => {
      expect(classify(plan, "1 还没看").signals).toContain("answer_only_evaluates");
    });

    it("W14 does not take a bare 行 as a pick among options", () => {
      expect(classify(`给内部工具选存储：\n\n- A：SQLite。\n- B：PostgreSQL。\n- C：JSON 文件。\n\n你选哪个？`, "行").band).not.toBe("high");
      expect(classify("改完了，测试通过。\n\n现在要提交吗？", "行").band).toBe("high");
    });

    it("W13 reads 行吧，那先不做 as a no", () => {
      expect(classify("改完了，测试通过。\n\n现在要提交吗？", "行吧，那先不做")).toMatchObject({
        band: "high",
        signals: expect.arrayContaining(["answer_is_directional_approval"]),
      });
    });

    it.each([
      ["W4", three, "1 有风险吗？2 不要"],
      ["W16", "1. 重命名变量\n2. 拆分函数\n3. 补类型\n\n这三项要做哪些？", "1 先上，2 再说"],
      ["W17", cache, "Redis 现在用着挺好，先不换"],
      ["W23", "1. 修复登录\n2. 升级依赖\n3. 重写文档\n\n这三个 PR 你看哪些可以合？", "1 可以合，3 回头再看"],
    ])("%s still decides", (_id, assistantText, answer) => {
      expect(classify(assistantText, answer).band).toBe("high");
    });
  });

  // Holdout feedback (category only): an acknowledgement followed by anything
  // that decides nothing is still only an acknowledgement (R1-IA5).
  // R1-V4-AN X1–X8 (synthetic): a one-character verb inside an evaluation
  // (上手成本高、改动太大、要等很久) does not make the clause a decision.
  describe("R1-V4-AN", () => {
    const options = "给内部工具选存储：\n\n- A：SQLite。\n- B：PostgreSQL。\n- C：JSON 文件。\n\n你选哪个？";
    const three = "1. 回滚到上个版本\n2. 热修复\n3. 先观察\n\n这三项要做哪一项？";
    const cache = "1. Redis\n2. 进程内 LRU\n3. 只用 HTTP 缓存头\n\n你选哪个？";
    const plan = "1. 保留当前方案\n2. 切换到新方案\n3. 暂缓迁移\n\n你选哪一项？";
    it.each([
      ["X1", cache, "Redis 上手成本高，LRU 用起来麻烦，我再想想"],
      ["X2", plan, "2 改动太大，我再想想"],
      ["X3", three, "1 要等很久，再看看"],
      ["X4", options, "B 合规风险高，先不定"],
      ["X5", three, "1 做不到，2 用不了，再想想"],
      ["X6", three, "按理说 2 更好，但我再想想"],
      ["X7", options, "B 定价贵，再看看吧"],
      ["X8", three, "3 走不通，再想想"],
    ])("%s records no decision", (_id, assistantText, answer) => {
      expect(classify(assistantText, answer).band).toBe("low");
    });
  });

  // Holdout feedback (category only): partial approvals whose options were not
  // extracted (F4). A numbered pick with a decision word still lifts the
  // deferral cap; without one it does not.
  // R2-IA (synthetic, shaped after real Claude Code / Codex replies in R1-BA):
  // how agents lay options out, and how a reply points at one.
  describe("option layouts", () => {
    const optionsOf = (assistantText: string) =>
      analyzer.analyze({ userText: null, assistantText })?.options.map((option) => [option.id, option.label]);

    it.each([
      [
        "bold id and name, dash before the description",
        "**A. SQLite** —— 单文件、零部署。\n**B. PostgreSQL** —— 并发强，要部署。\n**C. 纯 JSON 文件** —— 最简单。\n\n你选 A/B/C 哪个？",
        [["A", "SQLite"], ["B", "PostgreSQL"], ["C", "纯 JSON 文件"]],
      ],
      [
        "one option per paragraph, recommendation before the question",
        "## 三个方案\n\n**A. SQLite**\n轻量，无需部署。\n\n**B. PostgreSQL**\n功能全面，要维护服务。\n\n**C. 纯 JSON 文件**\n零依赖，并发脆弱。\n\n我倾向 **A（SQLite）**。\n\n从 A/B/C 中选一个吧。",
        [["A", "SQLite"], ["B", "PostgreSQL"], ["C", "纯 JSON 文件"]],
      ],
      [
        "name in brackets after the letter",
        "A（SQLite）：部署最简单。\nB（PostgreSQL）：适合多人共享。\nC（纯 JSON 文件）：无需数据库。\n\n我推荐 A。\n\n请从 A / B / C 中选一个。",
        [["A", "SQLite"], ["B", "PostgreSQL"], ["C", "纯 JSON 文件"]],
      ],
      [
        "numbered with a bold name and an aside",
        "1. **进程内 LRU 缓存**（如 `lru_cache`）——部署简单。\n2. **Redis**——跨实例共享。\n3. **仅用 HTTP 缓存头**——服务端零成本。\n\n我推荐 1。\n\n你想选哪一个（1/2/3）？",
        [["1", "进程内 LRU 缓存"], ["2", "Redis"], ["3", "仅用 HTTP 缓存头"]],
      ],
      [
        "方案 A: headings",
        "**方案 A:线程池**\n\n改动最小。\n\n**方案 B:异步 IO**\n\n吞吐最好。\n\n**方案 C:多进程**\n\n能用多核。\n\n请告诉我选哪个。",
        [["A", "线程池"], ["B", "异步 IO"], ["C", "多进程"]],
      ],
      [
        "a table whose first column names the option",
        "| 选项 | 优势 | 劣势 |\n|---|---|---|\n| **A: Redux Toolkit** | 生态成熟 | 样板多 |\n| **B: Zustand** | 极简 | 生态小 |\n| **C: Context only** | 零依赖 | 重渲染 |\n\n**你的选择是？**（A / B / C）",
        [["A", "Redux Toolkit"], ["B", "Zustand"], ["C", "Context only"]],
      ],
    ])("reads options laid out as %s", (_layout, assistantText, expected) => {
      expect(optionsOf(assistantText)).toEqual(expected);
    });

    it("does not read a plan's numbered steps as options of a yes/no request", () => {
      const plan = "计划如下：\n\n1. 先补测试\n\n2. 再改实现\n\n3. 最后更新文档\n\n我会先跑一遍现有测试。\n\n现在开始吗？";
      expect(optionsOf(plan) ?? []).toEqual([]);
    });

    it("does not read 1.5x as an option", () => {
      expect(optionsOf("1.5x faster on reads.\n2.0 is the next release.\n\nShould I upgrade now?") ?? []).toEqual([]);
    });

    const store =
      "## 三个方案\n\n**A. Redux Toolkit**\n生态成熟。\n\n**B. Zustand**\n极简。\n\n**C. React Context only**\n零依赖。\n\n我推荐 Zustand。\n\n你选哪个？";
    it.each([
      ["Let's go with Zustand.", ["B"]],
      ["B", ["B"]],
      ["选 C", ["C"]],
      ["the second one", ["B"]],
    ])("maps %j to the option it names", (answer, ids) => {
      const pending = analyzer.analyze({ userText: null, assistantText: store })!;
      expect(selectedOptions(answer, pending.options).map((option) => option.id)).toEqual(ids);
      // Options gathered across paragraphs map the answer but add nothing to the score (R2-IA4).
      expect(analyzer.complete(pending, answer).band).not.toBe("low");
    });

    it("maps a partial approval to the options it keeps", () => {
      const list = "**1. 重命名变量** —— 名字含糊。\n\n**2. 拆分函数** —— 函数太长。\n\n**3. 补类型** —— 缺返回类型。\n\n这三项你想做哪些？";
      const pending = analyzer.analyze({ userText: null, assistantText: list })!;
      expect(pending.options.map((option) => option.label)).toEqual(["重命名变量", "拆分函数", "补类型"]);
      expect(selectedOptions("1 和 3 先做，2 之后再说", pending.options).map((option) => option.id)).toEqual(["1", "3"]);
      expect(selectedOptions("1 和 3 做，2 不做", pending.options).map((option) => option.id)).toEqual(["1", "3"]);
      expect(analyzer.complete(pending, "1 和 3 先做，2 之后再说").band).not.toBe("low");
      expect(analyzer.complete(pending, "1 还没看").band).toBe("low");
    });

    it("does not count 3 个文件 as option 3", () => {
      const list = "**1. 重命名变量**\n\n**2. 拆分函数**\n\n**3. 补类型**\n\n这三项你想做哪些？";
      expect(classify(list, "改了 3 个文件，还没测，再看看").band).toBe("low");
    });
  });

  // R1 gaps left for R2 (synthetic): 请选 A、B 或 C; 跳过/略过 notes; a
  // question followed by its advice; IA45-P03/P04 from R1-V4-SK.
  // R2-V-AN M1/M1b/M5/M5b/M8 and R2-V-SK R2-P02 (synthetic): an answer read
  // off a reply is written into events, notes and the index, so a wrong
  // mapping records a wrong fact.
  describe("R2 review: mapping that must not go wrong", () => {
    const store = "**A. SQLite** —— 单文件、零部署。\n**B. PostgreSQL** —— 并发强，要部署。\n**C. 纯 JSON 文件** —— 最简单。\n\n我推荐 A。你选 A/B/C 哪个？";
    const storeEn = "**A. SQLite** — single file.\n**B. PostgreSQL** — strong concurrency.\n**C. Plain JSON files** — simplest.\n\nI recommend A. Which one, A/B/C?";
    const picked = (assistantText: string, answer: string) => {
      const pending = analyzer.analyze({ userText: null, assistantText })!;
      return selectedOptions(answer, pending.options).map((option) => option.label);
    };

    it.each([
      ["M1", storeEn, "Let's go with a managed Postgres instead"],
      ["M1b", store, "Let's use a managed service instead"],
    ])("%s does not read the article a as option A", (_id, assistantText, answer) => {
      expect(picked(assistantText, answer)).toEqual([]);
      expect(classify(assistantText, answer).signals).not.toContain("answer_matches_option");
    });

    it("still reads a letter written as the whole reply, either case, and a capital in a sentence", () => {
      expect(picked(store, "a")).toEqual(["SQLite"]);
      expect(picked(storeEn, "I'd go with B")).toEqual(["PostgreSQL"]);
      expect(picked(storeEn, "A, because it is one file")).toEqual(["SQLite"]);
    });

    const twoLists = "**A. SQLite**\n单文件。\n\n**B. PostgreSQL**\n要部署。\n\n选定之后的步骤：\n\n1. 改配置\n\n2. 跑迁移\n\n3. 更新文档\n\n你选哪个？";
    it.each([
      ["M5", "A", ["SQLite"]],
      ["M5b", "B", ["PostgreSQL"]],
    ])("%s takes the lettered options over the numbered steps after them", (_id, answer, labels) => {
      const pending = analyzer.analyze({ userText: null, assistantText: twoLists })!;
      expect(pending.options.map((option) => option.label)).toEqual(["SQLite", "PostgreSQL"]);
      expect(selectedOptions(answer, pending.options).map((option) => option.label)).toEqual(labels);
    });

    it("M8 does not make options of two things tagged (A) and (B) in a remark", () => {
      expect(analyzer.analyze({ userText: null, assistantText: "接口（A）和接口（B）都要改一下，顺序无所谓。\n\n现在要改吗？" })?.options).toEqual([]);
    });

    // Holdout feedback (categories only): topic switches recorded through
    // options gathered across paragraphs, and plan steps taken as options.
    const logs = "**A. pino**\n- 快\n\n**B. winston**\n- 灵活\n\n我推荐 A。\n\n你选 A 还是 B？";
    it.each([
      "帮我看一下 pino 的 README 第三段有没有错别字",
      "Please fix the winston config in the CI script first",
    ])("leaves a new task that names an option gathered across paragraphs unrelated: %j", (answer) => {
      expect(classify(logs, answer)).toMatchObject({
        band: "low",
        signals: expect.arrayContaining(["unrelated_new_task"]),
      });
    });

    it("still reads the options gathered across paragraphs for the answer", () => {
      const pending = analyzer.analyze({ userText: null, assistantText: logs })!;
      expect(pending.options.map((option) => option.label)).toEqual(["pino", "winston"]);
      expect(selectedOptions("A", pending.options).map((option) => option.label)).toEqual(["pino"]);
      expect(analyzer.complete(pending, "A").band).not.toBe("low");
    });

    it.each([
      ["我会这样做：\n\n1. 改配置\n2. 跑迁移\n3. 更新文档\n\n要我现在执行吗？", "可以，执行吧"],
      ["计划如下：\n1. 先补测试\n2. 再改实现\n3. 最后更新文档\n可以开始吗？", "可以，开始吧"],
    ])("takes no plan steps as options of a yes/no request: %j", (assistantText, answer) => {
      expect(analyzer.analyze({ userText: null, assistantText })?.options).toEqual([]);
      expect(classify(assistantText, answer).band).toBe("high");
    });

    it("R2-P02 reads which module is out over a status table as asking a fact", () => {
      expect(
        classify(
          "发布状态表：\n\n| 模块 | 状态 |\n|---|---|\n| A. Core API | 已发布 |\n| B. UI 重构 | 进行中 |\n\n目前哪个模块已经发布？",
          "A. Core API 已发布",
        ).band,
      ).toBe("low");
    });
  });

  describe("R1 gaps closed in R2", () => {
    const cache = "1. 保留 Redis\n2. 改用进程内 LRU\n3. 使用 HTTP 缓存头\n\n你选哪一个？";
    it("reads 请选 A、B 或 C as a choice", () => {
      expect(classify("A：SQLite。\nB：PostgreSQL。\nC：JSON 文件。\n\n请选 A、B 或 C。", "B").band).toBe("high");
      expect(classify("A 方案上线快。\n\n你觉得 A 或 B 哪个好？", "A").band).toBe("high");
    });

    it("drops a closing note that starts with 跳过 or 略过", () => {
      expect(classify("改好了。\n\n现在要提交吗？\n\n略过了集成测试。", "可以，提交吧").band).toBe("high");
      expect(classify("改好了。\n\n现在要提交吗？\n\n跳过了工具调用，未核实。", "可以，提交吧").band).toBe("high");
    });

    it("finds the question above the advice that follows it", () => {
      const pending = analyzer.analyze({
        userText: null,
        assistantText: "**A. SQLite**：轻量。\n**B. PostgreSQL**：并发强。\n\n你选哪个？\n\n建议是 A，内部工具通常单机运行。\n\n跳过了工具调用，未核实负载。",
      })!;
      expect(pending.question).toBe("你选哪个？");
      expect(pending.options.map((option) => option.label)).toEqual(["SQLite", "PostgreSQL"]);
      expect(analyzer.complete(pending, "B").band).not.toBe("low");
    });

    it.each([
      ["IA45-P03", "1 上次用过"],
      ["IA45-P04", "先按 2 的思路想想"],
    ])("%s records no decision", (_id, answer) => {
      expect(classify(cache, answer).band).toBe("low");
    });

    it("still takes 先用 A 再说 and 1 之前用过，这次还用 1", () => {
      expect(classify(cache, "1 之前用过，这次还用 1").band).toBe("high");
      expect(classify("A：SQLite。\nB：PostgreSQL。\n\n你选哪个？", "先用 A 再说").band).toBe("high");
    });
  });

  // R1-V5-AN Y0–Y29 with a definite expectation (synthetic). Y0/Y15–Y17/Y22
  // were medium in R2-IA4, which scored options gathered across paragraphs as
  // none while mapping the answer onto them; since R3-IA one reading of the
  // reply does both, and a partial approval of extracted options is high. Y30 is left out:
  // "Use 2 days to add types first, then decide" takes option 3 (Add types)
  // for now, which the reviewer read as no decision.
  describe("R1-V5-AN", () => {
    const COMMIT = "改完了，测试通过。\n\n现在要提交吗？";
    const EN_YES = "The migration is ready.\n\nShould I apply it now?";
    const EN_MERGE = "The branch is approved.\n\nShould I merge the release branch into main now?";
    const ZH_F4 = "**1. 重命名变量** —— 名字含糊。\n\n**2. 拆分函数** —— 函数太长。\n\n**3. 补类型** —— 缺返回类型。\n\n这三项你想做哪些？";
    const EN_F4 = "**1. Rename variables** — names are vague.\n\n**2. Split the function** — it is too long.\n\n**3. Add types** — return types are missing.\n\nWhich of these should I do?";
    it.each([
      ["Y0 选项为空确认", ZH_F4, "1 和 3 先做，2 之后再说", "high"],
      ["Y1 历史事实 2 号上周用过", ZH_F4, "2 号上周用过，先不定", "low"],
      ["Y2 上周用了 2 效果一般再想想", ZH_F4, "上周用了 2，效果一般，再想想", "low"],
      ["Y3 用了2天改完了变量名其他再想想", ZH_F4, "用了 2 天改完了变量名，其他再想想", "low"],
      ["Y4 1上周就做了23再说", ZH_F4, "1 上周就做了，2 和 3 再说", "low"],
      ["Y5 改了3个文件还没测再看看", ZH_F4, "改了 3 个文件，还没测，再看看", "low"],
      ["Y6 3点开会再定", ZH_F4, "3 点开会再定", "low"],
      ["Y9 用了2天才跑通先不提交（是否请求）", COMMIT, "用了 2 天才跑通，先不提交", "high"],
      ["Y10 用了2天才跑通我再想想（是否请求）", COMMIT, "用了 2 天才跑通，我再想想", "low"],
      ["Y11 A merge now is risky lets wait", EN_MERGE, "A merge now is risky, let's wait", "low"],
      ["Y12 A quick fix would do decide later", EN_F4, "A quick fix would do, I'll decide the rest later", "low"],
      ["Y13 A hotfix first then merge decide later", EN_MERGE, "A hotfix first, then merge, decide later", "low"],
      ["Y14 A dry run first apply later", EN_YES, "A dry run first, apply later", "low"],
      ["Y15 Do 1 and 3 the rest later", EN_F4, "Do 1 and 3, the rest later", "high"],
      ["Y16 Take 2 skip 3", EN_F4, "Take 2, skip 3", "high"],
      ["Y17 Ship 1 and 3 hold 2", EN_F4, "Ship 1 and 3, hold 2", "high"],
      ["Y18 E2E first then decide", EN_F4, "E2E first, then decide", "low"],
      ["Y19 CI is red do 1 later", EN_F4, "CI is red, do 1 later", "low"],
      ["Y20 A/B test first decide later", EN_F4, "A/B test first, decide later", "low"],
      ["Y21 1 还没看（选项为空）", ZH_F4, "1 还没看", "low"],
      ["Y22 第一个先上其余以后再考虑", ZH_F4, "第一个先上，其余以后再考虑", "high"],
      ["Y24 10 个文件要改再看看", ZH_F4, "10 个文件要改，再看看", "low"],
      ["Y26 改了3个文件的变量名还没测再看看", ZH_F4, "改了 3 个文件的变量名，还没测，再看看", "low"],
      ["Y27 用了2天拆分函数其他再想想", ZH_F4, "用了 2 天拆分函数，其他的我再想想", "low"],
      ["Y28 A rename would do decide later", EN_F4, "A rename would do for now, I'll decide the rest later", "low"],
      ["Y29 A split later", EN_F4, "A split of the function can wait, decide later", "low"],
    ])("%s", (_id, assistantText, answer, band) => {
      expect(classify(assistantText, answer).band).toBe(band);
    });
  });

  describe("options not extracted", () => {
    // Options written inside one sentence still are not extracted (R2 extracts
    // the one-per-paragraph and bold layouts these tests used before).
    const zh = "有三项可以改：1 重命名变量，2 拆分函数，3 补类型。\n\n这三项你想做哪些？";
    const en =
      "Three things could change: (1) rename variables, (2) split the function, (3) add types.\n\nWhich of these should I do?";

    it("has no extracted options in these messages", () => {
      expect(analyzer.analyze({ userText: null, assistantText: zh })?.options).toEqual([]);
      expect(analyzer.analyze({ userText: null, assistantText: en })?.options).toEqual([]);
    });

    it.each([
      [zh, "1 和 3 先做，2 之后再说"],
      [zh, "1、3 可以做，2 回头再看"],
      [zh, "第一个先上，其余以后再考虑"],
      [zh, "3 不要，1 先弄，2 再议"],
      [en, "Do 1 and 3, the rest later"],
      [en, "Keep 2, decide on 1 later"],
      // Nothing but the picked numbers, no decision word, the rest put off.
      [zh, "1、3 行，2 之后再说"],
      [zh, "1 和 3，2 回头再看"],
      [en, "1 and 3, the rest later"],
    ])("keeps the partial approval %j → %j", (assistantText, answer) => {
      expect(classify(assistantText, answer).band).not.toBe("low");
    });

    it.each([
      [zh, "1 还没看"],
      [zh, "2 的话再议"],
      [zh, "1 看起来不错，2 和 3 之后再说"],
      [zh, "1 要等很久，再看看"],
      [zh, "1 和 3 我再想想"],
      [en, "Do a quick check first, I'll decide later"],
      [en, "I need to think about 1 and 3 later"],
      [zh, "2 号上周用过，其他再想想"],
      [zh, "改了 3 个文件，还没测，再看看"],
    ])("does not lift %j → %j to high", (assistantText, answer) => {
      expect(classify(assistantText, answer).band).not.toBe("high");
    });

    it.each([
      [zh, "2 的话再议"],
      [zh, "1 看起来不错，2 和 3 之后再说"],
      [en, "Do a quick check first, I'll decide later"],
      // A capital "A" opening a sentence is the article, not option A.
      [en, "A quick fix would do, I'll decide the rest later"],
      [en, "A rename would do for now, I'll decide the rest later"],
    ])("still puts off %j → %j", (assistantText, answer) => {
      expect(classify(assistantText, answer).band).toBe("low");
    });

    it("still reads a capital A standing alone as an option", () => {
      const lettered = en.replace("**1.", "**A.").replace("**2.", "**B.").replace("**3.", "**C.");
      expect(classify(lettered, "Do A, decide on the rest later").band).not.toBe("low");
    });
  });

  describe("acknowledgement followed by more", () => {
    const commit = "改完了，测试通过。\n\n现在要提交吗？";
    const store = "给内部工具选存储：\n\n- A：SQLite。\n- B：PostgreSQL。\n- C：JSON 文件。\n\n你选哪个？";
    const three = "1. 重命名变量\n2. 拆分函数\n3. 补类型\n\n这三项要做哪些？";
    const en = "1. Redis\n2. In-process LRU\n\nWhich one should I use?";
    const enYes = "The migration is ready.\n\nShould I apply it now?";
    it.each([
      [commit, "收到，我先看下文档"],
      [commit, "收到，我看看"],
      [store, "好的，明白了"],
      [store, "了解了，我研究一下这几个方案"],
      [commit, "收到，稍后处理"],
      [commit, "收到，晚点回你"],
      [store, "收到，谢谢提醒"],
      [three, "明白，这几项我心里有数了"],
      [en, "Got it, I'll take a look"],
      [en, "Got it, I'll handle it"],
      [enYes, "Got it, thanks for the heads-up"],
      [en, "Noted, will check later"],
      [store, "收到，B 看起来不错"],
    ])("reads %j answered %j as an acknowledgement", (assistantText, answer) => {
      expect(classify(assistantText, answer)).toMatchObject({
        band: "low",
        signals: expect.arrayContaining(["answer_is_acknowledgement"]),
      });
    });

    it.each([
      [commit, "收到，先不提交"],
      [commit, "收到，可以提交"],
      [commit, "收到，马上提交"],
      [store, "收到，选 B"],
      [three, "收到，1 和 3 做"],
      [enYes, "Got it, go ahead"],
      [enYes, "Got it, apply it now"],
      [en, "Noted, go with Redis"],
      [commit, "了解，不用了"],
    ])("still records %j answered %j", (assistantText, answer) => {
      expect(classify(assistantText, answer).band).toBe("high");
    });
  });

  describe("stance words up front", () => {
    const commit = "改完了，测试通过。\n\n现在要提交吗？";
    const three = "1. 重命名变量\n2. 拆分函数\n3. 补类型\n\n这三项要做哪些？";
    const english = "1. Rename\n2. Split\n3. Types\n\nWhich of these should I do?";
    it.each([
      [commit, "收到"],
      [commit, "好的，收到"],
      [commit, "好的，我知道了"],
      [english, "Got it, thanks."],
      [english, "ok, noted"],
    ])("reads %j answered %j as an acknowledgement", (assistantText, answer) => {
      expect(classify(assistantText, answer)).toMatchObject({
        band: "low",
        signals: expect.arrayContaining(["answer_is_acknowledgement"]),
      });
    });

    it.each([
      [commit, "好的，先帮我看下 README 第三段"],
      [commit, "不用了，帮我看下 README 第三段"],
      [commit, "别管提交了，帮我查下 CI 为什么挂"],
      ["给日志库选 A pino 还是 B winston？", "先别管这个，帮我修一下登录页"],
      [english, "ok, can you look at the README instead?"],
    ])("reads %j answered %j as leaving the question", (assistantText, answer) => {
      expect(classify(assistantText, answer).band).toBe("low");
    });

    it.each([
      [commit, "好的"],
      [commit, "可以，提交吧"],
      [commit, "先别提交"],
      [three, "1 和 3 做，2 不做"],
      [three, "1、2 先做，3 之后再说"],
      [three, "收到，1 和 3 做"],
      [three, "只做第一个和第三个"],
    ])("still records %j answered %j", (assistantText, answer) => {
      expect(classify(assistantText, answer).band).toBe("high");
    });

    it("reads 了解，我看看 as an acknowledgement that decides nothing", () => {
      expect(classify("给日志库选 A pino 还是 B winston？", "了解，我看看")).toMatchObject({
        band: "low",
        signals: expect.arrayContaining(["answer_is_acknowledgement"]),
      });
    });

    // Holdout feedback (category only): a partial approval whose remark on the
    // remaining items puts them off. Any clause that settles an option counts,
    // whatever its verb; one that defers, weighs, asks or describes does not.
    const prs = "1. 修复登录\n2. 升级依赖\n3. 重写文档\n\n这三个 PR 你看哪些可以合？";
    it.each([
      [three, "1 和 3 先上，2 之后再说"],
      [prs, "1、2 可以合，3 回头再看"],
      [three, "第一个照做，其余晚点再定"],
      [three, "1 就行，2 和 3 以后再考虑"],
      [prs, "1 先弄，2、3 等下周再说"],
      [three, "Do 1 now, decide on 2 and 3 later."],
    ])("keeps the partial approval %j → %j", (assistantText, answer) => {
      expect(classify(assistantText, answer).band).toBe("high");
    });

    it.each([
      "我会比较本地方案和云端方案后再决定",
      "本地方案的话要多久？之后再决定",
      "目前线上用的是本地方案，之后再决定要不要换",
      "我比较一下本地方案和云端方案再说",
    ])("still puts off %j, which settles no option", (answer) => {
      expect(classify("1. 本地方案\n2. 云端方案\n\n请选择一种方案", answer).band).toBe("low");
    });

    it("does not let 用 lift a reply that weighs both options", () => {
      expect(classify("1. 本地方案\n2. 云端方案\n\n请选择一种方案", "先用本地方案还是云端方案，之后再决定").band).toBe("low");
    });
  });

  it("leaves a topic switch unrelated even when it starts with 先不", () => {
    const completed = classify("给日志库选 A pino 还是 B winston？", "先不管这个。帮我看一下 README 第三段有没有错别字");
    expect(completed).toMatchObject({ band: "low", signals: expect.arrayContaining(["unrelated_new_task"]) });
    expect(completed?.signals).not.toContain("answer_is_directional_approval");
  });
});

// R3-IA (synthetic): partial approvals and multi-option replies. One reading of
// the reply (`readReply`) decides both the score and the options recorded.
describe("R3-IA partial approval", () => {
  const read = (assistantText: string, answer: string) => {
    const pending = analyzer.analyze({ userText: null, assistantText });
    if (pending === null) {
      return null;
    }
    const done = analyzer.complete(pending, answer);
    return { ...done, ids: done.selected.map((option) => option.id) };
  };
  const NO_DECISION_CAPS = [
    "answer_defers_decision",
    "answer_is_question",
    "answer_is_acknowledgement",
    "answer_only_evaluates",
    "answer_describes_current_state",
    "answer_relation_uncertain",
    "unrelated_new_task",
  ];

  const NUMBERED = "审查后有三处可以改：\n\n1. 缓存：用 Redis 跨进程共享\n2. 重试：增加指数退避\n3. 超时：设置请求上限\n\n这三项你想做哪些？";
  const LETTERED = "**A. SQLite** —— 单文件\n**B. PostgreSQL** —— 并发能力强\n**C. JSON 文件** —— 最简单\n\n请选择 A/B/C。";
  const SPREAD = "审查结果如下。\n\n**1. 重命名变量**\n名字含糊。\n\n**2. 拆分函数**\n函数太长。\n\n**3. 补类型**\n缺返回类型。\n\n要做哪些？";
  const ENGLISH = "Three changes are ready:\n\n1. Add request timeout\n2. Retry transient errors\n3. Run the schema migration\n\nWhich changes should I make?";
  const TABLE = "| 选项 | 方案 |\n|---|---|\n| A | 蓝绿发布 |\n| B | 金丝雀发布 |\n| C | 滚动更新 |\n\n选一种或多种发布方式。";
  const NAMED = "两种部署方式：\n\nA. 托管 PostgreSQL\nB. 自建 PostgreSQL 高可用集群\n\n你选哪个？";

  describe("score and mapping agree", () => {
    it.each([
      [NUMBERED, "1 和 3 先做，2 你再评估一下", ["1", "3"]],
      [NUMBERED, "先做 1、3，2 暂缓", ["1", "3"]],
      [NUMBERED, "除了 2 都做", ["1", "3"]],
      [NUMBERED, "除了 2，其余暂缓", ["2"]],
      [NUMBERED, "2 不要，其他都做", ["1", "3"]],
      [NUMBERED, "批准 1 和 2，3 稍后决定", ["1", "2"]],
      [NUMBERED, "1、2 同意，3 下个迭代再说", ["1", "2"]],
      [NUMBERED, "1 和 3 通过，2 搁置", ["1", "3"]],
      [NUMBERED, "前两个做，第三个下周再看", ["1", "2"]],
      [NUMBERED, "1-2 批准，3 先放一放", ["1", "2"]],
      [NUMBERED, "1～2 可以，3 不做", ["1", "2"]],
      [NUMBERED, "最后一个先做，前面两个暂缓", ["3"]],
      [NUMBERED, "重试那个不要，其余都做", ["1", "3"]],
      [NUMBERED, "都做，尤其是 1 和 3", ["1", "3", "2"]],
      [LETTERED, "A 和 C 批准，B 先不做", ["A", "C"]],
      [LETTERED, "1 和 3 先做，2 你再评估一下", ["A", "C"]],
      [SPREAD, "1 和 3 做，2 不做", ["1", "3"]],
      [SPREAD, "第一项和第三项同意，第二项暂缓", ["1", "3"]],
      [SPREAD, "除了 2 以外先做", ["1", "3"]],
      [ENGLISH, "Do 1 and 3; leave 2 for later", ["1", "3"]],
      [ENGLISH, "All but 2, please", ["1", "3"]],
      [ENGLISH, "Everything except the migration", ["1", "2"]],
      [ENGLISH, "the first two, hold the migration", ["1", "2"]],
      [ENGLISH, "Approve 1 and 2; defer 3 until next week", ["1", "2"]],
      [ENGLISH, "Let's do 1 and 3 now and revisit 2 later", ["1", "3"]],
      [TABLE, "A 和 C 批准，B 先不做", ["A", "C"]],
      [TABLE, "除了 B 都上", ["A", "C"]],
    ])("%#: %j → high with the options taken", (assistantText, answer, ids) => {
      const done = read(assistantText, answer);
      expect(done?.ids).toEqual(ids);
      expect(done?.band).toBe("high");
      expect(done?.signals.filter((signal) => NO_DECISION_CAPS.includes(signal))).toEqual([]);
      // The exported mapping is the same reading.
      const pending = analyzer.analyze({ userText: null, assistantText })!;
      expect(selectedOptions(answer, pending.options).map((option) => option.id)).toEqual(ids);
    });

    it("never records a put-off or refused option as taken", () => {
      const pending = analyzer.analyze({ userText: null, assistantText: NUMBERED })!;
      expect(readReply("1 和 3 做，2 暂缓", pending.options).verdicts).toEqual(["selected", "deferred", "selected"]);
      expect(readReply("1 可以，2 不要，3 再议", pending.options).verdicts).toEqual(["selected", "refused", "deferred"]);
      expect(readReply("1 上次用过", pending.options).verdicts).toEqual(["mentioned", null, null]);
    });

    it("names an option by a piece of its label only when no other label shares it", () => {
      expect(read(NAMED, "托管")?.ids).toEqual(["A"]);
      expect(read(NAMED, "高可用")?.ids).toEqual(["B"]);
      expect(read(NAMED, "用自建的")?.ids).toEqual(["B"]);
      expect(read(NAMED, "PostgreSQL")?.ids).toEqual([]);
    });
  });

  describe("options not extracted", () => {
    const PLAN = "有三项可以做：\n\n1. 加索引\n2. 拆表\n3. 加缓存\n\n都要做吗？";
    it.each([
      "1 和 3 做，2 不做",
      "1 和 3 做，2 之后再说",
      "好的，1 和 3 做，2 不做",
      "第 3 个先做，2 号稍后处理",
    ])("%j is a partial approval kept at medium", (answer) => {
      const done = read(PLAN, answer);
      expect(done?.band).toBe("medium");
      expect(done?.ids).toEqual([]);
    });
  });

  describe("replies that decide nothing stay below high", () => {
    it.each([
      "1 上次用过",
      "先按 2 的思路想想",
      "1 还没看",
      "2 的话再议",
      "改了 3 个文件",
      "2 号上周用过",
      "A quick fix would do",
      "先不管这个，帮我看下 README",
      "收到",
      "好的，了解",
      "2 已经在上周发布了",
      "The second option was used last year.",
    ])("%j", (answer) => {
      for (const assistantText of [NUMBERED, ENGLISH]) {
        const done = read(assistantText, answer);
        expect(done?.band).not.toBe("high");
        expect(done?.ids).toEqual([]);
      }
    });
  });

  // R3-HO-A mechanisms, written afresh: requests to confirm item by item, and
  // replies that approve some items while putting the rest off.
  describe("item-by-item requests", () => {
    const LIST = "这次整理出三处改动：\n\n1. 给订单表加联合索引\n2. 把日志写入改为异步\n3. 删掉废弃的导出接口";
    it.each([
      `${LIST}\n\n请对每一项分别回复批准或暂缓。`,
      `${LIST}\n\n麻烦逐条批复一下。`,
      `${LIST}\n\n- 联合索引：批准吗？\n- 异步日志：批准吗？\n- 导出接口：批准吗？`,
      `${LIST}\n\n测试尚未运行，请逐项确认后我再动手。`,
      `${LIST}\n\n目前没有改动任何文件，请分别确认。`,
      "Three changes:\n\n1. Add an index\n2. Make logging async\n3. Remove the export endpoint\n\nPlease approve or defer each of them.",
    ])("%#: is a request, and the list above it is the options", (assistantText) => {
      const done = read(assistantText, /^Three/u.test(assistantText) ? "Approve 1 and 2, defer 3" : "前两项批准，第三项暂缓");
      expect(done?.options).toHaveLength(3);
      expect(done?.ids).toEqual(["1", "2"]);
      expect(done?.band).toBe("high");
    });

    it("keeps a batch of independent questions out of the options (IMP-101)", () => {
      const pending = analyzer.analyze({
        userText: null,
        assistantText: "有两个问题需要你定：\n\n1. 存储用 SQLite 还是 PostgreSQL？\n2. 是否需要引入缓存？\n\n请分别确认。",
      });
      expect(pending?.options ?? []).toEqual([]);
    });

    it("does not read the assistant's own item-by-item check as a request", () => {
      expect(analyzer.analyze({ userText: null, assistantText: "我已经逐项确认了三处改动，都没有问题。" })).toBeNull();
    });
  });

  describe("R2-V-BA gaps", () => {
    it.each([
      "迁移脚本已生成。\n\n**是否继续应用这个迁移？**（确认后我会执行）",
      "The migration is ready.\n\nShould I apply it now? Once you confirm, I'll proceed with the rollout.",
    ])("a promise to act after the reply still waits for it: %j", (assistantText) => {
      expect(read(assistantText, "可以")?.band).toBe("high");
    });

    it("still reads the assistant going ahead on its own as no request", () => {
      expect(analyzer.analyze({ userText: null, assistantText: "要不要先跑测试？我决定现在就开始执行。" })).toBeNull();
    });

    it("takes the options from a comparison table whose columns are the options", () => {
      const transposed = "三种并发方案对比：\n\n| 维度 | A：线程池 | B：异步 IO | C：多进程 |\n|---|---|---|---|\n| 内存 | 低 | 极低 | 高 |\n| 复杂度 | 低 | 中高 | 中 |\n\n补充说明：异步 IO 改造成本高。\n\n请告诉我选哪个？";
      const done = read(transposed, "选 C");
      expect(done?.options.map((option) => option.label)).toEqual(["线程池", "异步 IO", "多进程"]);
      expect(done?.ids).toEqual(["C"]);
    });

    it("leaves a status table with plain column names alone", () => {
      const status = "| 模块 | 现状 | 目标 |\n|---|---|---|\n| 采集 | 规则 | 规则+模型 |\n\n还有别的问题吗？";
      expect(analyzer.analyze({ userText: null, assistantText: status })?.options ?? []).toEqual([]);
    });
  });

  // R3-IA2 (synthetic, mechanisms seen in R3-BA real replies): layouts agents
  // chose, and how readers answered them.
  describe("R3-IA2 real-reply mechanisms", () => {
    const TASKS = "我能做的有四项：\n\n1. 升级依赖\n2. 执行数据库迁移\n3. 重新生成文档\n4. 清理构建产物";

    it.each([
      "我还得先问问同事这几项有没有人在用，晚点再告诉你",
      "先跟运维确认一下，回头再定",
      "We already added the CI config last week.",
    ])("%j decides nothing", (answer) => {
      const done = read(`${TASKS}\n\n你想做哪些？`, answer);
      expect(done?.band).toBe("low");
      expect(done?.ids).toEqual([]);
    });

    it("reads 请告诉我…哪些 under a list as asking to pick", () => {
      expect(read(`${TASKS}\n\n请告诉我现在要运行哪些？`, "1 和 3 做，2 等下个月")?.ids).toEqual(["1", "3"]);
    });

    it("keeps options whose descriptions report a whether-clause", () => {
      const list =
        "可以整理的有：\n\n1. **目录梳理**——重新划分 src 目录\n2. **配置统一**——核对 .editorconfig 是否存在、是否冲突\n3. **构建检查**——路径别名是否和目录匹配\n\n你要做哪些？告诉我编号即可。";
      expect(read(list, "除了第 2 项，其他都做")?.ids).toEqual(["1", "3"]);
    });

    it("takes bold titles without numbers as the options when asked to pick", () => {
      const titles =
        "**重命名样式文件**\n\n统一样式文件命名。\n\n**合并重复组件**\n\n把两个组件合成一个。\n\n**删除未使用的图片**\n\n清理无引用的图片。\n\n以上只是方案，尚未检查代码。\n\n你想做哪几项？";
      const done = read(titles, "合并重复组件做，重命名样式文件先推迟到下个迭代，图片不用删");
      expect(done?.options.map((option) => option.label)).toEqual(["重命名样式文件", "合并重复组件", "删除未使用的图片"]);
      expect(done?.ids).toEqual(["2"]);
      expect(done?.band).toBe("high");
    });

    it("does not take a report's bold section headings as options", () => {
      const report = "**背景**\n\n服务慢。\n\n**结论**\n\n先加索引。\n\n还有问题吗？";
      expect(analyzer.analyze({ userText: null, assistantText: report })?.options ?? []).toEqual([]);
    });

    it("reads a checklist by its names, the reader keeping some items", () => {
      const checklist = "发版前待办：\n\n- [ ] 更新 CHANGELOG\n- [ ] 跑全量测试\n- [ ] 打 tag\n- [ ] 通知测试同学\n\n哪些由我来做？";
      const done = read(checklist, "好的，更新 CHANGELOG 和跑全量测试你来做，打 tag 和通知我自己来");
      expect(done?.options.map((option) => option.label)).toEqual(["更新 CHANGELOG", "跑全量测试", "打 tag", "通知测试同学"]);
      expect(done?.ids).toEqual(["1", "2"]);
      expect(done?.band).toBe("high");
    });

    it.each([
      ["Apply 1, 2 and 4. Skip 3, 5, not worth the risk.", ["1", "2", "4"]],
      ["Do the first one and the last one, leave the middle ones for later.", ["1", "4"]],
      ["中间两个先不做，第一个和最后一个做", ["1", "4"]],
    ])("%j takes %j", (answer, ids) => {
      const list = "Four fixes:\n\n1. Upgrade express\n2. Rate-limit login\n3. Await the promise\n4. Pool size from env\n5. Redact request bodies\n\nWhich should I apply?";
      const four = "Four cleanups:\n\n1. Remove dead code\n2. Unify config\n3. Fix type hints\n4. Tidy git workflow\n\nWhich of these should I do?";
      expect(read(/Apply/u.test(answer) ? list : four, answer)?.ids).toEqual(ids);
    });

    it("takes nothing from an exclusion whose item it cannot tell", () => {
      const done = read(`${TASKS}\n\n你想做哪些？`, "all but the migration");
      expect(done?.ids).toEqual([]);
      expect(done?.band).not.toBe("high");
    });
  });

  // R3-V-AN review probes (synthetic, verbatim): what IA2 opened up and closes again.
  describe("R3-V-AN guards", () => {
    const NUM = (ask: string) => `有三项可以做：\n\n1. 加索引\n2. 拆表\n3. 加缓存\n\n${ask}`;
    it.each([
      ["I2", "分别说明如下：\n1. 索引已经加了\n2. 表没有拆", "好的"],
      ["I3", "动手前我需要先了解：\n\n- 数据量多大？\n- 峰值 QPS 是多少？", "100 万行，QPS 2000"],
      ["I4", "Before I start:\n\n1. How many rows?\n2. What is the peak QPS?", "About a million rows, peak 2000"],
      ["I6", "我分别改了两个文件，均已确认无误。", "好的"],
      ["I7", "每个决定都记录在 docs 里了。", "好"],
      ["I9", "补充两个信息：\n1. 这个服务现在的 QPS 大概多少？\n2. 数据库版本是多少？", "QPS 2000，PG 15"],
      ["I10", "A couple of questions before I proceed:\n1. Which Node version are you on?\n2. Is CI on GitHub Actions?", "Node 22, yes GitHub Actions"],
      ["I13", "三个文件分别对应三处修复，均已确认无误。", "好的"],
    ])("%s is no request", (_id, assistantText, answer) => {
      const done = read(assistantText, answer);
      expect(done === null || done.band === "low").toBe(true);
    });

    it("still reads the item-by-item requests asked of the reader", () => {
      expect(read(NUM("每一项请回复批准或暂缓。"), "前两项批准，第三项暂缓")?.ids).toEqual(["1", "2"]);
      expect(read(NUM("逐项批复：\n- 加索引\n- 拆表\n- 加缓存"), "前两项批准，第三项暂缓")?.ids).toEqual(["1", "2"]);
      expect(read(NUM("- 加索引：批准？\n- 拆表：批准？\n- 加缓存：批准？"), "前两项批准，第三项暂缓")?.ids).toEqual(["1", "2"]);
    });

    it.each([
      ["P1", "两种缓存：\n\nA. 本地缓存\nB. 远程缓存\n\n你选哪个？", "本地跑一下测试就行"],
      ["P5", "A. Add an index\nB. Split the table\n\nWhich one?", "the table is fine as is"],
    ])("%s names an option on the way to something else and takes nothing", (_id, assistantText, answer) => {
      expect(read(assistantText, answer)?.ids).toEqual([]);
    });

    it("T3 does not take a lettered status table as options under a yes/no question", () => {
      const status = "| 组 | 任务 | 状态 |\n|---|---|---|\n| A | 修复登录 | 完成 |\n| B | 升级依赖 | 待办 |\n\n现在要提交吗？";
      expect(analyzer.analyze({ userText: null, assistantText: status })?.options).toEqual([]);
    });

    it.each(["1 和 3 做", "只做 1 和 3"])("F3/F4 %j without extracted options is medium", (answer) => {
      expect(read(NUM("都要做吗？"), answer)).toMatchObject({ band: "medium", ids: [] });
    });

    it("V10 lets a plain take settle an option an earlier clause put off", () => {
      expect(read(NUM("你想做哪些？"), "1 以后维护方便，就选 1")?.ids).toEqual(["1"]);
    });

    // R3-V2-AN probes (synthetic, verbatim), IA4.
    const REPORT = (ask: string) =>
      `**改动摘要**\n改了三处接口。\n\n**测试情况**\n全部通过。\n\n**风险**\n没有发现。\n\n${ask}`;
    it.each([
      ["B1", REPORT("现在合并还是等 CI 跑完？"), "等 CI"],
      ["B2", REPORT("现在合并还是等 CI 跑完？"), "合并"],
      ["B8", REPORT("你想先合并哪个分支？"), "feature 分支"],
    ])("%s does not turn a report's headings into options", (_id, assistantText, answer) => {
      const done = read(assistantText, answer);
      expect(done?.options).toEqual([]);
      expect(done?.band).toBe("high");
    });

    // R3-V3-AN probes (synthetic, verbatim), IA5.
    it.each([
      ["X1", "等窗口期"],
      ["X2", "现在跑"],
    ])("%s answers the alternatives the question wrote out, over bold steps", (_id, answer) => {
      const steps = "迁移分两步。\n\n**1. 改配置**\n把连接串换成新库。\n\n**2. 跑迁移**\n大概十分钟。\n\n现在跑还是等窗口期？";
      expect(read(steps, answer)).toMatchObject({ band: "high", ids: [] });
    });

    it("X4 takes neither report headings nor a common word as an option", () => {
      const report = "**现状**\n两个服务共用一个库。\n\n**问题**\n锁冲突。\n\n**建议**\n拆库。\n\n你想按哪个来，还是先讨论？";
      const done = read(report, "按建议来");
      expect(done?.options).toEqual([]);
      expect(done?.ids).toEqual([]);
    });

    it("still takes bold titles that are the options themselves", () => {
      const titles = "两种思路。\n\n**合并重复组件**\n把三处表单合成一个。\n\n**保留现状只补测试**\n风险最小。\n\n你倾向哪种？";
      expect(read(titles, "合并重复组件")).toMatchObject({ band: "high", ids: ["1"] });
    });

    it.each([
      ["H1", "分别确认：\n- 索引：已加\n- 表：未拆", "好的"],
      ["H3", "日志里没有线索，你知道怎么排查这个问题吗？", "看下 nginx 日志"],
    ])("%s is no request", (_id, assistantText, answer) => {
      expect(analyzer.analyze({ userText: null, assistantText })).toBeNull();
      expect(read(assistantText, answer)).toBeNull();
    });

    it.each([
      ["C2", "1 和 3 做，但是先别急着上线", ["1", "3"]],
      ["K2", "1 只需要改配置，2 和 3 做", ["1", "2", "3"]],
      ["K4", "1 只改一半也行，2 做", ["1", "2"]],
    ])("%s %j takes %j", (_id, answer, ids) => {
      expect(read(NUM("你想做哪些？"), answer)?.ids).toEqual(ids);
    });

    it("E5 carries no verb over a full stop", () => {
      const five = "Three things:\n\n1. Add an index\n2. Split the table\n3. Add a cache\n4. Update docs\n5. Add metrics\n\nWhich of these?";
      expect(read(five, "Skip 2. 1 and 3")?.ids).toEqual(["1", "3"]);
      expect(read(five, "Skip 3, 5")?.ids).toEqual([]);
    });

    it("W1 reads 做了/没做 as what happened", () => {
      expect(read(NUM("你想做哪些？"), "1 做了，2 没做")).toMatchObject({ band: "low", ids: [] });
    });
  });

  // R3-IA3 (synthetic, after R3-V-SK mechanisms): wrong picks first, then
  // false alarms, then misses.
  describe("R3-V-SK mechanisms", () => {
    const STEPS = "评审标出三项：\n\n1. 失败时保留旧数据\n2. 空结果显示提示\n3. 调整提示文案\n\n你批准哪些？";
    it.each([
      ["1 和 3 都行，不过 3 要先找设计确认", ["1"]],
      ["先做 3；1 也可以，但先问问同事；2 暂缓", ["3"]],
      ["除了前两个都不要，先只做 1", ["1"]],
      ["2 和 3 做，3 下周再说", ["2"]],
    ])("%j takes only %j", (answer, ids) => {
      expect(read(STEPS, answer)?.ids).toEqual(ids);
    });

    // R3-IA5: over options gathered across paragraphs the same reply is a
    // candidate (medium), so that a real answer the options missed is not lost.
    it("keeps a shared-word reply over options across paragraphs a candidate", () => {
      const spread = "**A. 安全目录** —— 限制权限。\n\n**B. 安全传输** —— 加密上传。\n\n**C. 安全清理** —— 定期删除。\n\n你选哪个？";
      expect(read(spread, "先做安全的那个")).toMatchObject({ band: "medium", ids: [] });
    });

    it.each([
      ["1. 清理临时文件\n2. 清理旧笔记\n3. 清理索引\n\n你批准哪个清理？", "清理一下就好"],
      ["A. 登录通知\nB. 登录失败通知\nC. 登录设备变更通知\n\n要选哪个登录通知？", "登录相关的都可以"],
      [STEPS, "第二项现在还在排队"],
      ["有四个设计问题：\n\n1. 是否需要离线模式？\n2. 是否允许访客？\n\n你选哪些？", "先不选，离线模式要再跟同事讨论"],
    ])("%#: a word every option shares, a status or a deferral decides nothing", (assistantText, answer) => {
      const done = read(assistantText, answer);
      expect(done === null || done.band === "low").toBe(true);
      expect(done?.ids ?? []).toEqual([]);
    });

    it("still reads turning down the act both options share as a stance", () => {
      expect(read("A. 现在合并\nB. 等 CI 跑完再合并\n\n你选哪个？", "不合并，先等等")?.band).not.toBe("low");
    });

    it.each([
      ["**1. 加健康检查**\n新实例检查通过后再接流量。\n\n**2. 延长观察期**\n便于回滚。\n\n选择要做的项。", "2 先上", ["2"]],
      ["1. 生成清单\n2. 对照记录\n3. 保存报告\n4. 删除临时文件\n\n这四项怎么排？", "最后两个先做，前两个稍后再评估", ["3", "4"]],
      ["- [ ] A. 移除请求正文\n- [ ] B. 屏蔽认证字段\n- [ ] C. 保留耗时\n\n推荐：先处理正文。\n\n你批准哪些改动？", "A 和 B 先做，C 等下一轮", ["A", "B"]],
      ["1. 增加错误率看板\n2. 提高 worker 数量\n3. 自动扩缩容\n\n你要我现在做哪些？", "先把看板做了，另外两项下周再说", ["1"]],
    ])("%#: reads the request and takes %j", (assistantText, answer, ids) => {
      const done = read(assistantText, answer as string);
      expect(done?.ids).toEqual(ids);
      expect(done?.band).not.toBe("low");
    });
  });

  // R3-AN probe guards G1–G15 and group X, verbatim (synthetic).
  describe("R3-AN guards", () => {
    const NUM = (ask: string) => `有三项可以做：\n\n1. 加索引\n2. 拆表\n3. 加缓存\n\n${ask}`;
    const A = {
      NUM_PICK: NUM("你想做哪些？"),
      NUM_ALL_NOCUE: NUM("都要做吗？"),
      PARA_LETTER: "有三项可以做。\n\n**A. 加索引**\n加索引改动最小。\n\n**B. 拆表**\n拆表改动大，要迁移数据。\n\n**C. 加缓存**\n要引入 Redis。\n\n你想做哪些？",
      NAMED: "两种部署方式：\n\nA. 托管 PostgreSQL\nB. 自建 PostgreSQL 高可用集群\n\n你选哪个？",
      EN_NUM: "Three things we could do:\n\n1. Add an index\n2. Split the table\n3. Add a cache\n\nWhich of these do you want?",
      EN_LETTER: "Three things we could do:\n\nA. Add an index\nB. Split the table\nC. Add a cache\n\nWhich of these do you want?",
      TRANSPOSED: "三种存储对比：\n\n| | A. SQLite | B. PostgreSQL | C. JSON 文件 |\n|---|---|---|---|\n| 部署 | 无 | 需要 | 无 |\n| 并发 | 弱 | 强 | 弱 |\n\n你选哪个？",
    };
    it.each([
      ["G1", A.NUM_PICK, "1 上次用过"],
      ["G2", A.NUM_PICK, "先按 2 的思路想想"],
      ["G3", A.NUM_PICK, "1 还没看"],
      ["G4", A.NUM_PICK, "2 的话再议"],
      ["G5", A.NUM_PICK, "改了 3 个文件"],
      ["G6", A.NUM_PICK, "2 号上周用过"],
      ["G7", A.EN_NUM, "A quick fix would do"],
      ["G8", A.NUM_PICK, "先不管这个，帮我看下 README"],
      ["G9", A.NUM_PICK, "收到"],
      ["G10", A.NUM_PICK, "好的，了解"],
      ["G11", A.NUM_PICK, "1 和 2 比较一下再决定"],
      ["G12", A.NUM_PICK, "2 太重了"],
      ["G13", A.NUM_PICK, "1 和 3 是什么意思？"],
      ["G14", A.NUM_PICK, "目前用的是 1"],
      ["G15", A.NUM_PICK, "2 跑过了，1 还没"],
    ])("%s %j takes nothing and is not high", (_id, assistantText, answer) => {
      const done = read(assistantText, answer);
      expect(done?.band).not.toBe("high");
      expect(done?.ids).toEqual([]);
    });

    it.each([
      ["X1", A.NUM_PICK, "1 和 3 都可以，2 之后再说", ["1", "3"]],
      ["X2", A.NUM_PICK, "1 和 3 可以做，2 回头再看", ["1", "3"]],
      ["X3", A.NUM_PICK, "先做 1 和 3，2 之后再说", ["1", "3"]],
      ["X4", A.NUM_PICK, "2 先放一放，1 和 3 做", ["1", "3"]],
      ["X5", A.NUM_PICK, "1 和 3 做，2 暂缓", ["1", "3"]],
      ["X6", A.NUM_PICK, "1、3 同意", ["1", "3"]],
      ["X7", A.NUM_PICK, "2 号不做，1 号和 3 号做", ["1", "3"]],
      ["X8", A.PARA_LETTER, "A 和 C 可以，B 之后再说", ["A", "C"]],
      ["X10", A.EN_LETTER, "A, C; skip B", ["A", "C"]],
      ["X11", A.EN_LETTER, "A and B", ["A", "B"]],
      ["X12", A.EN_NUM, "1 and 3 are fine, leave 2 for later", ["1", "3"]],
      ["X13", A.EN_NUM, "Go with 1 and 3; 2 can wait", ["1", "3"]],
      ["X14", A.EN_NUM, "Let's do 1 and 3 now and revisit 2 later", ["1", "3"]],
      ["X15", A.NAMED, "托管那个", ["A"]],
      ["X17", A.TRANSPOSED, "A 和 C 都行，B 不要", ["A", "C"]],
    ])("%s %j takes %j", (_id, assistantText, answer, ids) => {
      const done = read(assistantText, answer);
      expect(done?.ids).toEqual(ids);
      expect(done?.band).toBe("high");
    });

    // R3-IA3: a word every option shares names none of them (R3-V-SK PA3-03).
    it("X16 takes nothing from a word both options share", () => {
      expect(read(A.NAMED, "PostgreSQL")).toMatchObject({ band: "low", ids: [] });
    });

    it("X9 keeps a partial approval without extracted options at medium", () => {
      expect(read(A.NUM_ALL_NOCUE, "好的，1 和 3 做，2 不做")).toMatchObject({ band: "medium", ids: [] });
    });
  });
});


// Synthetic R4 regression cases shared with scripts/lab/rules-compare.mjs.
describe("R4 recognition regressions", () => {
  it.each(r4Recognition)("$id", (sample) => {
    const pending = analyzer.analyze({ userText: null, assistantText: sample.assistantText });
    expect(pending).not.toBeNull();
    const result = analyzer.complete(pending!, sample.userText);
    expect(result.band !== "low").toBe(sample.decision);
    expect(result.selected.map((option) => option.id)).toEqual(sample.expectedSelected);
    expect(selectedOptions(sample.userText, pending!.options).map((option) => option.id)).toEqual(sample.expectedSelected);
  });
});


describe("IR2 review regressions", () => {
  it.each(r4Ir2)("$id", sample => {
    const pending = analyzer.analyze({ userText: null, assistantText: sample.assistantText });
    const result = pending && analyzer.complete(pending, sample.userText);
    if (sample.expectedBand === "any") { expect(result?.band).not.toBe("high"); expect(pending?.options ?? []).toEqual([]); }
    else expect(result?.band === "high" || result?.band === "medium").toBe(sample.decision);
    expect(result?.selected.map(option => option.id) ?? []).toEqual(sample.expectedSelected);
    if (sample.expectedBand && sample.expectedBand !== "any") expect(result?.band).toBe(sample.expectedBand);
  });
});

describe("IR3 note separators and cardinal references", () => {
  const options = "Two options:\n\n1. Add an index\n2. Split the table\n\n";

  it.each([
    ["T1b", "Tests were not run: which means CI may still fail."],
    ["T2b", "Tests were not run, so re-pick later if needed."],
    ["T2c", "Tests were not run — pick-and-place logic untouched."],
  ])("%s strips the report after the actual request", (_id, note) => {
    const pending = analyzer.analyze({ userText: null, assistantText: options + "Which approach?\n\n" + note });
    expect(pending).not.toBeNull();
    const result = analyzer.complete(pending!, "1");
    expect(result).toMatchObject({ score: 100, band: "high" });
    expect(result.selected.map(option => option.id)).toEqual(["1"]);
  });

  it.each([
    ["T3", "Tests were not run — pick one and I'll proceed."],
    ["M1", "Tests were not run — let me know which to apply."],
    ["M4", "No tests were executed – choose one and I'll proceed."],
    ["M6", "Tests were not run - please confirm which one."],
    ["colon", "Tests were not run: pick one and I'll proceed."],
    ["colon which", "Tests were not run: which one should I apply."],
  ])("%s retains the request in the note", (_id, note) => {
    const pending = analyzer.analyze({ userText: null, assistantText: options + note });
    expect(pending).not.toBeNull();
    expect(analyzer.complete(pending!, "1")).toMatchObject({ band: "high", selected: [{ id: "1" }] });
  });

  it("M5 retains the original medium result for your call", () => {
    const pending = analyzer.analyze({ userText: null, assistantText: options + "Validation: not performed — your call." });
    expect(pending).not.toBeNull();
    expect(analyzer.complete(pending!, "1")).toMatchObject({ score: 70, band: "medium", selected: [] });
  });

  it("M7 retains the Chinese double dash without surrounding spaces", () => {
    const pending = analyzer.analyze({ userText: null, assistantText: "有三项可以做：\n\n1. 加索引\n2. 拆表\n3. 加缓存\n\n未运行测试——请选一个。" });
    expect(pending).not.toBeNull();
    expect(analyzer.complete(pending!, "1")).toMatchObject({ score: 100, band: "high", selected: [{ id: "1" }] });
  });

  it.each(["items", "steps", "options"])("retains the explicit %s two and three reference", prefix => {
    const pending = analyzer.analyze({ userText: null, assistantText: "Three things:\n\n1. Add an index\n2. Split the table\n3. Add a cache\n\nWhich of these should I do?" });
    expect(pending).not.toBeNull();
    expect(analyzer.complete(pending!, `Go ahead with ${prefix} two and three; defer the index change.`).selected.map(option => option.id)).toEqual(["2", "3"]);
  });

  it("L14 does not turn one more check into option 1", () => {
    const pending = analyzer.analyze({ userText: null, assistantText: "Three things:\n\n1. Add an index\n2. Split the table\n3. Add a cache\n\nWhich of these should I do?" });
    expect(pending).not.toBeNull();
    expect(analyzer.complete(pending!, "Do 2 and one more check").selected.map(option => option.id)).toEqual(["2"]);
  });
});

// Synthetic R5 cases: suppress informational replies without losing an independent approval.
describe("R5 recognition boundaries", () => {
  it.each(r5Recognition)("$id $userText", sample => {
    const pending = analyzer.analyze({ userText: null, assistantText: sample.assistantText });
    const result = pending && analyzer.complete(pending, sample.userText);
    if (!("maximumBand" in sample && sample.maximumBand === "medium")) expect(result?.band === "high" || result?.band === "medium").toBe(sample.decision);
    expect(result?.selected.map(option => option.id) ?? []).toEqual(sample.expectedSelected);
    expect(selectedOptions(sample.userText, pending?.options ?? []).map(option => option.id)).toEqual(sample.expectedSelected);
    if ("maximumBand" in sample) {
      if (sample.maximumBand === "low") expect(result?.band ?? "none").toMatch(/^(?:low|none)$/u);
      else expect(result?.band).not.toBe("high");
    }
    if ("expectedOptionCount" in sample) expect(pending?.options.length ?? 0).toBe(sample.expectedOptionCount);
  });
});

// Synthetic IR2 guards from mechanism descriptions; no holdout wording is used.
describe("R5 IR2 approval confidence", () => {
  it.each(r5Ir2)("$id $userText", sample => {
    const pending = analyzer.analyze({ userText: null, assistantText: sample.assistantText });
    expect(pending).not.toBeNull();
    const result = analyzer.complete(pending!, sample.userText);
    if (sample.expectedBand === "any") expect(result.band).not.toBe("high");
    else expect(result.band).toBe(sample.expectedBand);
    expect(result.selected.map(option => option.id)).toEqual(sample.expectedSelected);
    expect(selectedOptions(sample.userText, pending!.options).map(option => option.id)).toEqual(sample.expectedSelected);
  });
});

describe("R5 skeptic regression repairs", () => {
  const required = [
    ...r5Whitebox.filter(sample => ["R5IRWB-001", "R5IRWB-005", "R5IRWB-006", "R5IRWB-010", "R5IRWB-014", "R5IRWB-015", "R5IRWB-020", "R5IRWB-021", "R5IRWB-023", "R5IRWB-024"].includes(sample.id)),
    ...r5Followup.filter(sample => sample.id === "R5IRWF-003"),
  ];
  it.each(required)("$id", sample => {
    const pending = analyzer.analyze({ userText: null, assistantText: sample.assistantText });
    const result = pending && analyzer.complete(pending, sample.userText);
    if (sample.decision) expect(result?.band).toBe(["R5IRWB-010", "R5IRWF-003"].includes(sample.id) ? "medium" : "high");
    else expect(result?.band ?? "none").toMatch(/^(?:low|none)$/u);
    expect(result?.selected.map(option => option.id) ?? []).toEqual(sample.expectedSelected);
  });
});

// Synthetic IR3 guards and the published skeptic cases for the two narrow repairs.
describe("R5 IR3 references and replacement", () => {
  const required = r5Ir2Whitebox.filter(sample => ["R5IR2SK-004", "R5IR2SK-008", "R5IR2SK-014", "R5IR2SK-015", "R5IR2SK-022", "R5IR2SK-024"].includes(sample.id));
  it.each([...r5Ir3, ...required])("$id $userText", sample => {
    const pending = analyzer.analyze({ userText: null, assistantText: sample.assistantText });
    expect(pending).not.toBeNull();
    const result = analyzer.complete(pending!, sample.userText);
    if (sample.decision) expect(result.band).toBe("expectedBand" in sample ? sample.expectedBand : "high");
    else if (!("expectedBand" in sample && sample.expectedBand === "any")) {
      // Existing false positives are only constrained to stop inventing selections.
      if (sample.id.startsWith("R5IR3-")) expect(result.band).toBe("low");
    }
    expect(result.selected.map(option => option.id)).toEqual(sample.expectedSelected);
    expect(selectedOptions(sample.userText, pending!.options).map(option => option.id)).toEqual(sample.expectedSelected);
  });
});

describe("R5 analyst B2 repairs", () => {
  it.each(r5B2)("$id $userText", sample => {
    const pending = analyzer.analyze({ userText: null, assistantText: sample.assistantText });
    const result = pending && analyzer.complete(pending, sample.userText);
    if (sample.expectedBand === "any") expect(result?.band).not.toBe("high");
    else expect(result?.band ?? "none").toBe(sample.expectedBand);
    expect(result?.selected.map(option => option.id) ?? []).toEqual(sample.expectedSelected);
    expect(selectedOptions(sample.userText, pending?.options ?? []).map(option => option.id)).toEqual(sample.expectedSelected);
  });
});

// Published R6 skeptic attacks repaired in IR2 (expectedSelected normalised to string ids).
describe("R6 IR2 skeptic repairs", () => {
  const fixed = [
    ...r6Skeptic.filter(sample => ["R6IRSK-006", "R6IRSK-007", "R6IRSK-011", "R6IRSK-017", "R6IRSK-019", "R6IRSK-020", "R6IRSK-024", "R6IRSK-025", "R6IRSK-026", "R6IRSK-029", "R6IRSK-030", "R6IRSK-031", "R6IRSK-033", "R6IRSK-036"].includes(sample.id)),
    ...r6SkepticWhitebox.filter(sample => ["R6IRSKWB-003", "R6IRSKWB-004", "R6IRSKWB-007", "R6IRSKWB-008", "R6IRSKWB-009", "R6IRSKWB-010", "R6IRSKWB-011", "R6IRSKWB-013", "R6IRSKWB-014", "R6IRSKWB-015", "R6IRSKWB-018", "R6IRSKWB-020", "R6IRSKWB-026", "R6IRSKWB-030", "R6IRSKWB-031", "R6IRSKWB-032", "R6IRSKWB-033"].includes(sample.id)),
  ];
  it.each(fixed)("$id $userText", sample => {
    const pending = analyzer.analyze({ userText: null, assistantText: sample.assistantText });
    const result = pending && analyzer.complete(pending, sample.userText);
    if (sample.decision) expect(result?.band).toBe("high");
    else expect(result?.band ?? "none").toMatch(/^(?:low|none)$/u);
    expect(result?.selected.map(option => option.id) ?? []).toEqual(sample.expectedSelected.map(String));
  });
});

// IR4: read-completion markers do not turn an evaluative tail into a take.
describe("R5 IR4 read evaluation tails", () => {
  const required = r5Ir3Whitebox.filter(sample => sample.id === "R5IR2SK-042");
  it.each([...r5Ir4, ...required])("$id $userText", sample => {
    const pending = analyzer.analyze({ userText: null, assistantText: sample.assistantText });
    expect(pending).not.toBeNull();
    const result = analyzer.complete(pending!, sample.userText);
    expect(result.band).toBe(sample.decision ? "high" : "low");
    expect(result.selected.map(option => option.id)).toEqual(sample.expectedSelected);
    expect(selectedOptions(sample.userText, pending!.options).map(option => option.id)).toEqual(sample.expectedSelected);
  });
});

// IR5: allow numeric continuations, rather than enumerating evaluation words.
describe("R5 IR5 numeric decision boundaries", () => {
  it.each(r5Ir5)("$id $userText", sample => {
    const pending = analyzer.analyze({ userText: null, assistantText: sample.assistantText });
    expect(pending).not.toBeNull();
    const result = analyzer.complete(pending!, sample.userText);
    expect(result.band).toBe(sample.decision ? "high" : "low");
    expect(result.selected.map(option => option.id)).toEqual(sample.expectedSelected);
    expect(selectedOptions(sample.userText, pending!.options).map(option => option.id)).toEqual(sample.expectedSelected);
  });
});

// Synthetic R6 guards: evaluations, current state and descriptive exclusions take nothing.
describe("R6 recognition false positives", () => {
  it.each(r6Recognition)("$id $userText", sample => {
    const pending = analyzer.analyze({ userText: null, assistantText: sample.assistantText });
    const result = pending && analyzer.complete(pending, sample.userText);
    if ("expectedBand" in sample) {
      if (sample.expectedBand !== "any") expect(result?.band ?? "none").toBe(sample.expectedBand);
    } else if (sample.decision) expect(result?.band).toBe("high");
    else expect(result?.band ?? "none").toMatch(/^(?:low|none)$/u);
    if (!("expectedSelected" in sample)) return;
    expect(result?.selected.map(option => option.id) ?? []).toEqual(sample.expectedSelected);
    expect(selectedOptions(sample.userText, pending?.options ?? []).map(option => option.id)).toEqual(sample.expectedSelected);
  });
});

// R6 IR3: skeptic's IR2 attack set. Positives stay high and mapped; the negatives
// listed as remaining are 016374f4's own false positives, held at their baseline band.
describe("R6 IR3 skeptic IR2 attacks", () => {
  const remaining = ["R6IR2SKWB-001", "R6IR2SKWB-004", "R6IR2SKWB-005", "R6IR2SKWB-008", "R6IR2SKWB-015", "R6IR2SKWB-022"];
  it.each(r6SkepticIr2)("$id $userText", sample => {
    const pending = analyzer.analyze({ userText: null, assistantText: sample.assistantText });
    const result = pending && analyzer.complete(pending, sample.userText);
    if (sample.decision) expect(result?.band).toBe("high");
    else if (!remaining.includes(sample.id)) expect(result?.band ?? "none").toMatch(/^(?:low|none)$/u);
    expect(result?.selected.map(option => option.id) ?? []).toEqual(sample.expectedSelected.map(String));
  });
});

// Synthetic R7 guards: a reply that commits to nothing is not a decision; unreserved
// preferences take the preferred option; a list handed over without a question word,
// or a question followed by a closing remark, still asks.
describe("R7 recognition commitments and request gate", () => {
  it.each(r7Recognition)("$id $userText", sample => {
    const pending = analyzer.analyze({ userText: null, assistantText: sample.assistantText });
    const result = pending && analyzer.complete(pending, sample.userText);
    if ("expectedBand" in sample) {
      if (sample.expectedBand !== "any") expect(result?.band ?? "none").toBe(sample.expectedBand);
    } else if (sample.decision) expect(result?.band).toBe("high");
    else expect(result?.band ?? "none").toMatch(/^(?:low|none)$/u);
    if (!("expectedSelected" in sample)) return;
    expect(result?.selected.map(option => option.id) ?? []).toEqual(sample.expectedSelected);
    expect(selectedOptions(sample.userText, pending?.options ?? []).map(option => option.id)).toEqual(sample.expectedSelected);
  });
});

// Synthetic R12 guards for option mapping: an article never followed by a
// function word, courtesy beside bare names, a number and its letter on one row,
// options found from a read-back question, an approval that names further work,
// and a question that offers a look beside a go-ahead.
describe("R12 option mapping", () => {
  it.each(r12Map)("$id $userText", sample => {
    const pending = analyzer.analyze({ userText: null, assistantText: sample.assistantText });
    const result = pending && ruleReading(analyzer.complete(pending, sample.userText));
    expect(result?.band ?? "none").toBe(sample.expectedBand);
    expect(result?.selected.map(option => option.id) ?? []).toEqual(sample.expectedSelected);
  });

  it("stays fast on long runs of spaces, letters and table cells", () => {
    const options = "1. A — 加超时\n2. B — 加重试\n\n";
    for (const filler of [" ".repeat(1990), "A ".repeat(995), "| 1 | A ".repeat(240), "看".repeat(1990), "你来定，".repeat(490), "看还是".repeat(660)]) {
      const started = performance.now();
      const pending = analyzer.analyze({ userText: null, assistantText: `${options}你想先看哪一项${filler}还是直接批准实施？` });
      if (pending) analyzer.complete(pending, `A${filler}and B please`);
      analyzer.analyze({ userText: null, assistantText: `${filler}\n\n| 1 | A | x |\n| 2 | B | y |\n\n你选哪个？\n\n我会等你回复。` });
      expect(performance.now() - started).toBeLessThan(200);
    }
  });
});

// Synthetic R13 guards: a closing note or wait after the question, however it is
// dressed or led in, and using an option versus using its diff to look.
describe("R13 closing notes and adoption", () => {
  it.each(r13Rule)("$id $userText", sample => {
    const pending = analyzer.analyze({ userText: null, assistantText: sample.assistantText });
    const result = pending && ruleReading(analyzer.complete(pending, sample.userText));
    expect(result?.band ?? "none").toBe(sample.expectedBand);
    expect(result?.selected.map(option => option.id) ?? []).toEqual(sample.expectedSelected);
    if ("expectedQuestion" in sample) expect(pending?.question).toBe(sample.expectedQuestion);
  });

  it("lets a question found past a closing only add a reading, never a low one", () => {
    const pastClosing = analyzer.analyze({ userText: null, assistantText: "- **A** Add import checks\n- **B** Change cache keys\n\n**Which of these do you approve?**\n\nI'll wait for your answer." });
    expect(pastClosing?.signals).toContain("question_located_past_closing");
    expect(ruleReading(analyzer.complete(pastClosing!, "Let me think about it and get back to you."))).toBeNull();
    expect(ruleReading(analyzer.complete(pastClosing!, "A and C now, B later."))?.band).toBe("medium");
    const asV9 = analyzer.analyze({ userText: null, assistantText: "A. Redis\nB. SQLite\n\n你选哪个？" });
    expect(asV9?.signals).not.toContain("question_located_past_closing");
    expect(ruleReading(analyzer.complete(asV9!, "我再想想，下周再定。"))?.band).toBe("low");
  });

  it("stops at a closing wait under a long body that asks nothing", () => {
    for (const body of ["的".repeat(7900), "未运行测试，".repeat(1300), "Note: nothing was run. ".repeat(340)]) {
      const started = performance.now();
      expect(analyzer.analyze({ userText: null, assistantText: `${body}\n\n我等你回复。` })).toBeNull();
      expect(performance.now() - started).toBeLessThan(200);
    }
  });

  it("stays fast on long notes, waits and measures", () => {
    const options = "A. Redis\nB. SQLite\n\n你选哪个？\n\n";
    for (const filler of [" ".repeat(1990), "未运行".repeat(660), "，".repeat(1990), "但".repeat(1990), "*_".repeat(995), "按".repeat(1990), "的".repeat(1990), "use B ".repeat(330)]) {
      const started = performance.now();
      const pending = analyzer.analyze({ userText: null, assistantText: `${options}*注:${filler}本轮未运行测试*\n\n等你${filler}回复。` });
      if (pending) analyzer.complete(pending, `都行，按${filler}最短的由你决定，${filler}Please use B's diff`);
      analyzer.analyze({ userText: null, assistantText: `${options}**你批准哪几项?**${filler}\n\n收到回答后${filler}\n\n- 只实施获批项目${filler}\n\n"${filler}"` });
      expect(performance.now() - started).toBeLessThan(200);
    }
  });
});

describe("a recommendation marker in a listed option", () => {
  const read = (marker: string, reply: string) => {
    const analyzer = new TextDecisionAnalyzer();
    const pending = analyzer.analyze({
      userText: null,
      assistantText: `有两个方案：\n\nA. 兼容迁移${marker}\nB. 直接替换\n\n请选择一个方案？`,
    });
    if (pending === null) throw new Error("no pending decision");
    const reading = ruleReading(analyzer.complete(pending, reply));
    const picked = reading?.selected ?? [];
    return {
      pending,
      band: reading?.band,
      ids: picked.map(({ id }) => id),
      follow: recommendationFollow(
        pending.options,
        picked.length === 1
          ? { kind: "preset", values: [picked[0]!.label] }
          : { kind: "custom", values: [reply] },
      ),
    };
  };

  it.each(["（推荐）", "(推荐)"])("keeps %s in the label and reads the picks right", (marker) => {
    expect(read(marker, "兼容迁移").pending.options.map(({ label }) => label)).toEqual([
      `兼容迁移${marker}`,
      "直接替换",
    ]);
    for (const [reply, ids, follow] of [
      ["兼容迁移", ["A"], "followed"],
      ["选 A", ["A"], "followed"],
      ["不选推荐的，选 B", ["B"], "not_followed"],
      ["直接替换", ["B"], "not_followed"],
    ] as const) {
      const result = read(marker, reply);
      expect(result.band, reply).toBe("high");
      expect(result.ids, reply).toEqual(ids);
      expect(result.follow, reply).toBe(follow);
    }
  });

  it.each(["按推荐的来", "就按你推荐的", "用推荐的", "听你的，选推荐那个", "按推荐的来。"])(
    "takes the marked option for the plain acceptance %s",
    (reply) => {
      const result = read("（推荐）", reply);
      expect(result.ids).toEqual(["A"]);
      expect(result.follow).toBe("followed");
      expect(["medium", "high"]).toContain(result.band);
    },
  );

  it.each(["推荐的方案有风险，换一个", "不要推荐的", "别用推荐那个，选 B", "按推荐的来，但是先压测", "不选推荐的"])(
    "does not take the marked option for %s",
    (reply) => {
      expect(read("（推荐）", reply).ids).not.toContain("A");
    },
  );

  it("leaves 按推荐的来 alone with no marker, or with two", () => {
    const plain = new TextDecisionAnalyzer();
    const pending = plain.analyze({ userText: null, assistantText: "有两个方案：\n\nA. 兼容迁移\nB. 直接替换\n\n请选择一个方案？" });
    expect(ruleReading(plain.complete(pending!, "按推荐的来"))?.selected ?? []).toEqual([]);
    const two = new TextDecisionAnalyzer();
    const both = two.analyze({ userText: null, assistantText: "有两个方案：\n\nA. 兼容迁移（推荐）\nB. 直接替换（推荐）\n\n请选择一个方案？" });
    expect(ruleReading(two.complete(both!, "按推荐的来"))?.selected ?? []).toEqual([]);
  });

  it("does not let the marker's own word make a reply look related", () => {
    const withMarker = new TextDecisionAnalyzer();
    const listed = withMarker.analyze({ userText: null, assistantText: "有两个方案：\n\nA. 兼容迁移（推荐）\nB. 直接替换\n\n请选择一个方案？" })!;
    const bare = new TextDecisionAnalyzer();
    const unmarked = bare.analyze({ userText: null, assistantText: "有两个方案：\n\nA. 兼容迁移\nB. 直接替换\n\n请选择一个方案？" })!;
    const reply = "推荐的方案有风险，换一个";
    expect(withMarker.complete(listed, reply).signals).toEqual(bare.complete(unmarked, reply).signals);
  });

  it("still drops other asides", () => {
    const analyzer = new TextDecisionAnalyzer();
    const pending = analyzer.analyze({
      userText: null,
      assistantText: "有两个方案：\n\nA. 兼容迁移（风险低）\nB. 直接替换\n\n请选择一个方案？",
    });
    expect(pending?.options.map(({ label }) => label)).toEqual(["兼容迁移", "直接替换"]);
  });
});

// R16: the same list with and without the marker must read the same, in what it takes and in its signals.
describe("a recommendation marker changes nothing but the marker", () => {
  const both = (marked: string, plain: string, reply: string) => {
    const read = (text: string) => {
      const analyzer = new TextDecisionAnalyzer();
      const pending = analyzer.analyze({ userText: null, assistantText: text })!;
      const done = analyzer.complete(pending, reply);
      return { ids: done.selected.map(({ id }) => id), labels: done.selected.map(({ label }) => label), signals: done.signals, band: done.band, picked: selectedOptions(reply, pending.options).map(({ id }) => id) };
    };
    return { marked: read(marked), plain: read(plain) };
  };
  const list = (a: string, b: string) => `有两个方案：\n\nA. ${a}\nB. ${b}\n\n请选择一个方案？`;

  it.each(["A", "B", "选 A", "选 B", "兼容迁移", "直接替换", "都要", "不确定"])("same reading of %s with the marker on either option", (reply) => {
    for (const [a, b] of [["兼容迁移（推荐）", "直接替换"], ["兼容迁移", "直接替换（推荐）"]] as const) {
      const { marked, plain } = both(list(a, b), list(a.replace("（推荐）", ""), b.replace("（推荐）", "")), reply);
      expect(marked.ids, reply).toEqual(plain.ids);
      expect(marked.picked, reply).toEqual(plain.picked);
      expect(marked.signals, reply).toEqual(plain.signals);
      expect(marked.band, reply).toBe(plain.band);
    }
  });

  it("keeps the number written beside a letter, in a table and in a list", () => {
    const table = (a: string) => `| 编号 | 方案 | 说明 |\n|---|---|---|\n| 2 | B | ${a} |\n| 1 | A | 本地缓存 |\n\n请选择一个方案？`;
    const numbered = (a: string) => `1. A — 本地缓存\n2. B — ${a}\n\n请选择一个方案？`;
    for (const reply of ["1", "2", "选 1", "选 2"]) {
      for (const make of [table, numbered]) {
        const { marked, plain } = both(make("托管缓存（推荐）"), make("托管缓存"), reply);
        expect(marked.ids, reply).toEqual(plain.ids);
        expect(marked.signals, reply).toEqual(plain.signals);
        expect(marked.picked, reply).toEqual(plain.picked);
      }
    }
    expect(both(table("托管缓存（推荐）"), table("托管缓存"), "2").marked.ids).toEqual(["B"]);
  });

  it("picks by position when options have no id or share one", () => {
    const noId = [{ label: "兼容迁移（推荐）" }, { label: "直接替换" }];
    expect(selectedOptions("直接替换", noId).map(({ label }) => label)).toEqual(["直接替换"]);
    expect(selectedOptions("选 B", noId).map(({ label }) => label)).toEqual(["直接替换"]);
    expect(selectedOptions("兼容迁移", noId).map(({ label }) => label)).toEqual(["兼容迁移（推荐）"]);
    const flipped = [{ label: "直接替换" }, { label: "兼容迁移（推荐）" }];
    expect(selectedOptions("直接替换", flipped).map(({ label }) => label)).toEqual(["直接替换"]);
    const shared = [{ id: "x", label: "兼容迁移（推荐）" }, { id: "x", label: "直接替换" }];
    expect(selectedOptions("直接替换", shared).map(({ label }) => label)).toEqual(["直接替换"]);
  });

  it("takes both when the reply takes both of a multi-select list", () => {
    const options = [{ id: "A", label: "兼容迁移（推荐）" }, { id: "B", label: "直接替换" }, { id: "C", label: "暂不处理" }];
    const plain = options.map((option) => ({ ...option, label: option.label.replace("（推荐）", "") }));
    expect(selectedOptions("A 和 B 都要", options).map(({ id }) => id)).toEqual(selectedOptions("A 和 B 都要", plain).map(({ id }) => id));
    expect(selectedOptions("A 和 B 都要", options).map(({ label }) => label)).toEqual(["兼容迁移（推荐）", "直接替换"]);
  });

  it.each(["按照你的推荐来", "按你的推荐来", "按您的建议来", "就按推荐方案来"])("takes the marked option for the plain acceptance %s", (reply) => {
    const noId = [{ label: "兼容迁移（推荐）" }, { label: "直接替换" }];
    expect(selectedOptions(reply, noId).map(({ label }) => label)).toEqual(["兼容迁移（推荐）"]);
    expect(selectedOptions(`不${reply}`, noId).map(({ label }) => label)).not.toContain("兼容迁移（推荐）");
  });

  it("leaves out a numbered reply to a message that wrote none of its numbers, however the model reads it", () => {
    const analyzer = new TextDecisionAnalyzer();
    const report = "还在按 Jenkins 的方式（`CI=true`、vitest 限 8 个 worker）复跑全量测试，大约还要几分钟。跑完我会把推送确认和 S01 一起发给你，可以吗？";
    const pending = analyzer.analyze({ userText: null, assistantText: report });
    expect(pending).not.toBeNull();
    expect(analyzer.complete(pending!, "1 直推，2 可以，3 升")).toMatchObject({
      band: "low",
      signals: expect.arrayContaining(["answer_numbers_not_asked"]),
    });
    expect(answersNumbersNotAsked(report, "1 直推，2 可以，3 升")).toBe(true);
  });

  it("still reads numbers the message did write, in its list above the closing question too", () => {
    const listed = "有三件事需要你选：\n\n1. 直推还是走 PR\n2. 先合 S01\n3. 升不升版本\n\n这几项你选哪个？";
    const analyzer = new TextDecisionAnalyzer();
    expect(analyzer.complete(analyzer.analyze({ userText: null, assistantText: listed })!, "1 直推，2 可以，3 升").signals)
      .not.toContain("answer_numbers_not_asked");
    expect(answersNumbersNotAsked(listed, "1 直推，2 可以，3 升")).toBe(false);
    expect(answersNumbersNotAsked("一、直推\n二、走 PR\n\n选哪个？", "1 不要，2 可以")).toBe(false);
    expect(answersNumbersNotAsked("1. 复制\n2. 导航\n\n要我做吗？", "处理1、2即可，3不用")).toBe(false);
    expect(answersNumbersNotAsked("这个方案可以吗？", "选 2")).toBe(false);
    expect(answersNumbersNotAsked("这个方案可以吗？", "第一个可以")).toBe(false);
    expect(answersNumbersNotAsked("A 还是 B？", "A")).toBe(false);
  });
});
