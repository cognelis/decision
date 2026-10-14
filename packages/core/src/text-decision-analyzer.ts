import type {
  CapturedDecisionContext,
  CapturedOption,
} from "@cognelis/decision-protocol";

export interface DecisionTurnExcerpt {
  userText: string | null;
  assistantText: string;
}

export type DecisionBand = "high" | "medium" | "low";

export interface PendingDecisionAnalysis {
  question: string;
  options: CapturedOption[];
  context?: CapturedDecisionContext;
  preScore: number;
  signals: string[];
  detectorVersion: "rules-v1";
}

export interface CompletedDecisionAnalysis
  extends PendingDecisionAnalysis {
  score: number;
  band: DecisionBand;
}

const MAXIMUM_VISIBLE_MESSAGE = 8_000;
const MAXIMUM_CONTEXT = 6_000;
const MAXIMUM_CONTEXT_FIELD = 4_000;

const WEIGHTS = {
  explicitChoicePrompt: 35,
  multipleOptions: 25,
  decisionVocabulary: 10,
  finalWaitingPosition: 10,
  finalQuestionMark: 30,
  implicitConfirmation: 30,
} as const;

const ANSWER_WEIGHTS = {
  optionIdOrLabel: 25,
  yesNoOrOrdinal: 15,
  explicitApproval: 35,
  directionalApproval: 25,
  lexicalRelation: 10,
} as const;

const EXPLICIT_CHOICE =
  /(?:你(?:希望|想|更倾向|选择)|请(?:选择|决定|确认)|要我.{0,12}[吗么]|是否|要不要|哪(?:个|种|项)|可以吗|继续吗|which\s+(?:approach|option|way)|choose|please (?:decide|confirm)|do you (?:prefer|want|approve)|would you|should we|shall we)/iu;
const INLINE_ALTERNATIVES = /.+还是.+/u;
const ENGLISH_INLINE_ALTERNATIVES = /\bor\b/iu;
const CONCESSIVE_ALTERNATIVES =
  /(?:(?:无论|不管)[^?？]{0,500}还是|还是[^?？]{0,500}(?:都|也|均|皆)(?:可以|能|会|是))/u;
const IMPLICIT_CONFIRMATION =
  /(?:等(?:你|您)(?:的)?确认|等待(?:你|您)(?:的)?确认|由你决定|交给你决定|确认后(?:我)?(?:再|会|就)|(?:请)?回复[「“"']?(?:确认|同意|执行)|await(?:ing)? your confirmation|(?:will )?wait for your confirmation|please confirm before I continue|final call is yours)/iu;
/**
 * A recommendation made over a list of options the assistant just wrote out.
 * On its own "我建议 C" is prose; sitting under two or more labelled options it
 * is the assistant saying the choice is laid out and the next move is the
 * reader's. Design question-and-answer ends this way far more often than it
 * ends on a question mark, and without this the whole exchange was invisible.
 */
const RECOMMENDS_AN_OPTION =
  /(?:我(?:的)?建议|我倾向|建议(?:选|采用|走)|推荐(?:选|采用)?|I(?:'d| would)? recommend|my recommendation|I lean toward)/iu;

const DECISION_VOCABULARY =
  /(?:方案|路线|建议|倾向|权衡|风险|取舍|优先|approach|option|trade-?off|risk|recommend)/iu;
const INFORMATION_REQUEST =
  /^(?:请(?:提供|输入|粘贴|上传|告诉我)|(?:这个|该)?仓库.{0,20}(?:放在)?哪(?:个路径|里|个位置)|please (?:provide|enter|paste|upload))/iu;
const STATUS_ANSWER =
  /^(?:测试|检查|构建|状态|test|check|build|status).*(?:是否|结果|result|passed).*[:：]\s*(?:是|否|通过|失败|yes|no|pass|fail)/iu;
const ASSISTANT_CONTINUES =
  /(?:我(?:已经)?决定|我(?:现在|接下来|将|会).{0,16}(?:开始|继续|执行|实现)|I (?:have )?decided|I(?:'ll| will| am going to| am).{0,24}(?:start|continue|implement|proceed)|(?:the )?(?:patch|implementation|change) is (?:complete|done))/iu;
const RHETORICAL_EXPLANATION =
  /[?？]\s*(?:因为|原因是|答案是|because|the reason is)/iu;
const SHORT_ANSWER =
  /^(?:\d+(?:\s*(?:、|,|和|与|后|then)\s*\d+)*|确认|批准|执行|可以|不要|同意|拒绝|继续|不继续|是|否|好|好的|按.{0,8}建议|yes|no|ok(?:ay)?|go ahead|do it)$/iu;
const EXPLICIT_APPROVAL_ANSWER =
  /^(?:(?:确认|批准|执行)(?:吧|即可|就行)?|可以|继续|不继续|同意|拒绝|是|否|好|好的|yes|no|ok(?:ay)?|go ahead|approved|do it|proceed)$/iu;

const COMPLETED_STATUS = /^(?:已(?:经)?(?:合并|提交|推送|发布|部署|重连|修复|构建|安装|关闭|删除)(?:了|完成|成功|完毕)?|(?:合并|提交|推送|发布|部署|重连|修复|构建|安装|关闭|删除)(?:了|完成|成功|完毕))$/u;
export const isCompletedDecisionStatus = (text: string): boolean => COMPLETED_STATUS.test(text.normalize("NFKC").trim().replace(/[。.!！]+$/u, "").trim());
const DIRECTIONAL_APPROVAL_ANSWER =
  /^(?:同意|不要|不批准|是[，,]|否[，,]|do not\b|don't\b|keep\b|remove\b|preserve\b|yes[\s,]|no[\s,])/iu;
const MIXED_ANSWER =
  /(?:另外|同时|顺便|并且|以及|also|and (?:also|then|please|explain|why))/iu;
const NEW_TASK =
  /(?:帮我|请|实现|开发|修复|新增|写一个|创建)\s*|\b(?:create|build|implement|fix|add)\b/iu;
const TOPIC_SHIFT =
  /^(?:换个(?:话题|问题)|聊(?:聊|一下)|不谈这个|先说别的)/u;
const SEQUENTIAL_ACTION_INTRO =
  /^(?:然后|接下来|随后|下一步|实施步骤|执行步骤|具体改动|具体执行|then|next)\s*[:：]$/iu;

const clamp = (value: number): number =>
  Math.max(0, Math.min(100, value));

const stripUnsafeContent = (value: string): string =>
  value
    .replace(/```[\s\S]*?```/gu, "")
    .split(/\r?\n/u)
    .filter((line) => {
      const trimmed = line.trim();
      return (
        !trimmed.startsWith(">") &&
        !/^(?:\[[A-Z]+\]|(?:error|warn|info|debug)\s*:|at\s+\S+)/iu.test(
          trimmed,
        )
      );
    })
    .join("\n")
    .trim();

const boundedVisibleText = (
  value: string,
): { text: string; truncated: boolean } => {
  const trimmed = value.trim();
  if (trimmed.length <= MAXIMUM_VISIBLE_MESSAGE) {
    return { text: trimmed, truncated: false };
  }
  return {
    text: trimmed.slice(-MAXIMUM_VISIBLE_MESSAGE),
    truncated: true,
  };
};

const paragraphs = (value: string): string[] =>
  value
    .split(/\n{2,}/u)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0);

interface ParsedOptionBlock {
  options: CapturedOption[];
  raw: string;
}

/**
 * A marker a bullet carries of its own: `- A: …`, `* 2) …`, `- A：…`. Chinese
 * writing puts no space after a full-width delimiter, so requiring one there
 * left the letter stranded in the label.
 */
const BULLETED_MARKER =
  /^([0-9]{1,2}|[A-Za-z])(?:[.):]\s+|[、：]\s*)(.+)$/u;

/** `**A**：…` is the same option as `A：…`; the asterisks are not its name. */
const withoutEmphasis = (value: string): string =>
  value.replace(/(\*\*|__)(?=\S)(.+?)\1/gu, "$2");

const optionFromLine = (
  line: string,
  index: number,
): CapturedOption | null => {
  const match = line.match(
    /^\s*(?:(\d+|[A-Za-z])[.)、]|[-*])\s+(.+?)\s*$/u,
  );
  if (match === null) {
    return null;
  }
  let identifier = match[1];
  let value = withoutEmphasis(match[2]?.trim() ?? "");
  if (identifier === undefined) {
    // A bullet whose text starts with its own marker: the letter is what the
    // reader will type back, so it has to be the id and not the label.
    const marked = value.match(BULLETED_MARKER);
    if (marked !== null) {
      identifier = marked[1];
      value = marked[2]?.trim() ?? "";
    }
  }
  if (value.length === 0 || value.length > 2_000) {
    return null;
  }
  const separator = value.match(/^(.{1,500}?)[：:]\s*(.+)$/u);
  const label = separator?.[1]?.trim() ?? value;
  const description = separator?.[2]?.trim();
  return {
    id: identifier ?? String(index + 1),
    label: label.slice(0, 500),
    ...(description === undefined
      ? {}
      : { description: description.slice(0, 2_000) }),
  };
};

/** Advice an item gives about itself: `…本地类型。 建议进 tenant。` */
const ADVISES_ITSELF = /(?:^|[。；;！!?？]\s*)(?:建议|推荐)/u;

/**
 * Whether a list item is a question in its own right rather than one of the
 * answers. Two marks give it away, and across every real option list measured
 * — lettered, numbered, Chinese and English — neither appeared once: the item
 * asks something itself, or it gives advice about itself. An option does not
 * recommend itself; a question with a proposed answer does.
 */
const itemIsItsOwnQuestion = (value: string): boolean =>
  (INLINE_ALTERNATIVES.test(value) &&
    !CONCESSIVE_ALTERNATIVES.test(value)) ||
  EXPLICIT_CHOICE.test(value) ||
  /[?？]/u.test(value) ||
  ADVISES_ITSELF.test(value);

/**
 * A numbered list whose items are themselves questions is a batch of
 * questions, not a set of alternatives — "1. A 还是 B。2. 是否 C。" asks two
 * things, and offering them as choices invents a decision nobody proposed. A
 * real capture turned seven independent design questions into seven mutually
 * exclusive options, each label a whole paragraph.
 *
 * The analyzer already keeps subquestions together when they share a paragraph
 * with their intro; a blank line between them should not change what they are.
 * Two such items are required: one option whose prose happens to contain 还是
 * is not a batch of questions.
 */
const listsQuestions = (options: CapturedOption[]): boolean =>
  options.filter((option) =>
    itemIsItsOwnQuestion(
      `${option.label}${option.description ?? ""}`,
    ),
  ).length >= 2;

const parseOptionBlock = (
  value: string,
): ParsedOptionBlock | null => {
  const lines = value.split(/\r?\n/u);
  const options = lines
    .map((line, index) => optionFromLine(line, index))
    .filter((option): option is CapturedOption => option !== null)
    .slice(0, 8);
  return options.length >= 2 && !listsQuestions(options)
    ? { options, raw: value }
    : null;
};

/**
 * Whether a sentence names one of the options — the same test the answer is
 * held to, because "我建议 A" and a reader replying "A" are the same act of
 * pointing at a choice, one made by the assistant and one by the reader.
 * Ids are compared case-blind: an option written `A` is answered `a` as often
 * as `A`, and both are the same choice. A one-character label would match
 * almost any sentence by accident, so it only counts as an id.
 */
const mentionsOption = (
  value: string,
  options: CapturedOption[],
): boolean => {
  const folded = value.toLocaleLowerCase();
  return options.some((option) => {
    const id = option.id?.toLocaleLowerCase();
    if (
      id !== undefined &&
      (folded === id ||
        new RegExp(
          `(?<![A-Za-z0-9])${id.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}(?![A-Za-z0-9])`,
          "u",
        ).test(folded))
    ) {
      return true;
    }
    const label = option.label.toLocaleLowerCase();
    return label.length > 1 && folded.includes(label);
  });
};

/** How far back from the closing remark an options block may still be found. */
const CLOSING_REMARK_LOOKBACK = 4;

interface DecisionRegion {
  /** Index of the options block; the question is the paragraph before it. */
  index: number;
  options: ParsedOptionBlock;
}

/**
 * A message that lays out options, recommends one of them, and then closes on
 * a remark — a caveat, a deferred second question, a note on what comes next.
 * The decision is the block in the middle, not the paragraph the message
 * happens to end on, and the recommendation between them is what says so: it
 * has to name one of the options, or an earlier list of steps would qualify
 * just as well.
 */
const decisionBeforeClosingRemark = (
  blocks: string[],
): DecisionRegion | null => {
  const last = blocks.length - 1;
  let recommendation: string | null = null;
  for (
    let index = last - 1;
    index >= Math.max(1, last - CLOSING_REMARK_LOOKBACK);
    index -= 1
  ) {
    const block = blocks[index] ?? "";
    const options = parseOptionBlock(block);
    if (options !== null) {
      return recommendation !== null &&
        mentionsOption(recommendation, options.options) &&
        !SEQUENTIAL_ACTION_INTRO.test(blocks[index - 1] ?? "")
        ? { index, options }
        : null;
    }
    if (recommendation === null && RECOMMENDS_AN_OPTION.test(block)) {
      recommendation = block;
    }
  }
  return null;
};

const boundedContext = (
  taskBackground: string | null,
  decisionFraming: string | null,
  alreadyTruncated: boolean,
): CapturedDecisionContext | undefined => {
  let task =
    taskBackground === null
      ? ""
      : stripUnsafeContent(taskBackground).slice(
          0,
          MAXIMUM_CONTEXT_FIELD,
        );
  let framing =
    decisionFraming === null
      ? ""
      : stripUnsafeContent(decisionFraming).slice(
          -MAXIMUM_CONTEXT_FIELD,
        );
  let truncated =
    alreadyTruncated ||
    (taskBackground?.trim().length ?? 0) > task.length ||
    (decisionFraming?.trim().length ?? 0) > framing.length;
  if (task.length + framing.length > MAXIMUM_CONTEXT) {
    task = task.slice(0, MAXIMUM_CONTEXT / 2);
    framing = framing.slice(-(MAXIMUM_CONTEXT / 2));
    truncated = true;
  }
  if (task.length === 0 && framing.length === 0) {
    return undefined;
  }
  return {
    ...(task.length === 0 ? {} : { taskBackground: task }),
    ...(framing.length === 0
      ? {}
      : { decisionFraming: framing }),
    ...(truncated ? { truncated: true } : {}),
  };
};

const tokens = (value: string): Set<string> => {
  const normalized = value.normalize("NFKC").toLocaleLowerCase();
  const result = new Set(
    normalized.match(
      /[\p{Letter}\p{Number}]{2,}|(?<![\p{Letter}\p{Number}])[a-z0-9](?![\p{Letter}\p{Number}])/gu,
    ) ?? [],
  );
  const chinese = normalized.match(/[\p{Script=Han}]+/gu) ?? [];
  for (const sequence of chinese) {
    for (let index = 0; index < sequence.length - 1; index += 1) {
      result.add(sequence.slice(index, index + 2));
    }
  }
  return result;
};

const intersects = (left: Set<string>, right: Set<string>): boolean => {
  for (const value of left) {
    if (right.has(value)) {
      return true;
    }
  }
  return false;
};

export class TextDecisionAnalyzer {
  analyze(
    input: DecisionTurnExcerpt,
  ): PendingDecisionAnalysis | null {
    const visible = boundedVisibleText(input.assistantText);
    const cleaned = stripUnsafeContent(visible.text);
    if (cleaned.length === 0) {
      return null;
    }
    const blocks = paragraphs(cleaned);
    const request = blocks.at(-1) ?? "";
    if (
      request.length === 0 ||
      INFORMATION_REQUEST.test(request) ||
      STATUS_ANSWER.test(request) ||
      RHETORICAL_EXPLANATION.test(request)
    ) {
      return null;
    }

    const inlineOptions = parseOptionBlock(request);
    const previousIndex = blocks.length - 2;
    const previous =
      previousIndex >= 0 ? blocks[previousIndex] ?? "" : "";
    const previousIntro =
      previousIndex > 0
        ? blocks[previousIndex - 1] ?? ""
        : "";
    const previousOptions =
      SEQUENTIAL_ACTION_INTRO.test(previousIntro)
        ? null
        : parseOptionBlock(previous);
    const region =
      inlineOptions === null && previousOptions === null
        ? decisionBeforeClosingRemark(blocks)
        : null;
    const optionBlock =
      inlineOptions ?? previousOptions ?? region?.options ?? null;
    // The decision the reader is being asked about, which is the paragraph the
    // message ends on unless the options sit further back.
    const asked =
      region === null ? request : blocks[region.index - 1] ?? request;

    const inlineAlternatives =
      (INLINE_ALTERNATIVES.test(request) &&
        !CONCESSIVE_ALTERNATIVES.test(request)) ||
      (ENGLISH_INLINE_ALTERNATIVES.test(request) &&
        (/[?？]/u.test(request) ||
          /please (?:choose|decide)/iu.test(request)));
    const recommendedOption =
      (optionBlock?.options.length ?? 0) >= 2 &&
      RECOMMENDS_AN_OPTION.test(request);
    const explicit =
      EXPLICIT_CHOICE.test(request) ||
      inlineAlternatives ||
      recommendedOption;
    const implicit = IMPLICIT_CONFIRMATION.test(request);
    if (!explicit && !implicit) {
      return null;
    }
    const finalQuestionMark = Math.max(
      request.lastIndexOf("?"),
      request.lastIndexOf("？"),
    );
    const textAfterQuestion =
      finalQuestionMark < 0
        ? ""
        : request.slice(finalQuestionMark + 1).trim();
    if (ASSISTANT_CONTINUES.test(textAfterQuestion)) {
      return null;
    }

    const framingEnd =
      previousOptions === null ? blocks.length - 1 : previousIndex;
    // Everything except the question and its options, which the reader sees
    // as fields of their own. With a closing remark the leftover runs past
    // the decision, so it is a filter rather than a prefix.
    const decisionFraming = (
      region === null
        ? blocks.slice(0, Math.max(0, framingEnd))
        : blocks.filter(
            (_block, index) =>
              index !== region.index && index !== region.index - 1,
          )
    )
      .join("\n\n")
      .trim();

    let score = 0;
    const signals: string[] = [];
    if (explicit) {
      score += WEIGHTS.explicitChoicePrompt;
      signals.push(
        recommendedOption && !EXPLICIT_CHOICE.test(request)
          ? "recommends_one_option"
          : "has_choice_prompt",
      );
    }
    if (implicit) {
      score += WEIGHTS.implicitConfirmation;
      signals.push("awaits_confirmation");
    }
    if ((optionBlock?.options.length ?? 0) >= 2) {
      score += WEIGHTS.multipleOptions;
      signals.push("has_multiple_options");
      if (region !== null) {
        signals.push("options_before_closing_remark");
      }
    } else if (inlineAlternatives) {
      score += WEIGHTS.multipleOptions;
      signals.push("has_inline_alternatives");
    }
    if (DECISION_VOCABULARY.test(cleaned)) {
      score += WEIGHTS.decisionVocabulary;
      signals.push("has_decision_vocabulary");
    }
    score += WEIGHTS.finalWaitingPosition;
    signals.push("ends_waiting_for_user");
    if (/[?？]\s*$/u.test(request)) {
      score += WEIGHTS.finalQuestionMark;
      signals.push("ends_with_question");
    }

    const context = boundedContext(
      input.userText,
      decisionFraming.length === 0 ? null : decisionFraming,
      visible.truncated,
    );
    return {
      question: asked.slice(0, 4_000),
      options: optionBlock?.options ?? [],
      ...(context === undefined ? {} : { context }),
      preScore: clamp(score),
      signals,
      detectorVersion: "rules-v1",
    };
  }

  complete(
    pending: PendingDecisionAnalysis,
    prompt: string,
  ): CompletedDecisionAnalysis {
    const answer = prompt.normalize("NFKC").trim();
    const decisionAnswer = answer.replace(/[。.!！]+$/u, "").trim();
    const signals = [...pending.signals];
    if (isCompletedDecisionStatus(decisionAnswer)) {
      return { ...pending, signals: [...signals, "answer_is_status_update"], score: 0, band: "low" };
    }
    let score = pending.preScore;
    const optionMatched = mentionsOption(answer, pending.options);
    if (optionMatched) {
      score += ANSWER_WEIGHTS.optionIdOrLabel;
      signals.push("answer_matches_option");
    }
    const scopeApproval = /^(?:只|仅)?(?:处理|实现|做)(?:第)?\s*[0-9一二三四五六七八九]/u.test(decisionAnswer) && /(?:要我|是否(?:需要)?我).{0,12}(?:做|处理|实现|执行)/u.test(pending.question);
    const diagnosticApproval = /^(?:先)?(?:用|使用).{1,80}(?:核实|定位|排查|诊断)/u.test(decisionAnswer) && pending.signals.includes("has_multiple_options") && /(?:核实|定位|排查|诊断)/u.test(pending.question);
    const explicitApproval = scopeApproval || diagnosticApproval || EXPLICIT_APPROVAL_ANSWER.test(decisionAnswer) || /^(?:确认|批准|可以)[，,]/u.test(decisionAnswer) ||
      (/^(?:commit\s*\+\s*push|提交(?:并|、|，|\s)*推送)(?:\b|[，,、\s]|$)/iu.test(decisionAnswer) && /(?:提交|推送|评审|commit|push|PR)/iu.test(pending.question));
    const directionalApproval =
      DIRECTIONAL_APPROVAL_ANSWER.test(decisionAnswer);
    const shortAnswer = SHORT_ANSWER.test(decisionAnswer);
    if (explicitApproval) {
      score += ANSWER_WEIGHTS.explicitApproval;
      signals.push("answer_is_explicit_approval");
    } else if (directionalApproval) {
      score += ANSWER_WEIGHTS.directionalApproval;
      signals.push("answer_is_directional_approval");
    } else if (shortAnswer) {
      score += ANSWER_WEIGHTS.yesNoOrOrdinal;
      signals.push("answer_is_short_decision");
    }
    const requestTokens = tokens(
      `${pending.question}\n${pending.options
        .map((option) => option.label)
        .join("\n")}`,
    );
    const answerRelated = intersects(requestTokens, tokens(answer));
    if (answerRelated && !optionMatched) {
      score += ANSWER_WEIGHTS.lexicalRelation;
      signals.push("answer_lexically_related");
    }
    // A task identifier in a progress update is not an option selection.
    if (answerRelated && !optionMatched && !explicitApproval && !directionalApproval && !shortAnswer && /(?:^|[\s，,])(?:PR|issue|任务|构建)\s*#?\d+/iu.test(decisionAnswer)) {
      score = Math.min(score, 74);
      signals.push("answer_has_only_lexical_evidence");
    }
    const hasAnswerRelation =
      optionMatched ||
      explicitApproval ||
      directionalApproval ||
      shortAnswer ||
      answerRelated;
    const unrelated =
      (TOPIC_SHIFT.test(answer) ||
        (answer.length >= 8 && NEW_TASK.test(answer))) &&
      !optionMatched &&
      !explicitApproval &&
      !directionalApproval &&
      !shortAnswer &&
      !answerRelated;
    if (unrelated || answer.length === 0) {
      signals.push(
        unrelated ? "unrelated_new_task" : "empty_answer",
      );
      score = 0;
    } else if (!hasAnswerRelation) {
      signals.push("answer_relation_uncertain");
      score = Math.min(score, 60);
    }
    if (
      answer.length > 0 &&
      !unrelated &&
      hasAnswerRelation &&
      MIXED_ANSWER.test(answer)
    ) {
      signals.push("answer_is_mixed");
      score = Math.min(score, 74);
    }
    if (
      pending.signals.includes("awaits_confirmation") &&
      !pending.signals.includes("has_choice_prompt")
    ) {
      signals.push("implicit_confirmation_cap");
      score = Math.min(score, 74);
    }
    const finalScore = clamp(score);
    const band: DecisionBand =
      finalScore >= 75
        ? "high"
        : finalScore >= 50
          ? "medium"
          : "low";
    return {
      ...pending,
      score: finalScore,
      band,
      signals,
    };
  }
}
