import { hasRecommendationMarker, markedRecommendation, stripRecommendationMarker } from "./recommendation.js";
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
  /** Earlier versions are what pending turns saved by an older bridge carry. */
  detectorVersion: "rules-v1" | "rules-v2" | "rules-v3" | "rules-v4" | "rules-v5" | "rules-v6" | "rules-v7" | "rules-v8" | "rules-v9" | "rules-v10";
}

export interface CompletedDecisionAnalysis
  extends PendingDecisionAnalysis {
  score: number;
  band: DecisionBand;
  /** The options the reply takes, read by `readReply`; what the event records. */
  selected: CapturedOption[];
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

/** Someone other than the assistant giving the advice: 评审意见：建议采用… */
const NOT_BY_THIRD_PARTY =
  "(?<!(?:评审|审阅|审查|评论|他|她|他们|团队|文档|官方|同事|作者)(?:的)?(?:意见|结论)?[:：]?\\s*)";
/** Asking which one, with nothing else: "哪个端口？" asks for a fact as often as for a choice. */
const ASKS_WHICH = /哪[一几]?(?:个|种|项|些)/u;
/** A which-question about the present state: 目前、已经、正在、currently. */
const ASKS_HOW_THINGS_ARE = /(?:目前|当前|已经|正在|currently|already|right now)/iu;
const ENGLISH_WHICH_STATUS = /\bwhich\s+(?:\w+\s+){0,2}(?:tasks?|steps?|changes?|items?|options?)\s+(?:(?:are|is|was|were|have|has)\s+(?:already\s+)?(?:complete(?:d)?|done|run|passed|pending)|remain\b)/iu;
/** What turns a "which" into a choice: options to weigh, or a word for weighing them. */
const WEIGHS_ALTERNATIVES =
  /(?:更|比较|最|合适|推荐|倾向|方案|方式|做法|路线|选)/u;
/**
 * A yes/no question about something the assistant would do next — 现在要提交吗？
 * 要把它合并到 main 吗？ 这三项都要做吗？ Agents ask for approval this way far
 * more often than with 是否; the verb has to follow the 要 closely, and a
 * question about how something turned out (运行正常吗、通过了吗) is about a fact.
 */
// "需要" only with the assistant as subject: "升级需要改 CI 配置吗？" asks a fact.
const ACTION_YES_NO =
  /(?:(?<!需)要|需要我|现在就?要?|是否(?:需要|要)?|可以)(?:由?我来?)?(?:现在)?就?(?:[把按][^。！!?？\n]{0,20}?)?(?:提交|合并|推送|发布|部署|执行|继续|开始|做|实施|删除|应用|处理|修改|实现|运行|安装|升级|回滚|清理|改)(?:(?!正常|成功|通过|完成|了)[^。！!?？\n]){0,24}[吗么]/u;
/**
 * Asking for a verdict on each item: 请逐项确认、麻烦分别批复、每一项请回复、
 * confirm each item. The reader has to be the one asked (请、麻烦、你), with
 * no 已/过/了 in between — "我分别改了两个文件，均已确认"、"每个决定都记录在
 * docs 里了" report — or the line is a bare heading over the list, "逐项批复：".
 * The reader is then asked to pick among the items, however they are numbered.
 */
const ITEMWISE_REQUEST =
  /(?:(?:请|麻烦|烦请|你|您|需要你)[^。！!？?\n已过了]{0,8}?(?:(?:逐(?:项|条|一|个)|分别|每一?[项条个]|各[项条])[^。！!？?\n已过了]{0,12}(?:确认|批复|批准|答复|回复|决定|表个?态|给(?:个|出)?意见|告诉我)|(?:确认|批复|批准|答复|回复|决定|表个?态|给(?:个|出)?意见|告诉我)[^。！!？?\n已过了]{0,12}(?:逐(?:项|条|一|个)|分别|每一?[项条个]))|(?:逐(?:项|条|一|个)|分别|每一?[项条个]|各[项条])[^。！!？?\n已过了]{0,4}(?:请|麻烦|烦请|你|您)(?:你|您)?[^。！!？?\n已过了]{0,6}(?:确认|批复|批准|答复|回复|决定|表个?态|给(?:个|出)?意见|告诉我)|^\s*(?:逐(?:项|条|一|个)|分别)批复\s*[：:]\s*$|\b(?:confirm|approve|decide|answer|reply|sign off|go\/no-go)\b[^.!?\n]{0,30}\b(?:each|individually|item by item|one by one)\b|\bfor each (?:item|of these|one)\b)/imu;
/** A list item that ends on a question mark. */
/** A closing remark saying nothing is asked, or reporting a choice already made or work already finished. */
const NEEDS_NO_ANSWER =
  /(?:\bno (?:answer|reply|response|decision|action) (?:is )?(?:needed|required)\b|\bnothing (?:remains|is left|left) (?:for you )?to decide\b|\bno need to (?:answer|reply|respond)\b|无需(?:你)?(?:回复|回答|决定|处理)|不需要(?:你)?(?:回复|回答|决定)|不用(?:回复|回答)|\b(?:chose|decided on|picked|went with|agreed on|settled on)\b|已经(?:决定|选了|选定|定了)|(?:选定|定下)了|\b(?:is|are|was|has been) (?:now )?(?:complete|completed|finished|done)\b|\brecords? the result\b|已(?:经)?(?:完成|结束))/iu;
/**
 * Handing the choice over without a question word: "Let me know which you'd
 * like"、"Reply with the number"、"Up to you."、"你来定。"、"回复编号即可". The
 * paragraph has to open with it — "看你之前提到的 bug 也修了" and "The retry
 * count is up to you; I left it at 3" only mention the reader — and it is read
 * as a request only right under the options it hands over.
 */
const HANDS_OVER_CHOICE =
  /^(?:so,?\s+|just\s+)?(?:let me know which\b|tell me which (?:ones?|options?|items?|one to|to)\b|reply with (?:the )?(?:numbers?|ids?|letters?)\b(?!\s+of\b)|(?:it'?s\s+)?(?:entirely\s+|totally\s+)?up to you\s*[.!]?$|(?:approve|accept|reject) (?:any|some|all) of (?:these|them)\b|let me know if you want me to (?:do|apply|implement|go ahead with) (?:any|some|all|one) of (?:these|them)\b|(?:请)?(?:你(?:来)?定|看你|听你的|由你(?:来)?(?:定|决定|挑)|你说了算|你挑)[。！!～~\s]*$|(?:请)?(?:回复|告诉我|给我)(?:一下)?(?:对应的?)?(?:编号|序号|字母)|(?:要|想)(?:做|保留|上|改)?哪几(?:项|个|条))/iu;
const QUESTION_ITEM = /^\s*(?:[-*•]|\d{1,2}[.)、]|[A-Ha-h][.)、])\s*(.+[?？])\s*$/u;
/**
 * Asked item by item: in so many words, or as a closing list of questions —
 * but a list of questions only when each asks for a decision (是否、还是、要不要)
 * or a list of proposals sits above it. "数据量多大？/峰值 QPS 是多少？" before
 * starting work asks for facts.
 */
const asksItemByItem = (text: string, proposals = false): boolean => {
  if (ITEMWISE_REQUEST.test(text)) {
    return true;
  }
  const questions = text
    .split(/\r?\n/u)
    .flatMap((line) => line.match(QUESTION_ITEM)?.[1] ?? []);
  return (
    questions.length >= 2 &&
    (proposals ||
      questions.every(
        (question) =>
          EXPLICIT_CHOICE.test(question) ||
          (INLINE_ALTERNATIVES.test(question) && !CONCESSIVE_ALTERNATIVES.test(question)),
      ))
  );
};
const EXPLICIT_CHOICE_WITHOUT_WHICH =
  /(?:(?:怎么|怎样|如何)(?:安排|排(?=序|优先级|期|班|顺序|[？?。]|$)|分配|取舍)|^(?:请)?选(?:择|出)?(?:要|需要|你要)[^。？?\n]{0,8}(?:项|个|种)|(?:给出|告诉我)(?:你的)?[^。\n]{0,8}(?:决定|选择|答复)|你(?:可以)?(?:明确)?(?:指定|批准)[^。！!？?\n]{0,20}(?:编号|范围|改动)|你(?:希望|想|更倾向|选择|选|怎么选)|(?:你|您)的(?:选择|决定)是|请(?:回答|回复)[^。\n]{0,20}(?:或|还是|\/)|请(?:选择?|决定|确认)|(?<![A-Za-z0-9])[A-H](?:\s*[、,，/／]\s*[A-H])*\s*(?:或者?|\bor\b)\s*[A-H](?![A-Za-z0-9])|要我.{0,24}[吗么]|是否|要不要|可以吗|继续吗|选哪|选(?:一个|一种)|(?:从|在).{0,30}(?:中|里)选|which\s+(?:\w+\s+)?(?:approach(?:es)?|options?|ways?|ones?|choices?|steps?|changes?|items?|tasks?|proposals?)|which (?:to )?(?:apply|implement|execute|run|do)\b|which of (?:these|them|the (?:above|following))|choose|\bpick (?:any|one|the|from)\b|please (?:decide|confirm)|do you (?:prefer|want|approve)|would you|should we|shall we|(?:want|need) me to|shall I|should I|your (?:choice|pick|call)\b|(?:sounds? good|ok(?:ay)? to (?:proceed|continue)|is (?:that|this) (?:ok|okay|alright))\s*\?)/iu;
const EXPLICIT_CHOICE = new RegExp(
  `${EXPLICIT_CHOICE_WITHOUT_WHICH.source}|${ASKS_WHICH.source}|${ACTION_YES_NO.source}`,
  "iu",
);
/**
 * What agents append after the question they just asked: what they did not
 * do, what they did not check. Codex closes almost every reply this way, and
 * reading that note as the request hid the question right above it.
 */
const TRAILING_DISCLAIMER =
  /^(?:(?:目前|当前|此前|本次|这次)?(?:我)?(?:未|尚未|没有|并未|暂未|均未|都没有?|已?跳过|已?略过)|以上(?:为|是|均为|仅为)|skipped\b|(?:注|备注|说明|note|status)[:：]|(?:I )?(?:did not|didn't|have not|haven't)\b|no (?:tools|files|code|tests?|checks?)\b|(?:tests?|testing|checks?|validation|verification)(?:\s+status)?\s*(?::\s*|(?:was|were|have been|has been)\s+)?(?:(?:was|were|have|has)(?:n't| not)(?: been)?|not|skipped|unrun)\b|not (?:yet )?(?:checked|verified|run|tested)\b)/iu;
const MAXIMUM_TRAILING_DISCLAIMERS = 2;
const afterFirstSentence = (paragraph: string): string =>
  paragraph.replace(/^[^。.!！\n]*[。.!！\n]?/u, "");
/** "未运行测试，请逐项确认": a request riding in the note's own sentence. */
const REQUEST_IN_NOTE =
  /(?:(?:[，,；;:：]|——|\s[—–-]\s)\s*请(?:你|您)?(?:逐项|分别)?(?:确认|选择?|决定|批复|回复|告诉我)|(?:[，,；;:：]|——|\s[—–-]\s)\s*(?:please )?(?:confirm|choose|pick(?!\s+up\b)|decide|let me know|which (?:to (?:apply|implement|execute|run|do)|(?:one|options?|approach(?:es)?|ways?)(?=\s*(?:[.?]|$)|\s+(?:should|shall|would|do you|to)\b)|[^.!?\n,;:]{0,60}\b(?:should|shall|would|do you)\b)|your (?:call|choice|pick))\b(?!-))/iu;
/**
 * "你怎么看？" after "推荐 YAML（A）" hands the recommendation over for a
 * verdict; on its own it is small talk, so the message has to recommend.
 */
const ASKS_FOR_VERDICT =
  /(?:你(?:怎么看|怎么想|觉得(?:呢|如何|怎么样)|意下如何|的意见)|what do you think|any thoughts|thoughts\s*\?)/iu;
/**
 * Any recommendation, the reviewer's included: "评审意见：建议采用 2，你怎么看？"
 * is still the assistant asking. Only a bare recommendation with no question
 * (RECOMMENDS_AN_OPTION) has to be the assistant's own.
 */
const MAKES_A_RECOMMENDATION =
  /(?:推荐|建议|我倾向|I(?:'d| would)? recommend|I suggest|my recommendation)/iu;
/** A closing paragraph that still asks: "没有特别偏好的话，我倾向 A。" is no disclaimer. */
const STILL_ASKS =
  /(?:我(?:的)?(?:建议|倾向|推荐)|我就|还是|I(?:'d| would)? recommend|I lean)/iu;
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
const RECOMMENDS_AN_OPTION = new RegExp(
  `(?:我(?:的)?建议|我倾向|${NOT_BY_THIRD_PARTY}(?:建议(?:选|采用|走)|推荐(?:选|采用)?)|I(?:'d| would)? recommend|my recommendation|I lean toward)`,
  "iu",
);

const DECISION_VOCABULARY =
  /(?:方案|路线|建议|倾向|权衡|风险|取舍|优先|approach|option|trade-?off|risk|recommend)/iu;
const INFORMATION_REQUEST =
  /(?:请(?:提供|输入|粘贴|上传|告诉我)|(?:还)?需要(?:你|您)(?:提供|给|告诉)|(?:I|we)(?:'ll)? need (?:you to|your)\b|(?:这个|该)?仓库.{0,20}(?:放在)?哪(?:个路径|里|个位置)|please (?:provide|enter|paste|upload))/iu;
const STATUS_ANSWER =
  /^(?:测试|检查|构建|状态|test|check|build|status).*(?:是否|结果|result|passed).*[:：]\s*(?:是|否|通过|失败|yes|no|pass|fail)/iu;
const ASSISTANT_CONTINUES =
  /(?:我(?:先|已经|已)?(?:按|用|选)[^，,。！？?\n]{0,12}(?:做|改|实现|执行)(?:了|完)|\bwent ahead with\b|\bI (?:already )?(?:applied|implemented|chose|picked)\b|我(?:已经)?决定|我(?:现在|接下来|将|会).{0,16}(?:开始|继续|执行|实现)|I (?:have )?decided|I(?:'ll| will| am going to| am).{0,24}(?:start|continue|implement|proceed|go ahead)|\bin the meantime,? I(?:'ll| will| am)\b|\bI(?:'ll| will) (?:hold off|take|go with|stick with)\b|\bwent with\b|\bnot worth it\b|\bnever ?mind\b|算了|我(?:先|就先)(?:按|不)|先不动|我先(?:按|用)[^，,。！？?\n]{0,12}(?:做着|开始)|(?:the )?(?:patch|implementation|change) is (?:complete|done))/iu;
/** "Once you confirm, I'll proceed": what the assistant will do waits on the reply. */
const CONDITIONAL_ON_REPLY =
  /(?:(?:确认|同意|批准|回复)(?:之)?后|(?:once|after|when|if) you(?:'ve)? (?:confirm|approve|agree|reply|say)|on your (?:go|confirmation|approval))/iu;
const RHETORICAL_EXPLANATION =
  /[?？]\s*(?:因为|原因是|答案是|because|the reason is)/iu;
const SHORT_ANSWER =
  /^(?:(?:就)?选(?:择)?\s*)?(?:\d+(?:\s*(?:、|,|和|与|后|then)\s*\d+)*|[A-Za-z](?:\s*(?:、|,|和|与)\s*[A-Za-z])*)$|^(?:确认|批准|执行|可以|不要|同意|拒绝|继续|不继续|是|否|好|好的|按.{0,8}建议|yes|no|ok(?:ay)?|go ahead|do it)$/iu;
const EXPLICIT_APPROVAL_ANSWER =
  /^(?:(?:确认|批准|执行)(?:吧|即可|就行)?|可以|继续|不继续|同意|拒绝|是|否|好|好的|yes|no|ok(?:ay)?|go ahead|approved|do it|proceed)$/iu;

const COMPLETED_STATUS = /^(?:我们?|这边)?(?:已(?:经)?(?:合并|提交|推送|发布|部署|重连|修复|构建|安装|关闭|删除)好?(?:了|完成|成功|完毕)?|(?:合并|提交|推送|发布|部署|重连|修复|构建|安装|关闭|删除)(?:好了|了|完成|成功|完毕))$/u;
/** "Already merged." / "It's already pushed": the act is done, nothing is being approved. */
const ENGLISH_COMPLETED_STATUS = /^(?:(?:it(?:'s| is| was| has been)|i(?:'ve| have)|we(?:'ve| have))\s+)?(?:already\s+)?(?:merged|pushed|committed|released|deployed|installed)(?:\s+(?:it|already))?$/iu;
export const isCompletedDecisionStatus = (text: string): boolean => {
  const answer = text.normalize("NFKC").trim().replace(/[。.!！]+$/u, "").trim();
  return COMPLETED_STATUS.test(answer) || ENGLISH_COMPLETED_STATUS.test(answer);
};
const DIRECTIONAL_APPROVAL_ANSWER =
  /^(?:同意|不要|不批准|(?:(?:先|暂(?:时)?)?(?:别|不用|不必)|先不|暂不)(?:了|动|做|改|提交|合并|推送|发布|部署|删|执行|继续|处理|上线|迁移|升级|引入)|(?:就)?选(?:择)?\s*(?:[A-Za-z0-9](?![A-Za-z])|第|方案|这|那|前|后)|采用|是[，,]|否[，,]|do not\b|don't\b|keep\b|remove\b|preserve\b|yes[\s,.]|no[\s,.]|let'?s (?:go with|use|do)\b|go with\b|stop\b|sounds good\b|go for it\b|lgtm\b|approved\b|proceed\b|(?:但|不过)?就(?:它|这个|那个)(?:了|吧)$)/iu;
/**
 * A first clause that is a go-ahead and nothing else: 批准、批准实施、Approved、
 * Approve A、Yes、go ahead — not "Approved is the status label" or 同意先看.
 */
const APPROVAL_CLAUSE =
  /^(?:(?:我)?(?:批准|同意)(?:实施|执行)?(?:吧)?|approved?(?:\s+(?:it|this|that|[A-H1-9]))?|yes|go ahead|lgtm)$/iu;
/** The rest swaps the approved act for another: instead of implementing、而不是实施、先别实施. */
const SWAPS_THE_ACT = /(?:\binstead\b|\brather than\b|而不是|(?:不|别|先别|先不)(?:要)?(?:实施|执行|做|改|合并|发布))/iu;
const firstClauseOf = (value: string): string =>
  value.split(/[，,。.!！?？;；:：]|\s*[—–]+\s*|\s-\s/u)[0]?.trim() ?? "";
/** "Should I apply it now?"、"Do you want me to merge?": a yes/no on the assistant's next act. */
const ASKS_FOR_A_GO = /\b(?:should|shall|can|may) I\b|\b(?:want|need) me to\b/iu;
/** A question asking for a go-ahead, as opposed to a pick or a fact. */
const APPROVAL_ASKED = /(?:批准|同意|允许|\bapprov|\bgo ahead\b|\bproceed\b)/iu;
/**
 * A question that offers a look beside a go-ahead: "你想先看哪一项的详细改动，
 * 还是直接批准实施？"、"see the diff for one first, or approve some now?". A
 * reply naming an option there may only be picking what to look at.
 */
const OFFERS_A_LOOK =
  /(?:(?:先|再)?(?:看|查看|过目|展开)|\b(?:see|show|look at|review|inspect)\b)[^。！!?？]{0,40}?(?:还是|或者|也可以|\bor\b)[^。！!?？]{0,40}?(?:批准|实施|执行|采用|\bapprov|\bimplement|\bapply|\bgo ahead\b)|(?:批准|实施|执行|采用|\bapprov|\bimplement|\bapply)[^。！!?？]{0,40}?(?:还是|或者|也可以|\bor\b|[?？。.]\s*(?:如果|若|\bif\b)?[^。！!?？]{0,20}?)(?:先|再)?(?:看|查看|过目|展开|\b(?:see|show|look at|review)\b)/iu;
/** Asking to see something, and a word that goes ahead after all: "Use B to review every PR" adopts B. */
const ASKS_TO_SEE = /(?:看|查看|过目|展开|贴出|\b(?:show|see|look at|review|inspect)\b)/iu;
const TAKES_A_GO = /(?:批准|同意|实施|执行|采用|就按|(?:^|就|改|先)用|选|\bapprov|\bimplement|\bapply|\bgo with\b|\bpick\b|\bchoose\b|^\s*(?:let'?s\s+)?(?:use|switch to)\b)/iu;
const DEICTIC_APPROVAL_ANSWER = /^(?:但|不过)?就(?:它|这个|那个)(?:了|吧)$/u;
const MIXED_ANSWER =
  /(?:另外|同时|顺便|并且|以及|also|and (?:also|then|please|explain|why))/iu;
const NEW_TASK =
  /(?:帮我|请|实现|开发|修复|新增|写一个|创建)\s*|\b(?:create|build|implement|fix|add|help|explain|document|find|search|summarize|read|show)\b/iu;
/** Asking to inspect an option does not approve carrying it out. */
const READ_ONLY_REQUEST =
  /^(?:(?:我)?(?:想|要)?(?:先|只|仅|再)?(?:请(?:你|您)?)?(?:帮我|给我)?去?(?:解释|说明|分析|比较|对比|展示|查看|看一下|看下|看看|查一下|查查|排查|调查|核实|检查|梳理|研究一下)|(?:(?:can|could|would) you\s+|let(?:[’']?s| us)\s+(?:first\s+)?)?(?:please\s+)?(?:(?:first|just)\s+)?(?:show|read|explain|compare|describe|inspect|review|analyze|analyse|check\b(?=[^.;,]*\b(?:against|whether|if|why|how)\b)|investigate|examine|list\b(?=[^.;,]*\b(?:callers|affected|dependen\w*|usages?)\b)|pull\b(?=[^.;,]*\b(?:data|logs?|numbers|metrics)\b)|look (?:at|into)|walk me through)\b|I (?:only |just )?asked (?:you )?(?:to|for)\b|I (?:am|was) only asking for (?:information|analysis)\b|(?:(?:today|for now),?\s+)?I(?:'m| am| was)? (?:only |just )?(?:(?:want|need) to )?(?:asking|comparing|compare|reviewing|review|inspecting|inspect|looking|weighing|describing|recording)\b)/iu;
const TOPIC_SHIFT =
  /^(?:(?:先)?暂停(?:这个|这些|它)|换个(?:话题|问题)|聊(?:聊|一下)|不谈这个|先说别的|先不(?:管|说|谈|聊)(?:这个|这些|它)?|(?:先)?别管|(?:这个)?先放一?放|never ?mind\b|forget (?:it|that|about (?:it|that))\b|let'?s (?:move on|switch)\b|(?:on )?a different (?:topic|note)\b)/iu;
/**
 * Colloquial yeses — 行、没问题、可以的 — answer a yes/no question; put to a
 * choice among options, "行" says nothing about which one.
 */
const COLLOQUIAL_APPROVAL = /^(?:行|行啊|成|没问题|可以的|可以啊|好啊|好呀)$/u;
/** "行吧，那先不做": the lead-in concedes, the rest is the answer. */
const CONCEDING_LEAD = /^(?:(?:行吧|好吧|那好吧)[，,。.\s]+)?(?:那(?:就)?\s*)?/u;
/** "收到" / "好的，了解" acknowledges the message and answers nothing. */
const ACKNOWLEDGEMENT =
  "(?:(?:好的?|ok(?:ay)?|嗯)[，,。.!！\\s]*)?我?(?:收到|了解|明白了?|知道了|看到了|got it\\b|noted\\b|thanks\\b|thank you\\b|谢谢)(?:了|啦|哈|的)?";
/** Nothing after the acknowledgement: "收到" yes, "收到，先不提交" no. */
const ACKNOWLEDGES_ONLY = new RegExp(
  `^${ACKNOWLEDGEMENT}(?:[，,。.!！~\\s]+(?:thanks|谢谢))?[，,。.!！~\\s]*$`,
  "iu",
);
/** "收到，" in front of the actual answer, which is judged without it. */
const ACKNOWLEDGEMENT_PREFIX = new RegExp(`^${ACKNOWLEDGEMENT}[，,。.!！\\s]+`, "iu");
/**
 * Saying what an option is like, or that nobody has looked yet, decides
 * nothing about it: 太重了、看起来不错、不行、有点悬、还没看.
 */
const ONLY_EVALUATES =
  /(?:太.{1,8}?了|太(?:重|贵|慢|复杂|麻烦)|看起来|看着|感觉|不行|不理想|有点|还行|不错|挺好|稳一些|悬|还没|没(?:看|想|试|跑|定)|未(?:定|看|决)|上次|上周|上个月|昨天|前天|之前|以前|曾经|(?:用|试|做|跑|上)过|\blooks?\b|\bseems?\b|not (?:great|ideal|sure)|haven'?t (?:looked|checked|tried)|\b(?:is|are|was|were)\s+anything but\b|\b(?:anything|everything) but\b[^,;.!?]{1,40}?\b(?:is|are|was|were|would|could|might)\b(?:\s+be\b)?(?!\s+(?:fine|ok(?:ay)?|good|acceptable|approved|my (?:choice|pick))\b)|\bworks? for me\s+(?:in|on|locally|here)\b|\bworked\b|\blast (?:week|month)\b|(?:以后|之后|后面|将来)还(?:得|要|需要)|\b(?:needs?|requires?|will need)\b[^,.;]{0,40}\blater\b)/iu;
/**
 * What a clause does to an option it names: 先上、可以合、照做、就行、跳过、go
 * with. A one-character verb counts only where it acts — opening the clause or
 * after 先/就/可以…, and followed by the option or a particle — because inside
 * 上手成本高、改动太大、要等很久 the same character only describes the option.
 */
const DECISION_WORDS =
  /(?:都试试|照做|就行|采用|保留|跳过|不要|不用|别|执行|实施|处理|实现|go with|\bproceed with\b|\bI want\b|\bmake\b|\bdo\b|\bkeep\b|\bdrop\b|\bskip\b|\buse\b|\bpick\b|\btake\b|\bship\b|\bmerge\b|\brun\b|(?:^|[\s，,、]|先|就|都|也|现在|马上|可以|直接|暂时|暂且|其余(?:的)?|其他(?:的)?|其它(?:的)?)(?:上|合|做|用|改|按|走|定|要|弄|删|选)(?=\s*(?:[A-Za-z0-9]|第|方案|选项|这|那|它|吧|呗|掉|$)))/iu;
/**
 * Acts added in rules-v7 — choose、switch to、就还是 2、然后合并 2. They take an
 * option only inside `clauseStance`, where an option is named, so they never
 * strip label pieces or lift replies that name no option.
 */
const TAKES_IN_WORDS =
  /(?:\bchoose\b|\bselect\b|\bkeep it\b|\bswitch to\b|\bmove to\b|^so\s+(?=(?:option\s+)?[0-9]\b(?!\s+(?:is|are|was|were|has|needs?|would|will|seems?|looks?)\b))|\bgo\s+(?=(?:option\s+)?[0-9]\b(?!\s*(?:weeks?|days?|months?|hours?|minutes?|times?|steps?|more)\b))|就还是(?=\s*[A-Za-z0-9])|(?:合并|上线)(?=\s*(?:[A-Za-z0-9]+|它)(?!\s*的))|(?:继续|决定|改|也就是|然后|再|接着)(?:上|合|做|用|改|按|走|定|要|弄|删|选)(?=\s*(?:[A-Za-z0-9]|第|方案|选项|这|那|它|吧|呗|掉|$)))/iu;
/** Preferences that take an option the way 2 更好 does: 2 更合适、I prefer 2、2 wins. */
const PREFERS =
  /(?:\b(?:is|are) (?:selected|chosen)\b|(?:更好|更合适|好一些|更佳|首选|倾向)(?![^，,。；;]{0,8}的(?!方案|做法|版本|思路|路线|改法|来))|\bprefer\b|\b(?:is|'s)\s+(?:the\s+)?better\b|\bbetter\s*[.!]?$|^definitely\s+(?:option\s+)?[0-9A-Za-z]+\s*[.!]?$|\bdefinitely\s*[.!]?$|\bfor sure\s*[.!]?$|\bwins\s*[.!]?$|\bI'?d go\b(?!\s+[0-9]+\s*(?:weeks?|days?|months?|hours?|minutes?|times?|steps?|more)\b)|\bmakes (?:more |the most )?sense\s*[.!]?$|\bsounds right\b)/iu;
/** 改用 2 的成本、就还是 1 的问题: the option heads a noun phrase, it is not taken. */
const NAMES_A_NOUN = /(?:[0-9A-Za-z]|它)\s*的(?!方案|做法|版本|思路|路线|改法|来)/u;
/** Conditions and contrasts under which a new act or preference only weighs: 如果…的话、if、on paper、but. */
const WEIGHS_A_TAKE =
  /(?:^(?:如果|要是|假如|若)|的话|\bif\b|\bin case\b|\bon paper\b|\bover\b|\bbut\b|但|不过|可是|\bwould\b|\bcould\b|\bmight\b)/iu;
/** Thinking an option over rather than taking it: 想想、考虑、思路、再议. */
const STILL_THINKING = /(?:想一?想|考虑|思路|琢磨|研究一下|再议|\bthink\b(?!\s+(?:that\s+)?(?:option\s+)?[0-9A-Za-z]+\s+(?:is|'s)\s+(?:the\s+)?better\b)|\bconsider\b)/iu;
/** Weighing options rather than taking one: 还是、或者、比较、区别、vs. */
const WEIGHS_OPTIONS =
  /(?:(?<!就)还是|就还是(?=[^，,。；;]*的(?!方案|做法|版本|思路|路线|改法|来))|或者|或|\bor\b|\bvs\b|比较|对比|区别|差别)/iu;
/**
 * A reply that only asks back: 旧接口目前被多少地方调用？ One sentence, so
 * "本次引入的需要处理。另外，为什么…？" still answers before it asks.
 */
const ANSWER_IS_QUESTION = /^[^。！!；;\n]*?(?:[?？]|[吗呢么])\s*$/u;
/**
 * Saying no decision has been made, whatever was said about the options before:
 * 暂不决定、先别选、我没批准、还要再压测、不代表做了新决策、no new choice today.
 */
const DECISION_WITHHELD =
  /(?:(?:暂|先|还)(?:时)?不(?:决定|定|选|批)|先别(?:选|定|批)|还没(?:想好|决定|批准|选)|(?:先|暂(?:时)?|还)?不做(?:选择|决定)|没(?:有)?批准|不是批准|不(?:要|能)?(?:把[^，,。；;]{0,12})?(?:当作|当成|算作?)批准|不代表|没有新(?:的)?(?:选择|决定|决策)|再等等|还(?:要|得|需要?)(?:再|讨论|商量|评估)|(?:要|得|先)等[^，,。；;]{0,8}(?:结果|数据|评审|确认)|先收集(?:更多)?(?:数据|信息)|\bno new (?:decision|choice)\b|\bno decision yet\b|\bnot (?:yet )?(?:approving|deciding|choosing|picking|decided)\b|\bhaven'?t (?:yet )?(?:decided|approved|chosen|made up my mind)\b|\bnot a (?:new )?decision\b|\bno decision (?:has been|was|is) made\b|\bbefore (?:choosing|deciding)\b|不是定案|\b(?:after|once|until|when) I(?:'ve)? approved?\b|等我(?:批准|同意))/iu;
/** Putting the choice off: 比较后再决定、我先想想、let me think about it. */
const DEFERS_DECISION_WORDS =
  /(?:(?:等|待)(?:我|我们|你|您)[^，,。；;\n]{0,12}(?:确认|批准)[^，,。；;\n]{0,12}再|^(?:别急|先等等?|等一下|wait\b|hold on\b)|我?先?看看$|再看看吧?[。.!！]*$|再说[。.!！]*$|再议|待定|(?:先)?观望|都不理想|(?:稍后|晚点|回头|之后|改天|过会儿?)(?:再)?(?:处理|看|弄|回复|回你|跟进|告诉你|答复你?|说|定)|先(?:问问|问一下|问.{1,6}(?:同事|产品|运维|PM)|商量一下|确认一下|(?:跟|找|和|问).{1,8}(?:确认|商量|讨论))|再跟.{1,8}(?:确认|商量|讨论)|先不(?:选|批)|先别急|别急着|别着急|\blater\b|(?:之后|以后|稍后|回头|晚点|后面|然后)?再(?:决定|定|考虑)|后再(?:决定|定|说)|考虑(?:一下|考虑)|想一?想|还没(?:想好|决定)|先不(?:决定|定)|\bneed more time\b|decide later|then decide|decide (?:after|once|when)|let'?s wait|wait (?:for|until)|hold off|let me think|get back to you|haven'?t decided|not sure yet|\bnot (?:approving|deciding|choosing)\b)/iu;
/** Reservations after a preference: let's measure first、pending the benchmark、先压测一下、等压测结果、再确认. */
const RESERVES =
  /(?:\blet'?s (?:measure|benchmark|test|try|validate|verify)\b[^.;]{0,30}\bfirst\b|\bbefore we (?:commit|decide|choose)\b|\bpending (?:the )?(?:benchmark|results?|review|load test|tests?)\b|\bI'?ll (?:confirm|check) with\b|先(?:压测|测测|测一下|跑个|验证一下|试一下)|再确认|(?:对|商量)一下再定|(?:^|[，,；;。]\s*)等[^，,。；;]{0,8}(?:结果|数据))/iu;
const DEFERS_DECISION = new RegExp(`${DEFERS_DECISION_WORDS.source}|${DECISION_WITHHELD.source}|${RESERVES.source}`, "iu");
/**
 * A reply that withholds or reserves the decision as a whole, whatever else it says: 可以，不过还没决定、等 QA 的结果、
 * 先压测一下再确认. Putting one item off (3 以后再说) is not this: that is part of a partial approval.
 */
export const withholdsDecision = (reply: string): boolean => DECISION_WITHHELD.test(reply) || RESERVES.test(reply);
/**
 * A reply that says how things are rather than what to do: asked "环境变量还是
 * 配置文件？", "当前生产使用环境变量" reports a fact and chooses nothing.
 */
const DESCRIBES_CURRENT_STATE =
  /^(?:(?:当前|目前)(?!\s*(?:先|暂|还是先|就\s*(?:用|选|按|上|定|采用|走|做|还是(?=[^，,。]*吧))))|(?:our|the) current\b|现状是|(?:目前|当前|现在)(?:的)?(?:配置|设置|方案)?就?还是(?![^，,。]*吧)|现有|实际上?|一直|原来|之前|现在(?:线上|生产(?:环境)?)?(?:用的是|跑的是|是)|(?:线上|生产(?:环境)?|现网)(?:现在|目前|当前)?(?:用的是|跑的是|在用|用着|是)|currently\b|right now\b|at the moment\b|it(?:'s| is) currently\b|(?:we|they) (?:currently|still) (?:use|run|are on)\b)/iu;
/** An act, approval or refusal in so many words, whether or not it maps to an option. */
const ACTS_IN_WORDS =
  /(?:批准|同意|\bapprov|^(?:please\s+)?(?:add|ship|go|do|use|keep|implement|apply|merge|run|enable|disable|execute|pick|choose|select|take|start|fix|update|remove|leave|hold|switch|move|let[’']?s)\b|^(?:先|就|都|也|只)?(?:加|上|改|删|做|合|修|保留|上线|发布|实施|推进|切|换|回滚|启用|关闭|执行)(?![^，,。；;]{0,6}(?:的(?!方案|做法|版本|思路|路线|改法|来)|是)))/iu;
const commitsInWords = (clause: string): boolean =>
  ACTS_IN_WORDS.test(clause) || DECISION_WORDS.test(clause) || APPROVES_OPTION.test(clause) || TAKES_IN_WORDS.test(clause) ||
  TAKES_OUTRIGHT.test(clause) || PUTS_OFF.test(clause) || commitsByDescription(clause);
/** "…works for me locally, no changes needed": after an evaluation, keeping things as they are. */
const NO_CHANGE = /^(?:(?:so|and)\s+)?(?:(?:暂时|先)?(?:维持|保持)现状|don'?t change (?:anything|it)|no changes? (?:are )?(?:needed|required)|nothing (?:needs )?to change)$/iu;
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

/** `方案 A：…`, `Option B.`, `选项 1、…`: the word in front is not the name. */
const OPTION_WORD = /^(?:方案|选项|option)\s*(?=[A-Za-z0-9](?![A-Za-z0-9]))/iu;
/** `A（SQLite）：…`: the name sits in brackets right after the marker. */
const BRACKETED_NAME =
  /^([0-9]{1,2}|[A-Za-z])\s*[（(]([^（）()]{1,80})[）)]\s*(?:[：:—–]+\s*)?(.*)$/u;
/** Where a name ends and its description starts: `：`, `:`, or a set-off dash. */
const NAME_SEPARATOR = /^(.{1,500}?)(?:\s*[：:]|\s+[—–-]{1,2}\s+|\s*——\s*)\s*(.+)$/u;

/**
 * The line an option is written on, without what only dresses it up: the
 * emphasis around `**A. SQLite**`, a heading's `#`, the first cell of a table
 * row `| A. Redux | … |`, and the word 方案/Option in front of its letter.
 */
const optionText = (line: string): string => {
  let text = withoutEmphasis(line).trim();
  if (text.startsWith("|")) {
    const cells = /^\|[\s:|-]*$/u.test(text) ? [] : text.split("|").map((cell) => cell.trim().replace(NUMBER_WITH_LETTER, (whole, number: string, letter: string) => pairedLetter(number, letter) ?? whole));
    // `| 1 | A | 蓝绿发布 |`、`| ID 17 | A | SQLite |`: a number or code and a letter
    // both mark the row; the letter is its id.
    const letter = pairedLetter(cells[1] ?? "", cells[2] ?? "") ??
      (/^[A-Za-z]{1,3}\s?-?[0-9]{1,3}$/u.test(cells[1] ?? "") && /^[A-H]$/u.test(cells[2] ?? "") ? cells[2] ?? null : null);
    // `| A | 蓝绿发布 |`、`| T1 | 加追踪 |`: a first cell that is only a marker names the row by the next one.
    text = letter !== null && (cells[3] ?? "").length > 0
      ? `${letter}：${cells[3]}`
      : (/^(?:[0-9]{1,2}|[A-Za-z])$/u.test(cells[1] ?? "") || TABLE_ID.test(cells[1] ?? "")) && (cells[2] ?? "").length > 0
        ? `${cells[1]}：${cells[2]}`
        : cells[1] ?? "";
  }
  return text
    .replace(/^#{1,6}\s+/u, "")
    // `1 / A：…`、`| 1 / A | … |`: the number and its letter written together.
    .replace(NUMBER_WITH_LETTER, (whole, number: string, letter: string) => pairedLetter(number, letter) ?? whole)
    // `1）`、`①`、`一、`、`方案一：` are numbered as `1、` is.
    .replace(/^([0-9]{1,2})）\s*/u, "$1、")
    .replace(/^([①-⑧])\s*/u, (_mark, circled: string) => `${circled.charCodeAt(0) - 0x245f}、`)
    .replace(/^(?:(?:方案|选项)\s*([一二三四五六七八])\s*[：:、.]|([一二三四五六七八])、)\s*/u, (_mark, named?: string, bare?: string) => `${CHINESE_ORDINAL.indexOf(named ?? bare ?? "") + 1}、`)
    .replace(OPTION_WORD, "");
};

const CHINESE_ORDINAL = "一二三四五六七八";
/**
 * The number a row was written with beside its letter (`2. B — …`、`| 4 | D |`),
 * so "4" still names D. Only rows that carried both get one: in a plain lettered
 * list "Run 4 workers" names nothing. Kept off the option itself, whose shape is
 * fixed; an option read back from storage simply has none, as on rules-v8.
 */
const PAIRED_NUMBER = new WeakMap<CapturedOption, number>();
/** `1 / A`: a number and its letter written together. */
const NUMBER_WITH_LETTER = /^([0-9]{1,2})\s*[/／]\s*([A-H])(?![A-Za-z0-9])/u;
/** A row code in an ID column: T1、R-2、P03. */
const TABLE_ID = /^[A-Za-z]{1,3}-?[0-9]{1,3}$/u;
/** `1` beside `A`, `2` beside `B`: the letter the number stands for, if the two cells pair up. */
const pairedLetter = (first: string, second: string): string | null => {
  const [number, letter] = /^[0-9]{1,2}$/u.test(first) ? [first, second] : [second, first];
  return /^[0-9]{1,2}$/u.test(number) && /^[A-H]$/u.test(letter) && letter.charCodeAt(0) - 64 === Number(number) ? letter : null;
};
/** `1. A — 加超时`、`1. 方案 A：…`、`1：A 上传追踪`: the letter after a number, and where the name starts. */
const LETTER_AFTER_NUMBER = /^(?:(?:方案|选项|option)\s*)?([A-H])(?:[.)]\s+|[、:：]\s*|\s+[—–-]{1,2}\s+|\s*——\s*|\s+(?=[^a-z\s]))/u;

/** A line set apart as an item: bold at its start, a bullet, or a table row. */
const DRESSED_LINE = /^\s*(?:[-*]\s+|\*\*|__|\|)/u;

/** Strip prose asides, but keep English names a reply can use: 迁移 (migration). */
const nameWithoutAside = (label: string): string => {
  // `（推荐）` is the agent marking its own pick (recommendationFollow reads it), not an aside.
  if (/[（(]\s*推荐\s*[）)]\s*$/u.test(label)) return label;
  const bare = label.replace(/\s*[（(][^（）()]*[）)]\s*$/u, "").trim();
  return bare.length >= 2 && !/[（(][^（）()\p{Script=Han}]*[A-Za-z][^（）()\p{Script=Han}]*[）)]\s*$/u.test(label) ? bare : label;
};

/** The number written beside a row's letter, `| 2 | B |` or `2 / B`, if the two pair up. */
const pairedNumberOf = (line: string): number | undefined => {
  const text = withoutEmphasis(line).trim();
  const cells = text.startsWith("|") ? text.split("|").map((cell) => cell.trim()) : [];
  const pair = cells.length > 0
    ? (cells[1] ?? "").match(NUMBER_WITH_LETTER) ?? (pairedLetter(cells[1] ?? "", cells[2] ?? "") !== null ? [cells[1], cells[2]] : null)
    : text.replace(/^(?:[-*]\s+|#{1,6}\s+)/u, "").match(NUMBER_WITH_LETTER);
  const [first, second] = pair === null ? [] : pair.length === 3 ? [pair[1], pair[2]] : [pair[0], pair[1]];
  if (first === undefined || second === undefined || pairedLetter(first, second) === null) return undefined;
  return Number(/^[0-9]+$/u.test(first) ? first : second);
};

/** The option named by its id alone, keeping the number written beside its letter. */
const idOnly = (option: CapturedOption): CapturedOption => {
  const bare = { ...option, label: "" };
  const number = PAIRED_NUMBER.get(option);
  if (number !== undefined) PAIRED_NUMBER.set(bare, number);
  return bare;
};

/** Records the paired number, if any, on the option it belongs to. */
const withPairedNumber = (option: CapturedOption | null, number: number | undefined): CapturedOption | null => {
  if (option !== null && number !== undefined && option.id !== undefined && /^[A-H]$/u.test(option.id)) PAIRED_NUMBER.set(option, number);
  return option;
};

const optionFromLine = (line: string, index: number): CapturedOption | null => {
  const option = readOptionLine(line, index);
  return withPairedNumber(option.option, option.pairedNumber ?? pairedNumberOf(line));
};

const readOptionLine = (
  line: string,
  index: number,
): { option: CapturedOption | null; pairedNumber?: number | undefined } => {
  const text = optionText(line);
  const bracketed = text.match(BRACKETED_NAME);
  if (bracketed !== null) {
    const description = bracketed[3]?.trim();
    return { option: {
      id: bracketed[1] ?? String(index + 1),
      label: (bracketed[2] ?? "").trim().slice(0, 500),
      ...(description === undefined || description.length === 0
        ? {}
        : { description: description.slice(0, 2_000) }),
    } };
  }
  // `**A SQLite**`、`| A 线程池 |`: a capital and a space name an option only
  // on a line dressed as one; table cells also allow lowercase English names.
  // Outside tables, "A quick fix" is a sentence.
  const spaced = DRESSED_LINE.test(line)
    ? text.replace(/^[-*]\s+/u, "").match(
        line.trim().startsWith("|")
          ? /^([A-H])\s+(.+?)\s*$/u
          : /^([A-H])\s+(?=[^a-z\s])(.+?)\s*$/u,
      )
    : null;
  // A full-width delimiter takes no space after it, and neither does `A:`;
  // `1.` and `1)` need one, or "1.5x faster" would be option 1. `A — 重建索引`
  // names its option by the set-off dash.
  const coded = line.trim().startsWith("|") ? text.match(/^([A-Za-z]{1,3}-?[0-9]{1,3})：(.+?)\s*$/u) : null;
  const match = spaced ?? coded ?? text.match(
    /^(?:(\d+|[A-Za-z])(?:[.)]\s+|[、:：]\s*)|[-*]\s+)(.+?)\s*$/u,
  ) ?? text.match(/^([A-H]|[0-9]{1,2})\s+[—–]{1,2}\s+(.+?)\s*$/u);
  if (match === null) {
    return { option: null };
  }
  let identifier = match[1];
  // `**A** · Redux`, `**B** – Zustand`: the dot or dash only separates.
  // `- [ ] 更新 CHANGELOG`: the checkbox is no part of the name.
  let value = match[2]?.trim().replace(/^[·•–—-]+\s*/u, "").replace(/^\[[ xX]\]\s*/u, "") ?? "";
  if (identifier === undefined) {
    // `- A（补监控）：…`、`- **A（esbuild）**：…`: a bullet whose text starts with a
    // bracketed name is that option, as the same line without the bullet is.
    const bracketedItem = value.match(BRACKETED_NAME);
    if (bracketedItem !== null && /^[A-Za-z]$|^[0-9]{1,2}$/u.test(bracketedItem[1] ?? "")) {
      const description = bracketedItem[3]?.trim();
      return { option: {
        id: bracketedItem[1] ?? String(index + 1),
        label: (bracketedItem[2] ?? "").trim().slice(0, 500),
        ...(description === undefined || description.length === 0 ? {} : { description: description.slice(0, 2_000) }),
      } };
    }
    // A bullet whose text starts with its own marker: the letter is what the
    // reader will type back, so it has to be the id and not the label.
    const marked = value.match(BULLETED_MARKER);
    if (marked !== null) {
      identifier = marked[1];
      value = marked[2]?.trim() ?? "";
    }
  }
  // `1. A — 加超时`: the reader is answering by the letter, so the letter is the id.
  const lettered = identifier !== undefined && /^[0-9]{1,2}$/u.test(identifier) ? value.match(LETTER_AFTER_NUMBER) : null;
  let pairedNumber: number | undefined;
  if (lettered !== null && lettered?.[1] !== undefined && pairedLetter(identifier ?? "", lettered[1]) !== null) {
    pairedNumber = Number(identifier);
    identifier = lettered[1];
    value = value.slice(lettered[0].length).trim();
  }
  if (value.length === 0 || value.length > 2_000) {
    return { option: null };
  }
  const separator = value.match(NAME_SEPARATOR);
  const label = nameWithoutAside(separator?.[1]?.trim() ?? value);
  const description = separator?.[2]?.trim();
  return { option: {
    id: identifier ?? String(index + 1),
    label: label.slice(0, 500),
    ...(description === undefined
      ? {}
      : { description: description.slice(0, 2_000) }),
  }, pairedNumber };
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
const itemIsItsOwnQuestion = (value: string, taskChoices = false): boolean =>
  (INLINE_ALTERNATIVES.test(value) &&
    !CONCESSIVE_ALTERNATIVES.test(value)) ||
  // "Choose the timeout limit" can be an offered implementation step.
  EXPLICIT_CHOICE.test(!taskChoices || /\b(?:or|between|among|from)\b/iu.test(value) ? value : value.replace(/^\s*(?:choose|pick)\b/iu, "")) ||
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
/** "是否存在、是否冲突": a whether-clause the description reports, not asks. */
const EMBEDDED_WHETHER = /(?<=\S)是否/gu;

const taskChoices = (asked: string): boolean =>
  /(?:^|[.!?;,\n]\s*)(?:please\s+)?approve\b|\b(?:do|can|could|would) you approve\b|(?:请|麻烦|烦请|你|您)[^。！!？?\n已了]{0,8}批准/imu.test(asked) || (ASKS_TO_PICK.test(asked) && !asksItemByItem(asked, true));

const ACTION_ITEM = /^(?:add|remove|update|retry|log|run|apply|implement|keep|set|validate|check|record|use|send|return|handle|allow|reject|skip)\b/iu;

const listsQuestions = (options: CapturedOption[], asked = ""): boolean => {
  const asks = (option: CapturedOption): boolean =>
    (asksItemByItem(asked, true) && ENGLISH_INLINE_ALTERNATIVES.test(option.label) && !ACTION_ITEM.test(option.label)) ||
    itemIsItsOwnQuestion(option.label, taskChoices(asked) || (asksItemByItem(asked, true) && ACTION_ITEM.test(option.description ?? ""))) ||
    // "核对 .editorconfig 是否存在" in an option's description says what the
    // option does; a question mark there still makes it a question.
    itemIsItsOwnQuestion((option.description ?? "").replace(EMBEDDED_WHETHER, "").replace(new RegExp(ADVISES_ITSELF.source, "gu"), ""), taskChoices(asked));
  // Advice in a description alone ("…。推荐。") marks a question only when
  // every item carries a proposed answer; options often recommend one of their own.
  const advises = (option: CapturedOption): boolean => ADVISES_ITSELF.test(option.description ?? "");
  const asking = options.filter(asks).length;
  return asking >= 2 || (asking + options.filter((option) => !asks(option) && advises(option)).length >= 2 && options.every((option) => asks(option) || advises(option)));
};

const parseOptionBlock = (
  value: string,
  asked = value,
): ParsedOptionBlock | null => {
  // An option without a marker of its own is numbered among the options, not
  // among the lines: "请告诉我：" above "- 是" / "- 否" makes them 1 and 2.
  const options: CapturedOption[] = [];
  const lines = value.split(/\r?\n/u);
  // "**B. winston**" over "- 更灵活" / "- 性能弱": once items carry their own
  // letters or numbers, the plain bullets under them describe, not offer.
  const marked = lines.some((line) => ownMarker(line) !== null);
  for (const line of lines) {
    if (marked && ownMarker(line) === null) {
      continue;
    }
    const option = optionFromLine(line, options.length);
    if (option !== null && options.length < 8) {
      options.push(option);
    }
  }
  return options.length >= 2 && !listsQuestions(options, asked)
    ? { options, raw: value }
    : null;
};

/** "3 个文件"、"2 天": a number counting something is not option 3. */
const COUNTED = "(?!\\s*(?:个|次|天|周|条|行|人|分钟|小时|秒|%|倍|台|处|遍|files?\\b|tests?\\b|days?\\b|times?\\b|hours?\\b|minutes?\\b))";

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
): boolean =>
  options.some((option, index) => namesOption(value, option, index, false));

const escapeRegExp = (text: string): string =>
  text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

/**
 * A letter as the reply writes it: a capital standing alone. "a" in "go with
 * a managed Postgres" is the English article, and so is a capital A before
 * a lowercase word ("A merge now is risky"); only a reply that is nothing but
 * the letter may write it either way.
 */
/**
 * "A merge now" is the article; "A and C", "push A to next sprint" and "A
 * first" still name A: an article is never followed by these. "A is already in
 * the fixtures" stays as main reads it, a sentence about something, not a take.
 */
const ARTICLE_A =
  "(?!\\s+(?!(?:and|or|only|plus|to|for|until|till|after|before|now|today|tomorrow|later|first|next|never|please)\\b)[a-z])";
const letterPattern = (letter: string): string =>
  `(?<![A-Za-z0-9])${letter}(?![A-Za-z0-9])${letter === "A" ? ARTICLE_A : ""}`;

interface OptionReference {
  source: string;
  flags: string;
}

/**
 * The ways a reply names an option, each a pattern over the reply as
 * written: its letter (capitals only), its number (not counting anything),
 * any other id, and its label. With `alias`, an option numbered 1, 2, …, or
 * not numbered at all, is also named by its letter in the list: "B" for 2.
 */
const referencesTo = (
  option: CapturedOption,
  index: number,
  alias: boolean,
): OptionReference[] => {
  const references: OptionReference[] = [];
  const id = option.id;
  const lettered = id !== undefined && /^[A-Za-z]$/u.test(id);
  if (lettered) {
    references.push({ source: letterPattern(id.toUpperCase()), flags: "u" });
  } else if (id !== undefined && /^[0-9]+$/u.test(id)) {
    references.push({ source: `(?<![A-Za-z0-9])${id}(?![A-Za-z0-9])${COUNTED}`, flags: "u" });
  } else if (id !== undefined) {
    references.push({ source: `(?<![A-Za-z0-9])${escapeRegExp(id)}(?![A-Za-z0-9])`, flags: "iu" });
  }
  // `T1`、`T2` in an ID column are answered "A 和 C" by position just as 1, 2 are.
  if (alias && !lettered && (id === undefined || /^[0-9]+$/u.test(id) || TABLE_ID.test(id))) {
    references.push({ source: letterPattern(String.fromCharCode(65 + index)), flags: "u" });
  }
  // A list lettered A, B, C is answered "1 和 3" as often as "A 和 C"; a row
  // written "4. D" beside its letter is answered "4" wherever it sits.
  const number = lettered && id.toUpperCase().charCodeAt(0) - 65 === index ? index + 1 : PAIRED_NUMBER.get(option);
  if (alias && lettered && number !== undefined) {
    references.push({ source: `(?<![A-Za-z0-9])${number}(?![A-Za-z0-9])${COUNTED}`, flags: "u" });
  }
  // A one-character label would match almost any sentence by accident.
  if (option.label.length > 1) {
    references.push({ source: escapeRegExp(option.label), flags: "iu" });
  }
  return references;
};

const namesOption = (
  value: string,
  option: CapturedOption,
  index: number,
  alias: boolean,
): boolean => {
  const whole = value.trim().replace(/[。.!！]+$/u, "").trim().toUpperCase();
  const letter =
    option.id !== undefined && /^[A-Za-z]$/u.test(option.id)
      ? option.id.toUpperCase()
      : alias && (option.id === undefined || /^[0-9]+$/u.test(option.id) || TABLE_ID.test(option.id))
        ? String.fromCharCode(65 + index)
        : null;
  return (
    (letter !== null && whole === letter) ||
    referencesTo(option, index, alias).some((reference) =>
      new RegExp(reference.source, reference.flags).test(value),
    )
  );
};

/**
 * "先用 A" / "目前先用方案 B": a choice verb landing on exactly one option. The
 * option is taken whatever else the reply says — 之后再决定、目前 — while naming
 * every option on the way to "再决定" is weighing them. Options are also named
 * by their letter, since a list numbered 1, 2 is answered "B" as often as "2".
 */
const takesOneOption = (
  value: string,
  options: CapturedOption[],
): boolean => {
  const named = options.flatMap((option, index) =>
    namesOption(value, option, index, true) ? [{ option, index }] : [],
  );
  // "用了 2"、"用了 2 天" tell what happened, not what to do next.
  return (
    named.length === 1 &&
    referencesTo(named[0]!.option, named[0]!.index, true).some((reference) =>
      new RegExp(
        `(?:用|选|采用|走|按|定)择?\\s*(?:方案|选项)?\\s*(?:${reference.source})`,
        reference.flags,
      ).test(value),
    )
  );
};

/** Options pointed at by position: 第二个、the first and the third — not 第一时间、第一步. */
const ordinalPositions = (value: string): number[] =>
  [
    ...value.matchAll(/第\s*([一二三四五六七八九1-9])\s*(?=个|项|条|种|套|号|点|[和、，,与跟及。]|$)/gu),
    // "方案二"、"选项三": the options were written 方案一、方案二.
    ...value.matchAll(/(?:方案|选项)\s*([一二三四五六七八九])(?![一二三四五六七八九十])/gu),
    ...value.matchAll(new RegExp("\\b(?:items?|steps?|options?)\\s+(one|two|three|four|five)\\b" + COUNTED, "giu")),
    ...value.matchAll(new RegExp("\\b(?:items?|steps?|options?)\\s+(?:one|two|three|four|five)\\s+and\\s+(one|two|three|four|five)\\b" + COUNTED, "giu")),
    ...value.matchAll(/\b(?:the|and)\s+(first|second|third|fourth|fifth)\b(?=\s+(?:one|option|item|choice)\b|\s*(?:[,.]|and\b|$))/giu),
  ].map(
    (match) =>
      Number(match[1]) ||
      "一二三四五六七八九".indexOf(match[1] ?? "") + 1 ||
      ["first", "second", "third", "fourth", "fifth"].indexOf(match[1]?.toLowerCase() ?? "") + 1 ||
      ["one", "two", "three", "four", "five"].indexOf(match[1]?.toLowerCase() ?? "") + 1,
  );

const namesAnOption = (value: string, options: CapturedOption[]): boolean =>
  mentionsOption(value, options) ||
  ordinalPositions(value).some((position) => options[position - 1] !== undefined);

/** "1 和 3" / "B": a clause that is nothing but the options it names. */
const onlyNamesOptions = (clause: string, options: CapturedOption[], pieces: string[] = []): boolean => {
  let rest = clause.toLocaleLowerCase();
  const labelWords = new Set(
    options.flatMap((option) => option.label.toLocaleLowerCase().match(/[a-z][a-z0-9+#-]*/gu) ?? []),
  );
  for (const name of [...options.map((option) => option.label.toLocaleLowerCase()), ...pieces]) {
    if (name.length > 1) {
      rest = rest.split(name).join(" ");
    }
  }
  return (
    rest
      // "Add the index and the cache": the words of the labels themselves.
      .replace(/[a-z][a-z0-9+#-]*/gu, (word) => (FUNCTION_WORDS.has(word) || labelWords.has(word) ? " " : word))
      .replace(/\b(?:one|option|choice)\b/gu, " ")
      // "A and D please"、"1 和 3，谢谢"、"A now": courtesy and "now" take nothing away.
      .replace(/\b(?:please|pls|thanks|thank you|now|today)\b|谢谢|麻烦了/gu, " ")
      .replace(/(?:方案|选项)\s*[一二三四五六七八九]/gu, " ")
      .replace(/(?<=[0-9a-z]\s*)号/gu, " ")
      .replace(/第\s*[一二三四五六七八九1-9]\s*[个项条种]?|最后(?:一|1)?\s*[个项条种]|[前后]面?\s*[两二三四五六七八九2-9]\s*[个项条种点样]/gu, " ")
      .replace(/\b(?:the\s+)?(?:first|second|third|fourth|fifth|last|middle)(?:\s+(?:ones?|options?|items?|choices?|two|three))?\b/gu, " ")
      .replace(/中间(?:的|那)?(?:几|两)?\s*[个项条]/gu, " ")
      .replace(/(?<![a-z0-9])[a-z0-9](?![a-z0-9])/gu, " ")
      .replace(/(?:和|与|及|跟|\band\b)/gu, " ")
      .replace(/[\s、，,；;。.!！~〜～–—-]/gu, "").length <= 2
  );
};

/**
 * A reply that opens by acknowledging and then decides nothing: "收到，我先看下
 * 文档", "好的，明白了", "Got it, I'll take a look". What follows the
 * acknowledgement is what the caller judges for approval, refusal or a taken
 * option; this adds the one thing those miss, a reply that goes on to the very
 * act the question asked about ("要提交吗？" → "收到，马上提交").
 */
const acknowledgesWithoutDeciding = (
  answer: string,
  requestTokens: Set<string>,
): boolean => {
  if (ACKNOWLEDGES_ONLY.test(answer)) {
    return true;
  }
  if (!ACKNOWLEDGEMENT_PREFIX.test(answer)) {
    return false;
  }
  const rest = answer.replace(ACKNOWLEDGEMENT_PREFIX, "");
  // Single letters ("I'll") are too common here to tie the reply to the question.
  const words = new Set([...tokens(rest)].filter((token) => token.length > 1));
  return !(
    intersects(requestTokens, words) &&
    !DEFERS_DECISION.test(rest) &&
    !ONLY_EVALUATES.test(rest) &&
    !ANSWER_IS_QUESTION.test(rest)
  );
};

/** A reply's clauses, split at commas, semicolons and sentence ends. */
const clausesOf = (value: string): string[] =>
  value
    .split(/(?<=[，,；;。.!！?？\n])/u)
    .map((clause) => clause.trim().replace(/[，,；;。.!！]+$/u, ""))
    .filter((clause) => clause.length > 0);

/** The letter or number a line names itself by, if it carries one: `A.`, `**2)**`, `- B：`. */
const ownMarker = (line: string): string | null => {
  // `- [ ] A. 移除请求正文`: the checkbox stands before the marker.
  const text = optionText(line).replace(/^[-*]\s+(?:\[[ xX]\]\s*)?/u, "");
  return (
    text.match(/^([0-9]{1,2}|[A-Za-z])(?:[.)]\s|[、:：（(]|\s*[（(])/u)?.[1] ??
    text.match(/^([A-H]|[0-9]{1,2})\s+[—–]{1,2}\s/u)?.[1] ??
    (line.trim().startsWith("|")
      ? text.match(/^([A-H])\s+/u)?.[1]
      : DRESSED_LINE.test(line) ? text.match(/^([A-H])\s+(?=[^a-z\s])/u)?.[1] : undefined) ??
    null
  );
};

const nextMarker = (marker: string): string =>
  /^[0-9]+$/u.test(marker)
    ? String(Number(marker) + 1)
    : String.fromCharCode(marker.charCodeAt(0) + 1);

const QUESTION_LINE = /^\s*(?:[-*•]|\d{1,2}[.)、]|[A-Ha-h][.)、])\s*[^\n]*[?？]/u;
const LIST_MARKER = /^\s*(?:[-*•]|\d{1,2}[.)、]|[A-Ha-h][.)、])\s*/u;
/** Points at an option written elsewhere: A、2、方案 B、第二个、这三项、which of — a capital, not the article "a". */
const REFERS_TO_OPTION =
  /(?<![A-Za-z0-9.])[A-H1-9](?![A-Za-z0-9.])|方案|选项|第[一二三四五六七八九1-9]|这[几两二三四五六七八九十]+(?:项|个|条|点)|上面|以上|\b(?:[Oo]ptions?|[Ww]hich of)\b/u;
/** A question that weighs its own answers or asks a fact: 摘要还是全文？、格式是哪几种？、CLI or GUI? */
const weighsItsOwn = (line: string): boolean =>
  (INLINE_ALTERNATIVES.test(line) && !CONCESSIVE_ALTERNATIVES.test(line)) ||
  ENGLISH_INLINE_ALTERNATIVES.test(line) || ASKS_WHICH.test(line) || /\bwhich\b/iu.test(line);
/**
 * The part of a request that can ask to pick from options written elsewhere.
 * In a list of questions — "1. 你批准我实施吗？ 2. 摘要还是完整内容？" — an item
 * that weighs its own answers is not about the plan steps above, so its 还是 is
 * no cue to pick from them. "- 联合索引：批准吗？" still asks item by item.
 */
const pickingPart = (text: string): string => {
  const lines = text.split(/\r?\n/u);
  if (lines.filter((line) => QUESTION_LINE.test(line)).length < 2) return text;
  return lines
    .filter((line) => {
      const item = line.replace(LIST_MARKER, "");
      return !QUESTION_LINE.test(line) || REFERS_TO_OPTION.test(item) || !weighsItsOwn(item);
    })
    .join("\n");
};

/** "1、2 还是 3"、"A/B/C"、"which"、"选": the reader is asked to pick by name. */
const ASKS_TO_PICK =
  /(?:哪|选|还是|怎么(?:处理|办|做)|如何(?:处理|选择)|which|choose|pick|how (?:should I|do you want)|(?:怎么|怎样|如何)(?:安排|取舍|排(?=序|优先级|期|班|顺序|[？?。]|$)|分配)|编号|number|这[几两二三四五六七八九十]+(?:项|个|条|点)|分别|\b(?:all|any|each) of (?:these|them)\b|(?<![A-Za-z0-9])[A-H1-9]\s*(?:[、,，/／]|或|还是|\bor\b)\s*[A-H1-9](?![A-Za-z0-9]))/iu;

/**
 * Options laid out one per paragraph — `**A. SQLite**` then a paragraph about
 * it, then `**B. PostgreSQL**` — never form a block of their own, and the
 * question usually comes after a recommendation as well. Every line that
 * names itself `A.`/`1.` is read in order and the last run that counts up
 * from A or 1 is the option set. Letters are options on their own; a numbered
 * run only when the reader is asked to pick, or a plan's steps would qualify.
 */
const optionsAcrossParagraphs = (
  blocks: string[],
  asked: string,
): CapturedOption[] | null => {
  const pickCue = ASKS_TO_PICK.test(pickingPart(asked)) || asksItemByItem(pickingPart(asked), true);
  // Table rows count only when the reader is asked to pick, as in `pickable`.
  // "**C 过期提醒**：…。哪些这周批准？": the last option shares its paragraph with
  // the question; what is left once the closing question is cut off is the option.
  const closing = blocks.at(-1)?.split(/\r?\n/u)[0] ?? "";
  const asks = Math.max(closing.lastIndexOf("?"), closing.lastIndexOf("？"));
  const lastItem = ownMarker(closing) !== null && asks === closing.trimEnd().length - 1
    ? closing.slice(0, Math.max(...["。", "！", "!", "；"].map((mark) => closing.lastIndexOf(mark, asks))) + 1)
    : "";
  const lines = [...blocks.slice(0, -1), ...(ownMarker(lastItem) !== null ? [lastItem] : [])]
    .flatMap((block) => block.split(/\r?\n/u))
    .filter((line) => pickCue || !line.trim().startsWith("|"));
  // Letters and numbers are counted apart: "A. SQLite / B. PostgreSQL" then
  // "选定之后的步骤：1. … 2. …" is a choice followed by what comes after it.
  const lastRun = (letters: boolean): string[] => {
    let run: string[] = [];
    let last: string[] = [];
    let expected: string | null = null;
    for (const line of lines) {
      const marker = ownMarker(line);
      if (marker === null || /^[A-Za-z]$/u.test(marker) !== letters) {
        continue;
      }
      if (expected !== null && marker.toUpperCase() === expected.toUpperCase()) {
        run.push(line);
      } else if (/^(?:[Aa]|1)$/u.test(marker)) {
        run = [line];
      } else {
        run = [];
      }
      expected = run.length > 0 ? nextMarker(marker) : null;
      if (run.length >= 2) {
        last = [...run];
      }
    }
    return last;
  };
  // A lettered set is options on its own and wins over numbered steps; a
  // numbered run only counts when the reader is asked to pick.
  const lettered = lastRun(true);
  const last =
    lettered.length >= 2 ? lettered : pickCue ? lastRun(false) : [];
  if (last.length < 2) {
    return null;
  }
  const options = last
    .slice(0, 8)
    .map((line, index) => optionFromLine(line, index))
    .filter((option): option is CapturedOption => option !== null);
  return options.length >= 2 && !listsQuestions(options, asked) ? options : null;
};

/**
 * A comparison table with the options as its columns: `| 维度 | A：线程池 |
 * B：异步 IO | C：多进程 |` over `|---|`. Only a header whose cells after the
 * first all carry letters running from A counts — a table of numbers or of
 * plain column names compares nothing the reader is asked to pick.
 */
const optionsAsTableColumns = (blocks: string[]): CapturedOption[] | null => {
  const lines = blocks.flatMap((block) => block.split(/\r?\n/u));
  for (let index = lines.length - 2; index >= 0; index -= 1) {
    const header = lines[index]?.trim() ?? "";
    if (!header.startsWith("|") || !/^\|[\s:|-]*-[\s:|-]*$/u.test(lines[index + 1]?.trim() ?? "")) {
      continue;
    }
    const cells = header.split("|").map((cell) => cell.trim()).slice(2).filter((cell) => cell.length > 0);
    const options = cells.map((cell, at) => {
      const option = optionFromLine(`| ${cell} |`, at);
      return option?.id?.toUpperCase() === String.fromCharCode(65 + at) && option.label.length > 0 ? option : null;
    });
    if (options.length >= 2 && options.every((option) => option !== null)) {
      return (options as CapturedOption[]).slice(0, 8);
    }
  }
  return null;
};

/**
 * A comparison table that names its options down the first column: `| 方案 |
 * 优点 | 缺点 |` over `| RabbitMQ | … |`. The header's first cell has to say
 * the rows are options; a table of tasks or files names nothing to pick.
 */
const OPTION_COLUMN = /^(?:(?:方案|选项|候选|备选|选型)(?:名称|名)?|options?|approach(?:es)?|choices?|candidates?|alternatives?)$/iu;
const optionsAsTableRows = (blocks: string[]): CapturedOption[] | null => {
  // The last block too: a table and its question are often written without a blank line.
  for (const block of [...blocks].reverse()) {
    const lines = block.split(/\r?\n/u).map((line) => line.trim());
    const at = lines.findIndex((line, index) =>
      line.startsWith("|") && /^\|[\s:|-]*-[\s:|-]*$/u.test(lines[index + 1] ?? ""));
    const header = lines[at]?.split("|").map((cell) => withoutEmphasis(cell).trim()) ?? [];
    if (at < 0 || !OPTION_COLUMN.test(header[1] ?? "")) continue;
    const labels = lines.slice(at + 2).filter((line) => line.startsWith("|"))
      .map((line) => withoutEmphasis(line.split("|")[1] ?? "").trim());
    if (labels.length < 2 || labels.length > 8 || labels.some((label) => label.length === 0 || label.length > 60)) return null;
    return labels.map((label, index) => ({ id: String(index + 1), label }));
  }
  return null;
};

/** Headings a report is written under: **改动摘要**、**测试情况**、**Risks**. */
const REPORT_HEADING =
  /^(?:(?:改动|变更|测试|风险|结果|说明|总结|背景|结论|摘要|现状|问题|建议|分析|原因|影响|计划|下一步|已完成|待办|阻塞)(?:摘要|情况|结果|说明|总结|清单|要点|点|项)?|(?:summary|tests?|testing|risks?|changes?|notes?|open|current|next)(?:\s+\w+){0,3})\s*[：:]?$/iu;
/** A paragraph opened by a line that is nothing but a bold name: `**合并重复组件**`. */
const BOLD_TITLE = /^\s*(\*\*|__)([^*_\n:：?？]{1,40})\1\s*$/u;

/**
 * Options written as bold titles without letters or numbers, each over a
 * paragraph about it, when the reader is asked to pick. The titles have to sit
 * close together (at most two paragraphs between them) and close to the
 * question, or a report's section headings would qualify.
 */
const optionsAsBoldTitles = (blocks: string[], asked: string): CapturedOption[] | null => {
  // "现在合并还是等 CI？" names its own alternatives; the titles above report.
  // "哪些要做…还是都一起处理？" still picks among them.
  if (
    (!ASKS_TO_PICK.test(asked) && !asksItemByItem(asked, true)) ||
    ((INLINE_ALTERNATIVES.test(asked) || ENGLISH_INLINE_ALTERNATIVES.test(asked)) &&
      !ASKS_WHICH.test(asked) &&
      !/\bwhich\b/iu.test(asked))
  ) {
    return null;
  }
  const last = blocks.length - 1;
  const titles: number[] = [];
  for (let index = last - 1; index >= 0; index -= 1) {
    const title = blocks[index]?.split(/\r?\n/u)[0] ?? "";
    const isTitle = BOLD_TITLE.test(title) && !REPORT_HEADING.test(title.match(BOLD_TITLE)?.[2] ?? "");
    const gap = (titles.at(-1) ?? last) - index;
    if (isTitle && gap <= (titles.length === 0 ? 4 : 3)) {
      titles.push(index);
    } else if (gap > 3) {
      break;
    }
  }
  if (titles.length < 2 || titles.length > 8) {
    return null;
  }
  const options = titles.reverse().map((index, at) => {
    const [title, ...rest] = (blocks[index] ?? "").split(/\r?\n/u);
    const description = (rest.join("\n").trim() || (BOLD_TITLE.test(blocks[index + 1] ?? "") ? "" : blocks[index + 1] ?? "")).trim();
    return {
      id: String(at + 1),
      label: title?.match(BOLD_TITLE)?.[2]?.trim() ?? "",
      ...(description.length === 0 ? {} : { description: description.slice(0, 2_000) }),
    };
  });
  return listsQuestions(options, asked) ? null : options;
};

const singleProposedAction = (text: string, asked: string): CapturedOption[] | null => {
  if (!/(?:你|请)[^。\n]{0,20}(?:批准|确认)[^。\n]{0,8}范围/u.test(asked)) return null;
  const action = text.match(/只做一个[^：:。\n]{0,16}[：:]\s*([^；;。\n]+)/u)?.[1]?.trim();
  return action ? [{ id: "1", label: action.slice(0, 500) }] : null;
};

/**
 * Options named in passing — "A（YAML）还是 B（TOML）", "推荐 TOML(B)",
 * "A（Redux）/ B（Zustand）". Each letter keeps the first name it is given,
 * and the letters have to run from A without a gap, or a stray "(B)" in a
 * sentence would make an option set of one.
 */
const optionsNamedInPassing = (text: string): CapturedOption[] | null => {
  const names = new Map<string, string>();
  for (const match of text.matchAll(
    /(?<![A-Za-z0-9])([A-H])\s*[（(]([^（）()\n]{1,40})[）)]|([^\s，,。、:：；;（()*）]{2,40})\s*[（(]([A-H])[）)]/gu,
  )) {
    const letter = match[1] ?? match[4];
    const name = (match[2] ?? match[3] ?? "").replace(/^[*_]+|[*_]+$/gu, "").trim();
    // "接口（A）和接口（B）": a name cannot start on the word joining it to the last.
    if (letter !== undefined && name.length > 0 && !/^[和与或及]/u.test(name) && !names.has(letter)) {
      names.set(letter, name);
    }
  }
  const options: CapturedOption[] = [];
  for (let code = 65; names.has(String.fromCharCode(code)); code += 1) {
    const id = String.fromCharCode(code);
    options.push({ id, label: names.get(id) ?? id });
  }
  return options.length >= 2 ? options.slice(0, 8) : null;
};

/**
 * Options written as nothing but their letters: "A、B、C 请批准哪些？", or
 * "A、B、C" over "请回复批准哪些。" The run has to start at A and count up.
 */
const optionsAsBareLetters = (text: string): CapturedOption[] | null => {
  const run = text.match(/(?<![A-Za-z0-9])A(?:\s*[、,，/／]\s*[B-H]){1,7}(?![A-Za-z0-9])/u)?.[0] ?? "";
  const letters = run.match(/[A-H]/gu) ?? [];
  return letters.length >= 2 && letters.every((letter, at) => letter.charCodeAt(0) === 65 + at)
    ? letters.map((letter) => ({ id: letter, label: letter }))
    : null;
};

/** What a reply does to one option: takes it, turns it down, puts it off, or only talks about it. */
export type OptionVerdict = "selected" | "refused" | "deferred" | "mentioned";

export interface ReplyReading {
  /** One per option, in the options' order; null where the reply never names it. */
  verdicts: (OptionVerdict | null)[];
  /** The options taken, in the order the reply names them. */
  selected: CapturedOption[];
}

/** "B is better than A" / "2 比 1 好": a preference for the first, the second only compared against. */
const BETTER_THAN = /\b((?:is|'s)\s+(?:much\s+|a lot\s+|way\s+)?better)\s+than\s+(?:option\s+)?[A-Za-z0-9](?![A-Za-z0-9])(?=\s*(?:$|[.;!]|,(?!\s*(?:right|no|yes|correct|isn'?t it|don'?t you think|agreed)\s*\??\s*$)))|(?<!(?:不|没|未必|不见得|哪|难道)\s*)比\s*(?:方案|选项)?\s*[A-Za-z0-9](?![A-Za-z0-9])\s*(?:更|还)?(?=(?:好|合适)(?:一些|一点|点)?\s*(?:$|[，,。.!！；;吧]))/giu;
/** 不要、跳过、skip、reject: the option is turned down. 别的 is "the others", not 别. */
const REFUSES =
  /(?:不要|不做|不用|不需要|不必|不批|不选|不采用|别(?!的|人)|跳过|算了|否决|拒绝|去掉|删掉|不动|别动|\b(?:unchanged|as it is|as they are|stays out)\b|\b(?:none|neither|never)\b|\bskip\b|\bdrop\b|\breject\b|\bnot\b|\bno\b|\bdon'?t\b)/iu;
/** 先不、暂缓、再评估、later: the option is put off, not taken. */
const PUTS_OFF =
  /(?:先不|暂不|暂时不|暂缓|延后|推迟|缓一缓|先放|放一放|搁置|回头|以后|稍后|下(?:次|周|个?月|个?(?:版本|迭代|阶段|sprint))|再(?:说|议|看|评估|决定|定|考虑|讨论|商量)|评估一下|\blater\b|postpone|defer|revisit|\bhold\b|\bpark\b|\bwait\b|not now|next (?:time|week|sprint|release|iteration))/iu;
/** A take that waits on a condition: only if、as long as (not "as long as possible")、只有在…前提下. "unless" approves with an exception. */
const CONDITIONAL_TAKE = /\bonly if\b|\bprovided(?: that)?\b|\bas long as\b(?!\s+(?:possible|needed|necessary|it takes|(?:we|you) can(?=\s*(?:[.,;!]|$))))|只有在|(?:的)?前提下/iu;
/** 已经发布了、正在运行、was used: how things went, not what to do. */
const TELLS_WHAT_HAPPENED =
  /(?:^(?:当前)?(?:进度|完成度|完成情况|测试结果|构建结果)\s*[:：]?|^(?:progress|completion|status)\s*:|\b(?:checks?|tests?|builds?)\s+(?:finished|passed|failed|completed)\b|^no (?:work|tasks?|items?|steps?) (?:remains?|is left)\b|^(?:(?:the )?(?:steps?|items?|options?|tasks?)\s+)?(?:[0-9]+|one|two|three|four|five|first|second|third)(?:\s+(?:item|step|option|task))?\s+(?:(?:is|was|has been)\s+)?not (?:found|present|available)\b|^(?:still )?(?:waiting|pending)\b|已经|刚(?:刚)?(?:做|改|加|删|合|跑|测|用|修|提交|合并)|正在|还在|仍在|已(?:做|完成|上线|发布|切|合并)|做完|(?<!把[^，,。；;]{0,12})做了(?!吧)|没做|完成了|通过了|(?:还剩|剩余|剩下)\s*[0-9一两二三四五六七八九]|(?<!把[^，,。；;]{0,12})(?:改|加|删|合|跑|测|用|修|提交|合并)(?:了(?!就行|再|然后|之后|接着)|完了|好了)(?!吧)|\balready\b|\bwas\b|\bwere\b|(?:跑|做|改|迁移?)到一半|(?:剩下|剩余)的?(?:明天|下周|之后|稍后|回头)(?:再)?(?:继续|做|弄)|\b(?:halfway|so far|last sprint)\b|\bhas been in use\b|\bsince last (?:year|month|week)\b|\b(?:since|after) (?:the )?(?:deploy(?:ment)?|release|rollout|merge|upgrade|migration)\b|\b[0-9]+\s+(?:of|out of)\s+[0-9]+\b|\b(?:we(?:'re| are)|I(?:'m| am)) seeing\b|\b(?:is|are|was|were|at)\s+(?:around\s+|about\s+|roughly\s+)?[0-9]+(?:\.[0-9]+)?\s*%|\b(?:have|has)(?:n't| not)? (?:passed|failed|finished|completed|merged)\b|^(?:(?:steps?|items?|tasks?)\s+)?(?:none|neither|all|anything|everything|\d+|one|two|three|four|five)\b[^,.!?;\n]{0,40}\b(?:passed|failed|completed|finished|ran|done|complete|(?:is|are) (?:already |still )?(?:complete|done|pending))\b)/iu;
const IMPERATIVE_END = /(?:删了|(?:做|用|合|跑|测|改|删)了吧)$/u;
/** An act of its own in a follow-up clause: 上线、合并、发布、deploy. */
const OTHER_ACT = /(?:上线|发布|发版|合并|部署|提交|推送|迁移|重构|\bmerge\b|\bdeploy\b|\brelease\b|\bship\b|\bpush\b)/iu;
/** 就选、采用、go with: a take that overrides what an earlier clause said. */
const TAKES_OUTRIGHT = /(?:就(?:选|用|按|定)|采用|选定|决定(?:用|选)|\bgo with\b|\blet'?s (?:go with|use)\b)/iu;
/** "A rename would do": what might work, not what to do. */
const HYPOTHETICAL = /\b(?:would|could|might)\b/iu;
/** 我自己来、I'll do it myself: the reader takes the item off the assistant's list. */
const LEAVES_IT_TO_ME =
  /(?:我自己(?:来|做|弄|处理|搞)|我来(?:做|弄|处理|搞)|\bmyself\b|leave (?:it|that|those|them) to me)/iu;
/** 批准、可以、没问题、yes: a word that takes the option it follows. */
const APPROVES_OPTION =
  /(?:批准|同意|通过|选(?:择|定)|可以|没问题|(?<!不)行|只|仅|你来|交给你|把[^，,。；;]{1,12}(?:做|改|加|删|上|弄|合|修)(?:了|掉|好)|\bapply\b|\bimplement\b|\bonly\b|\bfor now\b|ok(?:ay)?\b|\byes\b|approved?\b|go ahead|\bfine\b|sounds good|\bworks? for me\b(?!\s+in\b)|\bis my choice\b|\bship\b)/iu;
/** 除了 2、all but 2、except the migration: what follows is everything else. */
const EXCLUDES =
  /(?:除了?|以外|之外|排除|\bexcept(?:ing)?\b|\bexclud(?:e|ing)\b|\ball but\b|\b(?:everything|anything) but\b|other than|apart from)/iu;
/** 其余、其他都、the rest: the options the reply did not name elsewhere. */
const THE_REST =
  /(?:^(?:直接)?(?:否决|拒绝)(?:全部|所有)|其他|其它|其余|剩下|剩余|别的|^(?:(?:一|[二两三四五六七八九]|几)个都|全部|全都|都)|^(?:none(?: of (?:them|these|those|the above)(?: (?:options|choices))?)?|neither)$|\bthe rest\b|\bthe others\b|\beverything else\b|\ball (?:the )?others\b)/iu;
/** "帮我…"、"请实施导出预览" name an option by its label while asking for work. */
const ASKS_FOR_WORK = /^(?:帮我|请(?:你)?(?:帮|实施|执行|实现)|help me|can you|could you)/iu;

/** Words labels share without telling options apart. */
const GENERIC_PIECES = new Set(["方案", "选项", "这个", "那个", "建议", "我们", "可以", "需要", "进行", "一个", "option", "approach"]);

/**
 * Pieces of a label that name that option and no other: "托管" for 托管
 * PostgreSQL beside 自建 PostgreSQL. What the labels share is cut out first;
 * of what is left, split at 的/和, a Chinese segment counts whole, by its first
 * characters or by its last (高可用集群: 高可用、集群), never by a stretch in
 * its middle, and
 * an English label by its first or last word of its own. Anywhere inside a
 * label is too loose: 本地 would name 本地缓存 in "本地跑一下测试".
 */
const uniquePieces = (options: CapturedOption[]): string[][] => {
  const labels = options.map((option) => option.label.toLocaleLowerCase());
  return labels.map((label, index) => {
    const others = labels.filter((_other, at) => at !== index);
    const shared = Array.from(label, () => false);
    for (const run of label.matchAll(/\p{Script=Han}{2,}/gu)) {
      const text = run[0];
      for (let length = text.length; length >= 2; length -= 1) {
        for (let at = 0; at + length <= text.length; at += 1) {
          if (others.some((other) => other.includes(text.slice(at, at + length)))) {
            for (let k = 0; k < length; k += 1) shared[(run.index ?? 0) + at + k] = true;
          }
        }
      }
    }
    const pieces = new Set<string>();
    // 的、和 join words: "增加异常输入的校验信息" is 增加异常输入 and 校验信息.
    const own = Array.from(label, (char, at) => (shared[at] || /[的和与及]/u.test(char) ? " " : char)).join("");
    for (const segment of own.match(/\p{Script=Han}{2,}/gu) ?? []) {
      for (let length = 2; length <= Math.min(segment.length, 8); length += 1) {
        pieces.add(segment.slice(0, length));
        pieces.add(segment.slice(-length));
      }
    }
    const words = (label.match(/[a-z][a-z0-9+#-]{2,}/gu) ?? []).filter(
      (word) =>
        !FUNCTION_WORDS.has(word) &&
        !others.some((other) => new RegExp(`(?<![a-z0-9])${escapeRegExp(word)}(?![a-z0-9])`, "u").test(other)),
    );
    // A literal parenthetical name such as Redis (v7) can distinguish equal base names.
    for (const alias of label.matchAll(/[（(]([a-z][a-z0-9+#-]{1,30})[）)]/gu)) pieces.add(alias[1]!);
    for (const word of [words[0], words.at(-1)]) {
      if (word !== undefined) pieces.add(word);
    }
    return [...pieces]
      // "处理" in 处理技术债 is the act asked about, not the option's name.
      .filter(
        (piece) =>
          !GENERIC_PIECES.has(piece) &&
          !DECISION_WORDS.test(piece) &&
          !APPROVES_OPTION.test(piece) &&
          !PUTS_OFF.test(piece) &&
          !others.some((other) => other.includes(piece)),
      )
      .sort((left, right) => right.length - left.length);
  });
};

/**
 * A name followed straight by another act or a predicate: "本地跑一下测试",
 * "the table is fine as is". The clause is about something done there or
 * about how it is, not about taking the option.
 */
const NAME_THEN_OTHER_ACT =
  /^(?:\s*(?:的|那个|那套|这个|那块|那边|里)?\s*(?:跑|搭|改|写|测|看|查|装|部署|配|建|试|弄|搞|调)|\s+(?:is|are|was|were|looks?|seems?)\b)/iu;
const nameThenOtherAct = (clause: string, name: string): boolean => {
  const lower = clause.toLocaleLowerCase();
  const at = lower.indexOf(name);
  return at >= 0 && NAME_THEN_OTHER_ACT.test(lower.slice(at + name.length));
};

const containsPiece = (clause: string, piece: string): boolean =>
  /^[a-z]/u.test(piece)
    ? new RegExp(`(?<![a-z0-9])${escapeRegExp(piece)}(?![a-z0-9])`, "iu").test(clause)
    : clause.toLocaleLowerCase().includes(piece);

const CHINESE_COUNT = "一两二三四五六七八九";
const countOf = (value: string): number =>
  /^[0-9]+$/u.test(value)
    ? Number(value)
    : ({ two: 2, three: 3, four: 4, five: 5 } as Record<string, number>)[value.toLowerCase()] ??
      Math.max(1, CHINESE_COUNT.indexOf(value)) + (CHINESE_COUNT.indexOf(value) >= 2 ? 0 : 1);

/**
 * Options pointed at as a run: 1-3、1～3、A 到 C、前两个、后两项、the first two.
 * Positions are 1-based; a reference that is an option's id counts as that option.
 */
const rangePositions = (clause: string, options: CapturedOption[]): number[] => {
  const position = (reference: string): number => {
    const byId = options.findIndex((option) => option.id?.toUpperCase() === reference.toUpperCase());
    return byId >= 0 ? byId + 1 : /^[A-Za-z]$/u.test(reference) ? reference.toUpperCase().charCodeAt(0) - 64 : Number(reference);
  };
  const positions: number[] = [];
  const span = (from: number, to: number): void => {
    for (let at = from; at <= to && to - from < 8; at += 1) {
      positions.push(at);
    }
  };
  for (const match of clause.matchAll(
    new RegExp(`(?<![A-Za-z0-9])([0-9]{1,2}|[A-H])\\s*(?:-|~|〜|～|到|至|–|—)\\s*([0-9]{1,2}|[A-H])(?![A-Za-z0-9])${COUNTED}`, "gu"),
  )) {
    const [from, to] = [match[1] ?? "", match[2] ?? ""];
    if (/^[0-9]+$/u.test(from) === /^[0-9]+$/u.test(to) && position(from) < position(to)) {
      span(position(from), position(to));
    }
  }
  if (/最后(?:一|1)?\s*(?:个|项|条|种)|\b(?:the\s+)?last\s+(?:one|option|item|choice)\b/iu.test(clause)) {
    span(options.length, options.length);
  }
  if (/中间(?:的|那)?(?:几|两)?\s*(?:个|项|条)|\b(?:the\s+)?middle\s+(?:ones?|options?|items?|two)\b/iu.test(clause)) {
    span(2, options.length - 1);
  }
  for (const match of clause.matchAll(/([前后])面?\s*([两二三四五六七八九2-9])\s*(?:个|项|条|种|点|样)/gu)) {
    const count = countOf(match[2] ?? "");
    if (match[1] === "前") span(1, count);
    else span(Math.max(1, options.length - count + 1), options.length);
  }
  for (const match of clause.matchAll(/\b(?:the\s+)?(first|last|top)\s+(two|three|four|five|[2-5])\b/giu)) {
    const count = countOf(match[2] ?? "");
    if (match[1]?.toLowerCase() === "last") span(Math.max(1, options.length - count + 1), options.length);
    else span(1, count);
  }
  return positions;
};

/** A commitment by description is still a decision when its target cannot safely be mapped. */
const commitsByDescription = (clause: string): boolean =>
  !ANSWER_IS_QUESTION.test(clause) && !DEFERS_DECISION.test(clause) &&
  /^(?:(?:我)?(?:就)?(?:按|用|采用).{1,30}(?:那[个种套]|方案)(?:.{0,12}(?:来|做吧?|执行))?$|照(?:这|那)个执行吧?$)/u.test(clause);

const describedOption = (clause: string, options: CapturedOption[]): number | null => {
  if (!commitsByDescription(clause)) return null;
  const description = clause.replace(/^(?:我)?(?:就)?(?:按|用|采用)(?:你说的)?(?:那[个种套])?/u, "")
    .replace(/(?:的)?(?:那[个种套])?(?:方案)?(?:来|做吧?|执行)?$/u, "");
  if (!/^\p{Script=Han}{1,12}$/u.test(description)) return null;
  const matched = options.flatMap((option, index) => `${option.label} ${option.description ?? ""}`.includes(description) ? [index] : []);
  return matched.length === 1 ? matched[0]! : null;
};

/**
 * What one clause does to the options it names. Putting off comes first
 * (先不做 is not 不做), then everything that only talks about an option —
 * a question, weighing, how things are or were, an evaluation — then a
 * refusal, and last a take: a verb acting on the option, an approving word,
 * or nothing but the option's name.
 */
const onlyDiscusses = (clause: string): boolean =>
  READ_ONLY_REQUEST.test(clause) ||
  ANSWER_IS_QUESTION.test(clause) ||
  WEIGHS_OPTIONS.test(clause) ||
  DESCRIBES_CURRENT_STATE.test(clause) ||
  STILL_THINKING.test(clause) ||
  (TELLS_WHAT_HAPPENED.test(clause) && !(IMPERATIVE_END.test(clause) && !/(?:已经|刚|已)/u.test(clause))) ||
  HYPOTHETICAL.test(clause) ||
  ONLY_EVALUATES.test(clause);

/** 2、2 和 3: a run of numbers taken whole, so "2、3 都慢" is not read as "2" plus a tail. */
const NUMBER_RUN = "[1-9](?:\\s*[、和与及]\\s*[1-9])*(?!\\s*[、和与及]\\s*[1-9])";
const DECISION_END = "\\s*(?:$|[，,。.!！?？;；:：]|吧|了|就行|可以|好了|都(?:做|要|上|用|改|试试))";
const READ_ACT = "(?:选(?:择)?|用|按|采用|执行|批准|同意|合并|提交|上线|上|合|做)";
/**
 * A read followed by an act in the same sentence contains two intents. A
 * number splits off only before a decision boundary; after a verb, 的 only
 * before a name for the option (用 2 的方案), not 选 2 的坑多 or 用 2 的话.
 */
const READ_THEN_ACT = new RegExp(
  `(?:\\s+(?:and|then)\\s+|\\s+[—–-]\\s+)(?=(?:merge|apply|approve|use|ship|do|implement|run|go with)\\b)|` +
    `(?:下来|之后|以后|完了|完|后|然后|并且?|再|(?=\\s*就))(?:还是)?(?=\\s*就?\\s*(?:${READ_ACT}|${NUMBER_RUN}${DECISION_END}))` +
    `(?!\\s*就?\\s*${READ_ACT}\\s*${NUMBER_RUN}(?!${DECISION_END}|\\s*(?:的(?:方案|做法|版本|思路|路线|改法|来)|因为|由于|and\\b)))`,
  "iu",
);

const clauseStance = (clause: string, options: CapturedOption[], pieces: string[][], weighing = false): OptionVerdict => {
  if (READ_ONLY_REQUEST.test(clause)) return "mentioned";
  if (PUTS_OFF.test(clause) || DEFERS_DECISION.test(clause)) {
    return "deferred";
  }
  if (onlyDiscusses(clause)) return "mentioned";
  if (options.some(option => option.label.length > 1 && option.label.toLocaleLowerCase() === clause.toLocaleLowerCase())) return "selected";
  // "打 tag 我自己来": the reader keeps it, so the assistant is not to do it.
  if (REFUSES.test(clause) || LEAVES_IT_TO_ME.test(clause)) {
    return "refused";
  }
  return IMPERATIVE_END.test(clause) || DECISION_WORDS.test(clause) ||
    APPROVES_OPTION.test(clause) ||
    (!WEIGHS_A_TAKE.test(clause) && !NAMES_A_NOUN.test(clause) && (TAKES_IN_WORDS.test(clause) || (!weighing && PREFERS.test(clause)))) ||
    onlyNamesOptions(clause, options, pieces.flat())
    ? "selected"
    : "mentioned";
};

/**
 * The one reading of a reply against the options it answers: for each option,
 * whether the reply takes it, turns it down, puts it off or only mentions it.
 * Scoring and the recorded answer both come from here, so a reply recorded as
 * taking options is never scored as having decided nothing.
 *
 * "1 和 3 做，2 不做" takes 1 and 3; "除了 2 都做" and "All but 2" take every
 * option but 2; "1-3"、"前两个"、"the first two" take a run; "托管" takes the
 * one option whose label holds it. Options named by a clause take that
 * clause's verdict; options left to "其余"、"the rest" or to an exclusion take
 * theirs only where no clause named them.
 */
/** Handing the choice back: 你按…决定、你来定、由你选、up to you、your call — not "whichever option you choose". */
const HANDS_CHOICE_BACK =
  /(?:你(?:来)?(?:定|决定|挑|选)(?![的了过])|你按[^，,。；;]{0,20}(?:决定|定|选|挑)|由你(?:来)?(?:定|决定|选|挑)|你看着办|\bup to you\b|(?<!\bwh(?:ich|at)ever\b[^.,;!?]{0,20})\byou (?:decide|pick|choose)\b|\byour call\b)/iu;
/** Allowing without choosing: 都行、也可以、都可以、either is fine. */
const ONLY_ALLOWS = /(?:(?:都|也)(?:行|可以|好|没问题)|\b(?:either|both|any)(?: one)? (?:is|are|works?|would be) (?:fine|ok(?:ay)?)\b)/iu;
/** What is handed back is how or when, not which: 时间你定、顺序由你决定、the timing is up to you. */
const HANDS_BACK_A_DETAIL =
  /(?:时间|时机|日期|顺序|先后|节奏|排期|步骤|细节|方式|怎么做|\b(?:timing|time|date|order|schedule|details?|how)\b)/iu;

// "你按响应时间最短的决定" picks by a measure; only "时间你定" hands back a detail.
const handedBack = (clause: string): boolean =>
  HANDS_CHOICE_BACK.test(clause) && (!HANDS_BACK_A_DETAIL.test(clause) || /你按[^，,。；;]{0,20}(?:决定|定|选|挑)/u.test(clause));

const readReplyUnmarked = (reply: string, options: CapturedOption[]): ReplyReading => {
  // "都行，你按维护成本最低的决定": the reader leaves the pick to the assistant,
  // so "都" takes nothing.
  // "B 也行，具体你来定"、"A 和 B 都可以，你选一个就好" hand the pick back: what is
  // left after the hand-back and the "都行 / 也可以" that only allow is what was
  // chosen, so "我选 A，剩下的你按风险决定" still takes A. "都批准，具体部署时间由你决定"
  // only hands back when, and its approval stands.
  if (clausesOf(reply).some(handedBack)) {
    const chosen = clausesOf(reply).filter((clause) => !handedBack(clause) && !ONLY_ALLOWS.test(clause));
    return chosen.length === 0 ? { verdicts: options.map(() => null), selected: [] } : readReplyUnmarked(chosen.join("。"), options);
  }
  // "都行，不过这次直接做 A": allowing every option, then naming one, takes that one.
  const names = (clause: string): boolean => options.some((option, index) => namesOption(clause, option, index, true));
  if (clausesOf(reply).some((clause) => ONLY_ALLOWS.test(clause) && !names(clause)) &&
    clausesOf(reply).some((clause) => !ONLY_ALLOWS.test(clause) && names(clause))) {
    return readReplyUnmarked(clausesOf(reply).filter((clause) => !(ONLY_ALLOWS.test(clause) && !names(clause))).join("。"), options);
  }
  const answer = reply.replace(BETTER_THAN, (_match, better?: string) => better ?? "更");
  const verdicts: (OptionVerdict | null)[] = options.map(() => null);
  const order: number[] = [];
  const pieces = uniquePieces(options);
  // What "其余"、"the rest" or an exclusion leaves to the options no clause
  // named, and the clause it was said in.
  let rest: { verdict: OptionVerdict; at: number } | null = null;
  // "除了 2，其余暂缓": what 2 gets depends on what the rest gets.
  let excluded: number[] = [];
  let carried: OptionVerdict | null = null;
  let lastNamed: number[] = [];
  // Options taken only by a preference ("2 比 1 好"), which a reservation after
  // it ("先压测一下"、"let's measure first") puts off again.
  const preferred: number[] = [];
  // "先只做 1 和 2": nothing outside an "only" is taken.
  const only: number[] = [];
  const mentionedAt = new Map<number, number>();
  // A mention gives way to a verdict, and to "the rest" said before it:
  // "都做，尤其是 1 和 3" takes 1 and 3, "2 太慢，其他都做" leaves 2 out.
  const settle = (index: number, verdict: OptionVerdict, at: number, forTheRest = false): void => {
    const current = verdicts[index];
    if (
      current === null ||
      (current === "mentioned" && (!forTheRest || (mentionedAt.get(index) ?? -1) > at)) ||
      // "1 以后维护方便，就选 1": a plain take later on settles it.
      (verdict === "selected" && !forTheRest && (TAKES_OUTRIGHT.test(clauses[at] ?? "") || DEICTIC_APPROVAL_ANSWER.test(clauses[at] ?? ""))) ||
      // "1 和 3，不过 3 先跟 PM 确认": what is put off or turned down afterwards
      // is not taken, whatever an earlier clause said.
      (current === "selected" && !forTheRest && (verdict === "deferred" || verdict === "refused"))
    ) {
      verdicts[index] = verdict;
      if (verdict === "mentioned") mentionedAt.set(index, at);
      if (!order.includes(index)) order.push(index);
    }
  };
  const opposite = (verdict: OptionVerdict): OptionVerdict =>
    verdict === "selected" ? "refused" : "selected";
  // "Which of these: A and C only" — what follows a colon is a clause of its own.
  // Where each sentence starts: "Skip 2. 1 and 3" carries no verb over the full stop.
  const sentenceStarts = new Set<number>();
  const clauses = answer
    .normalize("NFKC")
    .split(/(?<=[。.!！?？])\s*/u)
    .flatMap((sentence) => {
      const parts = clausesOf(sentence);
      return parts.map((part, at) => (at === 0 ? `\u0000${part}` : part));
    })
    .flatMap((part) => part.split(/[:：]\s*/u))
    .flatMap((part) => part.split(/(?<=了)(?=再(?:说|看))/u))
    // "Let's do 1 and 3 now and revisit 2 later": the second verb is a clause of its own.
    .flatMap((part) => part.split(/\s+(?:and|but)\s+(?=(?:revisit|skip|leave|hold off|defer|drop|postpone|wait)\b)/iu))
    // A read followed by an act in the same sentence contains two intents.
    // Numeric targets split only at a decision boundary, not before an arbitrary tail.
    .flatMap(part => READ_ONLY_REQUEST.test(part.replace(/^\u0000/u, ""))
      ? part.split(READ_THEN_ACT)
      : [part])
    .filter((clause) => clause.replace(/^\u0000/u, "").length > 0)
    .map((clause, at) => {
      if (clause.startsWith("\u0000")) sentenceStarts.add(at);
      return clause.replace(/^\u0000/u, "");
    });
  // "2 is better for reads, 1 for writes" / "…on paper, but riskier": a preference
  // among several named options, or against a contrast, is still weighing them.
  const weighing = /(?:\bbut\b|\bhowever\b|\bthough\b|但|不过|可是)/iu.test(answer) ||
    options.filter((option, index) => namesOption(answer, idOnly(option), index, true)).length >= 2;
  const pickedById = options.map((option, index) => namesOption(answer, idOnly(option), index, true));
  const actsByWord = (clause: string): boolean =>
    DECISION_WORDS.test(clause) || APPROVES_OPTION.test(clause) || TAKES_IN_WORDS.test(clause) || PREFERS.test(clause);
  clauses.forEach((whole, at) => {
    if (sentenceStarts.has(at)) carried = null;
    // "Do 2 only if 1 passes review"、"C 只有在 A 做完的前提下才批准": the option
    // before the condition is put off until it holds; those inside it are the condition.
    const condition = whole.search(CONDITIONAL_TAKE);
    const clause = condition > 0 ? whole.slice(0, condition) : whole;
    const ranged = rangePositions(clause, options);
    const byId = options.map(
      (option, index) =>
        namesOption(clause, idOnly(option), index, true) ||
        ordinalPositions(clause).includes(index + 1) ||
        ranged.includes(index + 1),
    );
    // A whole name that is a common word ("建议") names nothing: "按建议来".
    const namesUsed = options.map((option, index) => [
      ...(option.label.length > 1 &&
      !GENERIC_PIECES.has(option.label.toLocaleLowerCase()) &&
      clause.toLocaleLowerCase().includes(option.label.toLocaleLowerCase())
        ? [option.label.toLocaleLowerCase()]
        : []),
      ...(pieces[index] ?? []).filter((piece) => containsPiece(clause, piece)),
    ]);
    const described = describedOption(clause, options);
    // "Switch to option 2" beside "3. Switch to SQLite": the shared verb names nothing.
    const byIdAny = byId.some(Boolean);
    // "选 B，每周批量归档" beside "C 手动归档": the reply picked B by its id, and this
    // clause names B; a stray piece of another label (归档) is B's act, not a second pick.
    // "选 B，重试和超时都做" joins two names: each is a pick of its own.
    const describesPicked = namesUsed.some((names, index) => pickedById[index] && names.length > 0) &&
      !/(?:和|与|及|跟|、|\band\b|&)/iu.test(clause);
    const byLabel = namesUsed.map((names, index) => described === index ||
      (names.some(name => !(byIdAny && /^(?:switch|move|keep|use|add|go|choose|select|pick|take|run|make|drop|skip|update|remove)$/iu.test(name))) &&
        (!describesPicked || pickedById[index] || byId[index] || names.includes(options[index]!.label.toLocaleLowerCase()))));
    const named = options.flatMap((_option, index) => (byId[index] || byLabel[index] ? [index] : []));
    let stance: OptionVerdict = condition > 0 ? "deferred" : described === null ? clauseStance(clause, options, pieces, weighing) : "selected";
    const next = clauses[at + 1] ?? "";
    const followingAct = /^(?:再说|再看)/u.test(next) ||
      ((DECISION_WORDS.test(next) || APPROVES_OPTION.test(next) || REFUSES.test(next) || IMPERATIVE_END.test(next)) &&
        ["selected", "refused"].includes(clauseStance(next, options, pieces, weighing)));
    // In one utterance, "1 合了，3 做" / "1 合了再说 3" issues actions; 已经 still reports.
    if (/(?:用|合|跑|改|测)了$/u.test(clause) && !/(?:已经|刚|已)/u.test(clause) && !sentenceStarts.has(at + 1) && followingAct) stance = "selected";
    // "Skip 3, 5": an English clause that is only names carries on the verb
    // before it. Chinese joins a list with 、, so its comma starts a new act.
    const bare = stance === "selected" && !actsByWord(clause);
    if (named.length > 0 && !/\p{Script=Han}/u.test(clause)) {
      if (bare && carried !== null) {
        stance = carried;
      } else if (!bare) {
        carried = stance;
      }
    } else {
      carried = null;
    }
    // A contrasted action replaces earlier takes; "but also" remains additive.
    if (stance === "selected" && named.length > 0 && /^but\s+(?:implement|apply|use)\b/iu.test(clause)) {
      verdicts.forEach((verdict, index) => {
        if (verdict === "selected" && !named.includes(index)) settle(index, "refused", at);
      });
    }
    if (EXCLUDES.test(clause) && !onlyDiscusses(clause) && !(stance === "mentioned" && /\b(?:is|are)\b/iu.test(clause))) {
      // "all but the migration" against options named only in Chinese: what is
      // left out cannot be told, so nothing is taken.
      if (named.length === 0) {
        return;
      }
      const saysWhat =
        stance !== "mentioned" &&
        (stance !== "selected" || DECISION_WORDS.test(clause) || APPROVES_OPTION.test(clause));
      if (!saysWhat && !THE_REST.test(clause) && !/\ball\b|都|全/iu.test(clause)) {
        // "除了 2，" waits for the clause that says what the others get.
        excluded = named;
        return;
      }
      // "All but 2" approves by its "all"; "除了 1 都不要" turns the rest down.
      const others: OptionVerdict = stance === "mentioned" ? "selected" : stance;
      named.forEach((index) => settle(index, opposite(others), at));
      rest ??= { verdict: others, at };
      return;
    }
    if (named.length === 0) {
      if (RESERVES.test(clause) && !THE_REST.test(clause)) {
        preferred.forEach(index => { if (verdicts[index] === "selected") verdicts[index] = "deferred"; });
      }
      // "2 更稳，但还要再压测": nothing said earlier is taken.
      if (DECISION_WITHHELD.test(clause) && !THE_REST.test(clause)) {
        verdicts.forEach((verdict, index) => {
          if (verdict === "selected" || verdict === "refused") verdicts[index] = "deferred";
        });
        return;
      }
      if (lastNamed.length === 1 && (DEICTIC_APPROVAL_ANSWER.test(clause) || /^(?:就)?(?:采用|用|选)(?:它|这个)(?:吧|了)?$/u.test(clause))) {
        settle(lastNamed[0]!, "selected", at);
        return;
      }
      if (stance === "selected" && /^(?:(?:then|and)\s+)?(?:apply|approve|implement|do|use|keep|run|merge|ship)(?:\s+(?:it|that|them|those|the (?:diff|patch|change)))?(?:\s+now)?$/iu.test(clause) &&
        (lastNamed.length === 1 || /\b(?:them|those)\b/iu.test(clause))) {
        lastNamed.forEach(index => settle(index, "selected", at));
        return;
      }
      if (options.length === 1 && (EXPLICIT_APPROVAL_ANSWER.test(clause) || /^(?:批准|确认|同意)(?:这个|该)(?:实施)?范围$|^(?:就)?按(?:这个|该)(?:实施)?范围做$/u.test(clause))) {
        settle(0, /^(?:不继续|否)$/u.test(clause) || REFUSES.test(clause) ? "refused" : "selected", at);
        return;
      }
      // "看看 2，然后合并它" / "核实一下 2 再上": the act lands on what was just read.
      if (lastNamed.length === 1 && /^(?:然后|再|接着)?(?:就)?(?:合并|上线|合|上|用|做)(?:它|这个)?(?:吧)?$/u.test(clause)) {
        settle(lastNamed[0]!, "selected", at);
        return;
      }
      if (!sentenceStarts.has(at) && stance === "selected" && /^(?:可以|没问题)(?:就)?(?:合|上|用|做)(?:吧)?$/u.test(clause)) {
        lastNamed.forEach(index => settle(index, "selected", at));
        return;
      }
      // "A 可以做，但先问问同事": the condition holds back what was just named.
      // "但是先别急着上线" holds back another act (上线), not the items.
      if (
        (/^(?:但是?|不过|可是|只是|\bbut\b|\bhowever\b)/iu.test(clause) || /^(?:暂时?|先)(?:不改|不动)$/u.test(clause)) &&
        (stance === "deferred" || stance === "refused") &&
        !OTHER_ACT.test(clause)
      ) {
        lastNamed.filter(index => !READ_ONLY_REQUEST.test(answer) || verdicts[index] === "selected")
          .forEach(index => settle(index, stance, at));
        return;
      }
      if (THE_REST.test(clause) && stance !== "mentioned") {
        excluded.forEach((index) => settle(index, opposite(stance), at));
        excluded = [];
        rest ??= { verdict: stance, at };
      }
      return;
    }
    lastNamed = named;
    if (stance === "selected" && !DECISION_WORDS.test(clause) && !APPROVES_OPTION.test(clause) && !TAKES_IN_WORDS.test(clause) &&
      !/\b(?:selected|chosen)\b/iu.test(clause) && (PREFERS.test(clause) || /更好|好一些|好点/u.test(clause))) preferred.push(...named);
    // "只做 1"、"先只做 1 和 2"、"Only 1 and 3" narrow the take; "1 只需要改配置"
    // uses 只 as an adverb about 1 and narrows nothing.
    if (
      stance === "selected" &&
      named.some((index) =>
        [
          ...referencesTo(options[index] as CapturedOption, index, true),
          ...(namesUsed[index] ?? []).map((name) => ({ source: escapeRegExp(name), flags: "iu" })),
        ].some((reference) =>
          new RegExp(`(?:(?:先)?(?:只|仅)(?:做|要|上|改|选|保留)?|\\bonly\\b)\\s*(?:第\\s*)?(?:${reference.source})`, "iu").test(clause),
        ),
      )
    ) {
      only.push(...named);
    }
    for (const index of named) {
      // "帮我加上 Redis 缓存" asks for work that happens to share a label.
      // "本地跑一下测试就行" names 本地缓存 on the way to something else.
      const elsewhere =
        !byId[index] &&
        (ASKS_FOR_WORK.test(clause) || (described !== index && (namesUsed[index] ?? []).every((name) => nameThenOtherAct(clause, name))));
      settle(index, stance === "selected" && elsewhere ? "mentioned" : stance, at);
    }
  });
  if (clauses.length === 1 && /^(?:今天|现在|本次)(?:一[个项条]都)?不批准(?:任何一?[个项条])?$/u.test(clauses[0] ?? "")) {
    rest = { verdict: "refused", at: 0 };
  }
  // An exclusion nothing followed up: "排除 2" alone does the others. After
  // "JWT 先排除。请用 Cookie session" the take says what the others get.
  if (excluded.length > 0) {
    const tookAnother = verdicts.some((verdict, index) => verdict === "selected" && !excluded.includes(index));
    excluded.forEach((index) => settle(index, "refused", clauses.length));
    if (!tookAnother) rest ??= { verdict: "selected", at: clauses.length };
  }
  if (rest !== null) {
    const { verdict, at } = rest;
    options.forEach((_option, index) => settle(index, verdict, at, true));
  }
  if (only.length > 0) {
    verdicts.forEach((verdict, index) => {
      if (verdict === "selected" && !only.includes(index)) verdicts[index] = "refused";
    });
  }
  return {
    verdicts,
    selected: order.filter((index) => verdicts[index] === "selected").map((index) => options[index] as CapturedOption),
  };
};

/**
 * A reply that only accepts what the assistant recommended: "按推荐的来"、"就按你推荐的"、"用推荐的"、"听你的，选推荐那个".
 * Whole-reply match, and any "不 / 别 / 换 / 而是 / 但 / 改" leaves it alone.
 */
const ACCEPTS_RECOMMENDATION =
  /^(?:好的?|行|嗯|可以)?[，,\s]*(?:听(?:你|您)的[，,\s]*)?(?:就|那就|还是|那)?\s*(?:按照|按|照|用|选|采用)\s*(?:你|您)?\s*(?:的\s*)?(?:推荐|建议)的?(?:那个|那种|方案|选项)?(?:来|办|做)?\s*(?:吧|就行|就好|即可|了)?$/u;
const TURNS_AWAY = /[不别换但改]|而是/u;
const acceptedRecommendation = (reply: string, options: CapturedOption[]): CapturedOption | undefined => {
  const marked = markedRecommendation(options);
  const text = reply.normalize("NFKC").trim().replace(/[。.!！~～\s]+$/u, "");
  return marked !== undefined && ACCEPTS_RECOMMENDATION.test(text) && !TURNS_AWAY.test(text) ? marked : undefined;
};

/**
 * The options with the recommendation marker taken off their labels (it is the assistant's metadata, not part of the
 * option), and a way back from a clone to the option it was made from. Matched by the object, never by `id`, which
 * is optional and may repeat. Null when no label carries a marker.
 */
const withoutMarkers = (
  options: CapturedOption[],
): { bare: CapturedOption[]; listed: (clone: CapturedOption) => CapturedOption } | null => {
  if (!options.some((option) => hasRecommendationMarker(option.label))) return null;
  const originals = new Map<CapturedOption, CapturedOption>();
  const bare = options.map((option) => {
    const clone = { ...option, label: stripRecommendationMarker(option.label) };
    // The number written beside a letter is kept per object, as `idOnly` carries it.
    const number = PAIRED_NUMBER.get(option);
    if (number !== undefined) PAIRED_NUMBER.set(clone, number);
    originals.set(clone, option);
    return clone;
  });
  return { bare, listed: (clone) => originals.get(clone) ?? clone };
};

/**
 * The reply read against the labels without their marker, so "按你推荐的来" does not look related to
 * "托管 Redis（推荐）" by the word 推荐. Only when the rules take nothing, a plain acceptance of the
 * recommendation takes the marked option.
 */
export const readReply = (reply: string, options: CapturedOption[]): ReplyReading => {
  const unmarked = withoutMarkers(options);
  if (unmarked === null) return readReplyUnmarked(reply, options);
  const reading = readReplyUnmarked(reply, unmarked.bare);
  const selected = reading.selected.map(unmarked.listed);
  const accepted = selected.length === 0 ? acceptedRecommendation(reply, options) : undefined;
  return accepted === undefined
    ? { ...reading, selected }
    : { verdicts: options.map((option) => (option === accepted ? "selected" : null)), selected: [accepted] };
};

/** The options a reply takes, in the order it names them; see `readReply`. */
export const selectedOptions = (
  answer: string,
  options: CapturedOption[],
): CapturedOption[] => readReply(answer, options).selected;

/**
 * The reply shares words with the request, but none that belongs to one option
 * alone: 安全 in 安全导出目录 / 安全传输通道 / 安全清理策略, or 稳定 from the
 * question. A reply in another language shares nothing and is not judged here.
 */
const sharesOnlyCommonWords = (answer: string, pending: PendingDecisionAnalysis): boolean => {
  const labelTokens = pending.options.map((option) => tokens(option.label));
  const overlap = [...tokens(answer)].filter(
    (token) => token.length > 1 && (tokens(pending.question).has(token) || labelTokens.some((set) => set.has(token))),
  );
  return (
    overlap.length > 0 &&
    overlap.every((token) => labelTokens.filter((set) => set.has(token)).length !== 1)
  );
};

/** Stand-ins for options that were not extracted: "1"…"9", also named A…I. */
const NUMBERED_SLOTS: CapturedOption[] = Array.from({ length: 9 }, (_slot, index) => ({
  id: String(index + 1),
  label: "",
}));

const CHINESE_NUMERALS = "一二三四五六七八九";
const CIRCLED_NUMERALS = "①②③④⑤⑥⑦⑧⑨";

/** Whether a message writes this number as a number: "一起" holds no 一, nor "S01" a 1. */
const writesNumber = (text: string, index: number): boolean => {
  const chinese = CHINESE_NUMERALS[index]!;
  return text.includes(CIRCLED_NUMERALS[index]!) ||
    new RegExp(`(?<![\\d.])${index + 1}(?!\\d)`, "u").test(text) ||
    new RegExp(`(?:第|方案|选项)\\s*${chinese}|^\\s*${chinese}[、.．:：]`, "mu").test(text);
};

/**
 * Whether a reply settles two or more numbers ("1 直推，2 可以，3 升") the message it was paired with wrote none of: it
 * answers an earlier message, and this one cannot say what was chosen. One number can answer "A 还是 B？" by position,
 * and one that is written ties the reply to this message. Only digits the reply typed count, so "第一个" is left alone.
 */
export const answersNumbersNotAsked = (assistantText: string, reply: string): boolean => {
  const settled = readReply(reply, NUMBERED_SLOTS).verdicts.flatMap((verdict, index) =>
    verdict !== null && new RegExp(`(?<!\\d)${index + 1}(?!\\d)`, "u").test(reply) ? [index] : []);
  return settled.length >= 2 && settled.every((index) => !writesNumber(assistantText, index));
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
    const options = parseOptionBlock(block, blocks[index - 1] ?? "");
    if (options !== null) {
      const askedAbove = EXPLICIT_CHOICE.test(blocks[index - 1] ?? "") &&
        blocks.slice(index + 1).every(remark =>
          (!NEW_TASK.test(remark) || /^(?:Background|背景)[:：]/iu.test(remark)) && !INFORMATION_REQUEST.test(remark) &&
          !ASSISTANT_CONTINUES.test(remark) && !TOPIC_SHIFT.test(remark) &&
          (!/[?？]/u.test(remark) || /^(?:Background|背景)[:：]/iu.test(remark)));
      return (askedAbove || (recommendation !== null && mentionsOption(recommendation, options.options))) &&
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

/**
 * English words every sentence shares: "the first thing to check" is not about
 * "Split the function". Single letters stay, since they may name an option.
 */
const FUNCTION_WORDS = new Set(
  "a the an to of is are was be it its this that these those and or in on at for with by as if then you we do does should would could can will what which how why there here not".split(" "),
);

const tokens = (value: string): Set<string> => {
  const normalized = value.normalize("NFKC").toLocaleLowerCase();
  const result = new Set(
    (
      normalized.match(
        /[\p{Letter}\p{Number}]{2,}|(?<![\p{Letter}\p{Number}])[a-z0-9](?![\p{Letter}\p{Number}])/gu,
      ) ?? []
    ).filter((token) => !FUNCTION_WORDS.has(token)),
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

/**
 * Set on a question rules-v10 found past a closing rules-v9 stopped at. A reply that
 * reads low over it counts as no reading at all (rules-v9 had none), so the rules
 * do not pull down what the model makes of the turn.
 */
export const QUESTION_LOCATED_PAST_CLOSING = "question_located_past_closing";
/** The rules' reading of a completed turn, or null where they have none to offer. */
export const ruleReading = (completed: CompletedDecisionAnalysis | null): CompletedDecisionAnalysis | null =>
  completed?.band === "low" && completed.signals.includes(QUESTION_LOCATED_PAST_CLOSING) ? null : completed;

/**
 * A closing paragraph judged clause by clause, whatever its lead-in or emphasis
 * (`*注:…*`、本轮未…、按你的要求，我没有…、等你回复。): every clause says nothing was
 * done or checked, that it was asked for, hedges the list above, or waits for
 * the reply. One clause doing or asking anything else keeps the paragraph.
 */
const NOTE_CLAUSE_BREAK = /[，,；;。.!！:：\n]|——|\s[—–-]+\s|但是?|不过|然而|\bbut\b|\bhowever\b/iu;
const NOTE_LABEL_OR_LEAD =
  /^(?:注|备注|说明|note|status|(?:按|根据|依)照?(?:你|您)?的?(?:要求|约定|指示)|as (?:you )?requested|per your (?:request|instructions)|以上(?:为|是|均为|仅为)[^请]{0,20})$/iu;
const NOTHING_DONE =
  /(?:未|尚未|没有|并未|暂未|均未|都没有?|没)(?:有)?(?:实际)?(?:运行|执行|跑|调用|使用|修改|改动|改|编辑|检查|核实|核对|核查|验证|测试|查看|查阅|查询|阅读|读取|访问|联网|浏览|搜索|安装|下载|提交|动)|待(?:核实|验证|核查|检查|核对)|\b(?:did not|didn't|have not|haven't|was not|were not|wasn't|weren't)\s+(?:\w+\s+){0,2}?(?:run|call|use|modify|change|edit|check|verify|test|touch)|\bno (?:tools|files|code|tests?|checks?|changes?)\b|\bnot (?:yet )?(?:checked|verified|run|tested)\b/iu;
const WAITS_FOR_REPLY =
  /^(?:我(?:会|将|先|就)?)?(?:在这里|在此|这边)?(?:等(?:待|着)?|静候)(?:你|您)(?:的)?(?:回复|回答|答复|反馈|指示|消息|决定|选择|确认)(?:后|之后)?(?:再(?:动手|开始|继续|执行|实施|改|做))?[。.!！~]*$|^(?:I(?:'ll| will)\s+)?(?:wait(?:ing)?|await(?:ing)?)\s+(?:for\s+)?your\s+(?:reply|answer|response|decision|go-?ahead)(?:\s+before\s+(?:I\s+)?(?:start|proceed|continue|make\s+changes)(?:ing)?)?[.!]*$/iu;
const isClosingNote = (block: string): boolean =>
  block.replace(/[*_`]/gu, "").split(NOTE_CLAUSE_BREAK).every((part) => {
    const clause = part.trim();
    return clause.length === 0 || NOTE_LABEL_OR_LEAD.test(clause) || WAITS_FOR_REPLY.test(clause) ||
      (NOTHING_DONE.test(clause) && !/(?:请|\bplease\b)/iu.test(clause));
  });
/** Quoted or code material: ~~~ fences, `code`, “…”「…」"…"; indented code lines are passed in. */
const MATERIAL = /~~~[\s\S]*?~~~|`[^`\n]{1,4000}`|[“「『][^”」』\n]{1,4000}[”」』]|"[^"\n]{1,4000}"/gu;
const asksOnlyInMaterial = (block: string, codeLines: Set<string>): boolean =>
  /[?？]/u.test(block) &&
  !/[?？]/u.test(block.split(/\r?\n/u).filter((line) => !codeLines.has(line.trim())).join("\n").replace(MATERIAL, ""));
/**
 * Up to three paragraphs after the question — explanation, advice, a heading over
 * next steps — that ask nothing, request nothing, report no choice made and start
 * nothing; the question in bold, or followed in its paragraph by a line of the
 * same kind, still asks. A list right under the question is its options.
 */
const closingRemarkRun = (blocks: string[]): number => {
  const remarksOnly = (remark: string): boolean =>
    !/[?？]/u.test(remark) && !EXPLICIT_CHOICE.test(remark) && !IMPLICIT_CONFIRMATION.test(remark) &&
    !INFORMATION_REQUEST.test(remark) && !TOPIC_SHIFT.test(remark) && !NEEDS_NO_ANSWER.test(remark) &&
    !ASSISTANT_CONTINUES.test(remark) && !ITEMWISE_REQUEST.test(remark) && !HANDS_OVER_CHOICE.test(remark) &&
    // A remark quoting anything ("…ends with “Let me know which”") is material, as on rules-v9.
    !/[“"「『][^”"」』]{2,}[”"」』]/u.test(remark) && !/(?:请|麻烦|\bplease\b)/iu.test(remark);
  for (let run = 1; run <= 3 && run < blocks.length; run += 1) {
    const question = blocks[blocks.length - 1 - run] ?? "";
    const asks = Math.max(question.lastIndexOf("?"), question.lastIndexOf("？"));
    if (asks < 0 || !EXPLICIT_CHOICE.test(question.slice(0, asks + 1))) continue;
    const remarks = blocks.slice(blocks.length - run);
    if (parseOptionBlock(remarks[0] ?? "") !== null) return 0;
    const tail = question.slice(asks + 1).replace(/[*_\s]+/gu, " ").trim();
    const tailOk = tail.length === 0 || (tail.length <= 300 && !/[?？]/u.test(tail) && !ASSISTANT_CONTINUES.test(tail) &&
      !NEEDS_NO_ANSWER.test(tail) && !TOPIC_SHIFT.test(tail) && !INFORMATION_REQUEST.test(tail));
    return tailOk && remarks.every(remarksOnly) ? run : 0;
  }
  return 0;
};
/**
 * The message with the closing notes, waits and remarks after its question set
 * aside, or null when there are none, or when what is left neither asks nor hands
 * the choice over, or asks only inside quoted or code material.
 */
const withoutClosingRemarks = (assistantText: string): string | null => {
  const cleaned = stripUnsafeContent(boundedVisibleText(assistantText).text);
  const blocks = paragraphs(cleaned);
  const before = blocks.length;
  const dropSeparators = (): void => {
    while (blocks.length > 1 && /^(?:-{3,}|\*{3,}|_{3,})$/u.test(blocks.at(-1) ?? "")) blocks.pop();
  };
  dropSeparators();
  for (let dropped = 0; dropped < 3 && blocks.length > 1; dropped += 1) {
    const last = blocks.at(-1) ?? "";
    // rules-v9 already read past its own notes; only what it could not read is set aside here.
    if (!isClosingNote(last) || /[?？]/u.test(last) ||
      EXPLICIT_CHOICE.test(afterFirstSentence(last)) || REQUEST_IN_NOTE.test(last) || ITEMWISE_REQUEST.test(last) ||
      STILL_ASKS.test(last) || IMPLICIT_CONFIRMATION.test(last)) break;
    blocks.pop();
    dropSeparators();
  }
  blocks.splice(blocks.length - closingRemarkRun(blocks));
  if (blocks.length === before) return null;
  const request = blocks.at(-1) ?? "";
  const codeLines = new Set(cleaned.split(/\r?\n/u).filter((line) => /^(?: {4}|\t)/u.test(line)).map((line) => line.trim()));
  const asks = /[?？]/u.test(request) || HANDS_OVER_CHOICE.test(request) ||
    EXPLICIT_CHOICE.test(request.slice(-500)) || IMPLICIT_CONFIRMATION.test(request.slice(-500));
  return asks && !asksOnlyInMaterial(request, codeLines) ? blocks.join("\n\n") : null;
};
export class TextDecisionAnalyzer {
  /**
   * rules-v10 is rules-v9 plus one addition. Where rules-v9 finds the question,
   * its reading stands. Where rules-v9 finds none, the closing notes,
   * waits and remarks after the question are set aside and rules-v9 reads what is
   * left; a question found that way is a candidate at most.
   */
  analyze(
    input: DecisionTurnExcerpt,
  ): PendingDecisionAnalysis | null {
    const asV9 = this.#analyzeAsV9(input);
    if (asV9 !== null) {
      return { ...asV9, detectorVersion: "rules-v10" };
    }
    const laidBare = withoutClosingRemarks(input.assistantText);
    const located = laidBare === null ? null : this.#analyzeAsV9({ ...input, assistantText: laidBare });
    return located === null ? null : {
      ...located,
      signals: [...new Set([...located.signals, "question_before_closing_remark", QUESTION_LOCATED_PAST_CLOSING])],
      detectorVersion: "rules-v10",
    };
  }

  #analyzeAsV9(
    input: DecisionTurnExcerpt,
  ): PendingDecisionAnalysis | null {
    const visible = boundedVisibleText(input.assistantText);
    const cleaned = stripUnsafeContent(visible.text);
    if (cleaned.length === 0) {
      return null;
    }
    const blocks = paragraphs(cleaned);
    const dropTrailingSeparators = (): void => {
      while (blocks.length > 1 && /^(?:-{3,}|\*{3,}|_{3,})$/u.test(blocks.at(-1) ?? "")) blocks.pop();
    };
    dropTrailingSeparators();
    for (
      let dropped = 0;
      dropped < MAXIMUM_TRAILING_DISCLAIMERS &&
      blocks.length > 1 &&
      TRAILING_DISCLAIMER.test(blocks.at(-1) ?? "") &&
      !/[?？]/u.test(blocks.at(-1) ?? "") &&
      // "未检查…。\n请告诉我选哪个" carries the question inside the note; the
      // note's own sentence ("尚未核实是否多实例运行") asks nothing.
      !EXPLICIT_CHOICE.test(afterFirstSentence(blocks.at(-1) ?? "")) &&
      !REQUEST_IN_NOTE.test(blocks.at(-1) ?? "") &&
      !ITEMWISE_REQUEST.test(blocks.at(-1) ?? "") &&
      !STILL_ASKS.test(blocks.at(-1) ?? "") &&
      !IMPLICIT_CONFIRMATION.test(blocks.at(-1) ?? "");
      dropped += 1
    ) {
      blocks.pop();
      dropTrailingSeparators();
    }
    // A confirmation note continues the question immediately above it.
    if (blocks.length > 1 && TRAILING_DISCLAIMER.test(blocks.at(-1) ?? "") &&
      IMPLICIT_CONFIRMATION.test(blocks.at(-1) ?? "") && EXPLICIT_CHOICE.test(blocks.at(-2) ?? "")) {
      blocks.splice(-2, 2, `${blocks.at(-2)}\n\n${blocks.at(-1)}`);
    }
    const request = blocks.at(-1) ?? "";
    if (
      request.length === 0 ||
      // "请告诉我：" over a 是/否 list, or "请告诉我选哪个", asks for a choice.
      // "请告诉我现在要运行哪些？" under a list still asks to pick from it.
      (INFORMATION_REQUEST.test(request) &&
        !ASKS_WHICH.test(request) &&
        parseOptionBlock(request) === null &&
        !EXPLICIT_CHOICE_WITHOUT_WHICH.test(request)) ||
      (ENGLISH_WHICH_STATUS.test(request) && !/\b(?:should|shall|choose|pick|approve|confirm)\b/iu.test(request)) ||
      STATUS_ANSWER.test(request) ||
      RHETORICAL_EXPLANATION.test(request)
    ) {
      return null;
    }

    // A numbered list is a plan's steps unless the reader is asked to pick
    // from it ("你选哪个"、"这三项都要做吗"、"which of these"); lettered items and
    // bullets are judged as before.
    // A list that closes the message answers the question above it: "Which
    // path should we use?" then "1. Blue-green 2. Canary".
    const pickable = (
      block: ParsedOptionBlock | null,
      asking: string,
    ): ParsedOptionBlock | null =>
      block !== null &&
      !ASKS_TO_PICK.test(pickingPart(asking)) &&
      !HANDS_OVER_CHOICE.test(asking) &&
      !asksItemByItem(pickingPart(asking), true) &&
      // "我建议采用改为异步接口" under the list picks from it as well.
      !RECOMMENDS_AN_OPTION.test(asking) &&
      // Table rows are a status table as often as options: `| A | 修复登录 | 完成 |`.
      block.raw.split(/\r?\n/u).some(
        (line) => /^[0-9]+$/u.test(ownMarker(line) ?? "") || line.trim().startsWith("|"),
      )
        ? null
        : block;
    const inlineOptions = pickable(
      parseOptionBlock(request, `${blocks.at(-2) ?? ""}\n\n${request}`),
      `${blocks.at(-2) ?? ""}\n\n${request}`,
    );
    const previousIndex = blocks.length - 2;
    const previous =
      previousIndex >= 0 ? blocks[previousIndex] ?? "" : "";
    const previousIntro =
      previousIndex > 0
        ? blocks[previousIndex - 1] ?? ""
        : "";
    const previousBlock = SEQUENTIAL_ACTION_INTRO.test(previousIntro)
      ? null
      : pickable(parseOptionBlock(previous, request), request);
    // "要点：- 列可空 - 已验证" over "确认要我应用吗？" describes what is being
    // approved; plain bullets above a yes/no request with nothing to pick are
    // not choices. Items that carry their own A./1. still are.
    const previousOptions =
      previousBlock !== null &&
      ACTION_YES_NO.test(request) &&
      !ASKS_TO_PICK.test(request) &&
      !asksItemByItem(request, true) &&
      previous.split(/\r?\n/u).every((line) => ownMarker(line) === null)
        ? null
        : previousBlock;
    // "你选哪个？" then "建议是 A，因为…": the advice closes the message and the
    // question it follows is what the reader answers.
    // "Should I apply the patch?" then a closing remark that asks nothing,
    // starts nothing and does nothing: the question is still the request.
    const questionThenAdvice =
      inlineOptions === null &&
      !EXPLICIT_CHOICE.test(request) &&
      !/[?？]/u.test(request) &&
      (MAKES_A_RECOMMENDATION.test(request) ||
        (request.length <= 300 && previousOptions === null && !NEW_TASK.test(request) && !INFORMATION_REQUEST.test(request) &&
          !ASSISTANT_CONTINUES.test(request) && !TOPIC_SHIFT.test(request) && !HANDS_OVER_CHOICE.test(request) &&
          // A remark quoting a request ("…ends with “Reply with the numbers”") is material, not a close.
          !NEEDS_NO_ANSWER.test(request) && !/[“"「『][^”"」』]{2,}[”"」』]/u.test(request))) &&
      EXPLICIT_CHOICE.test(previous) &&
      /[?？]\s*$/u.test(previous);
    const region =
      inlineOptions === null && (previousOptions === null || (!EXPLICIT_CHOICE.test(request) && !IMPLICIT_CONFIRMATION.test(request)))
        ? decisionBeforeClosingRemark(blocks)
        : null;
    // "你选哪个？" then "我会等你回复后再动手。": the question was read back past
    // the close, so its options are found from the question, not from the close.
    const readBackIntro = blocks[previousIndex - 1] ?? "";
    const readBackBlock =
      questionThenAdvice && inlineOptions === null && previousOptions === null && region === null
        ? pickable(parseOptionBlock(previous), previous) ??
          (previousIndex >= 1 && !SEQUENTIAL_ACTION_INTRO.test(blocks[previousIndex - 2] ?? "")
            ? pickable(parseOptionBlock(readBackIntro, previous), previous)
            : null)
        : null;
    // As above: plain bullets over a yes/no question only describe what is approved.
    const readBack =
      readBackBlock !== null && readBackBlock.raw !== previous &&
      ACTION_YES_NO.test(previous) && !ASKS_TO_PICK.test(previous) && !asksItemByItem(previous, true) &&
      readBackIntro.split(/\r?\n/u).every((line) => ownMarker(line) === null)
        ? null
        : readBackBlock;
    const optionBlock =
      inlineOptions ?? previousOptions ?? region?.options ?? null;
    // A read-back is a guess at where the question is, so its options are
    // there for the answer to point at, as a scattered set, not as evidence.
    const scattered =
      optionBlock === null
        ? readBack?.options ??
          optionsAcrossParagraphs(blocks, request) ??
          optionsAsTableColumns(blocks) ??
          (ASKS_TO_PICK.test(request) ? optionsAsTableRows(blocks) : null) ??
          optionsAsBoldTitles(blocks, request) ??
          // Only where the choice is put or advised: a remark elsewhere that
          // tags two things (A) and (B) offers nothing.
          optionsNamedInPassing(
            blocks
              .filter((block, index) => index === blocks.length - 1 || MAKES_A_RECOMMENDATION.test(block))
              .join("\n\n"),
          ) ??
          (ASKS_TO_PICK.test(request) ? optionsAsBareLetters(request) ?? optionsAsBareLetters(previous) : null) ??
          singleProposedAction(cleaned, request) ??
          // The reader's own framing: "配置用 A（YAML）还是 B（TOML）？给出推荐".
          (input.userText === null ? null : optionsNamedInPassing(input.userText))
        : null;
    // The decision the reader is being asked about, which is the paragraph the
    // message ends on unless the options sit further back.
    // "你确认要合并吗？" then "请告诉我：" over 是/否: the list answers the
    // paragraph above it, which is where the question is.
    const askedAbove =
      inlineOptions !== null &&
      !EXPLICIT_CHOICE.test(request) &&
      EXPLICIT_CHOICE.test(previous);
    const asked =
      region !== null
        ? blocks[region.index - 1] ?? request
        : askedAbove || questionThenAdvice
          ? previous
          : request;

    const inlineAlternatives =
      (INLINE_ALTERNATIVES.test(request) &&
        !CONCESSIVE_ALTERNATIVES.test(request)) ||
      (ENGLISH_INLINE_ALTERNATIVES.test(request) &&
        (/[?？]/u.test(request) ||
          /please (?:choose|decide)/iu.test(request)));
    const recommendedOption =
      (optionBlock?.options.length ?? 0) >= 2 &&
      RECOMMENDS_AN_OPTION.test(request);
    const verdictOnRecommendation =
      ASKS_FOR_VERDICT.test(request) && MAKES_A_RECOMMENDATION.test(cleaned);
    const itemByItem = asksItemByItem(
      request,
      (optionBlock?.options.length ?? scattered?.length ?? 0) >= 2,
    );
    const handsOver = (inlineOptions ?? previousOptions) !== null && HANDS_OVER_CHOICE.test(request);
    const explicit =
      EXPLICIT_CHOICE.test(request) ||
      handsOver ||
      itemByItem ||
      askedAbove ||
      questionThenAdvice ||
      (region !== null && EXPLICIT_CHOICE.test(blocks[region.index - 1] ?? "")) ||
      verdictOnRecommendation ||
      inlineAlternatives ||
      recommendedOption;
    const implicit = IMPLICIT_CONFIRMATION.test(request);
    if (!explicit && !implicit) {
      return null;
    }
    // "服务运行在哪个端口？" — a which with nothing to weigh asks for a fact.
    const asksForFact =
      ASKS_WHICH.test(request) &&
      !EXPLICIT_CHOICE_WITHOUT_WHICH.test(request) &&
      !ACTION_YES_NO.test(request) &&
      !inlineAlternatives &&
      !recommendedOption &&
      !implicit &&
      // "目前哪个模块已经发布？" over a status table asks how things are,
      // however many rows the table has.
      ((optionBlock?.options.length ?? scattered?.length ?? 0) < 2 ||
        ASKS_HOW_THINGS_ARE.test(request)) &&
      !WEIGHS_ALTERNATIVES.test(request);
    if (asksForFact) {
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
    // "是否继续应用？（确认后我会执行）" still waits: the doing is conditional.
    if (
      ASSISTANT_CONTINUES.test(textAfterQuestion) &&
      !IMPLICIT_CONFIRMATION.test(textAfterQuestion) &&
      !CONDITIONAL_ON_REPLY.test(textAfterQuestion)
    ) {
      return null;
    }

    const framingEnd =
      readBack !== null ? previousIndex - (readBack.raw === previous ? 0 : 1) : previousOptions === null ? blocks.length - 1 : previousIndex;
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
        EXPLICIT_CHOICE.test(request) || handsOver || itemByItem || askedAbove || questionThenAdvice || (region !== null && EXPLICIT_CHOICE.test(asked))
          ? "has_choice_prompt"
          : recommendedOption
            ? "recommends_one_option"
            : inlineAlternatives
              ? "has_choice_prompt"
              : "asks_verdict_on_recommendation",
      );
    }
    if (implicit) {
      score += WEIGHTS.implicitConfirmation;
      signals.push("awaits_confirmation");
    }
    // Read back past a closing remark that recommends nothing: a guess at
    // where the question is, so the answer is a candidate at most.
    if (questionThenAdvice && !MAKES_A_RECOMMENDATION.test(request)) {
      signals.push("question_before_closing_remark");
    }
    if ((optionBlock?.options.length ?? 0) >= 2) {
      score += WEIGHTS.multipleOptions;
      signals.push("has_multiple_options");
      if (region !== null) {
        signals.push("options_before_closing_remark");
      }
    } else if (scattered !== null) {
      // Found for the answer to point at, not as evidence of a request: the
      // scattered set never raises the score.
      signals.push("options_across_paragraphs");
    }
    if ((optionBlock?.options.length ?? 0) < 2 && inlineAlternatives) {
      score += WEIGHTS.multipleOptions;
      signals.push("has_inline_alternatives");
    }
    if (DECISION_VOCABULARY.test(cleaned)) {
      score += WEIGHTS.decisionVocabulary;
      signals.push("has_decision_vocabulary");
    }
    score += WEIGHTS.finalWaitingPosition;
    signals.push("ends_waiting_for_user");
    // "现在要提交吗？" with nothing to pick from: only a yes or a no answers it.
    if (
      ACTION_YES_NO.test(request) &&
      !EXPLICIT_CHOICE_WITHOUT_WHICH.test(request) &&
      (optionBlock?.options.length ?? 0) < 2 &&
      !inlineAlternatives
    ) {
      signals.push("asks_yes_or_no");
    }
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
      options: optionBlock?.options ?? scattered ?? [],
      ...(context === undefined ? {} : { context }),
      preScore: clamp(score),
      signals,
      detectorVersion: "rules-v9",
    };
  }

  complete(
    pending: PendingDecisionAnalysis,
    prompt: string,
  ): CompletedDecisionAnalysis {
    const unmarked = withoutMarkers(pending.options);
    if (unmarked === null) return this.#complete(pending, prompt);
    // Judged on the bare labels; what it hands back names the options as they were listed.
    const accepted = acceptedRecommendation(prompt, pending.options);
    const result = this.#complete(
      { ...pending, options: unmarked.bare },
      prompt,
      accepted === undefined ? undefined : unmarked.bare[pending.options.indexOf(accepted)],
    );
    return { ...result, options: pending.options, selected: result.selected.map(unmarked.listed) };
  }

  #complete(
    pending: PendingDecisionAnalysis,
    prompt: string,
    accepted?: CapturedOption,
  ): CompletedDecisionAnalysis {
    const answer = prompt.normalize("NFKC").trim();
    const decisionAnswer = answer.replace(/[。.!！]+$/u, "").trim();
    const signals = [...pending.signals];
    if (isCompletedDecisionStatus(decisionAnswer)) {
      return { ...pending, signals: [...signals, "answer_is_status_update"], score: 0, band: "low", selected: [] };
    }
    let score = pending.preScore;
    // Options gathered across paragraphs or named in passing are there for the
    // answer to be read against afterwards, not as evidence: here the reply is
    // judged as if the message had listed none (R2 holdout: replies that left
    // the question tied to those labels and slipped past the new-task test).
    const options = pending.signals.includes("options_across_paragraphs")
      ? []
      : pending.options;
    // "第一个和第三个" / "the first and the third" point at options by position.
    // "先按 2 的思路想想": the verb lands on 2 inside a clause that is still
    // thinking it over. "先用 A 再说" uses A for now and has decided.
    const takesOne =
      !DECISION_WITHHELD.test(answer) &&
      takesOneOption(answer, options) &&
      !clausesOf(answer).some(
        (clause) =>
          takesOneOption(clause, options) &&
          (READ_ONLY_REQUEST.test(clause) || STILL_THINKING.test(clause) || ANSWER_IS_QUESTION.test(clause) || TELLS_WHAT_HAPPENED.test(clause) || DESCRIBES_CURRENT_STATE.test(clause)),
      );
    // The reply read once against the options it answers — or, with none
    // extracted, against bare numbers and letters ("1 和 3 先做，2 暂缓").
    // What it takes is what the event records, so a reply taking any option
    // has decided, whatever else it puts off.
    const unlisted = pending.options.length === 0;
    // Offered a look beside a go-ahead, "A 批准实施；B 先只给我看 diff" takes A and
    // only looks at B: a clause that asks to see and approves nothing is set aside.
    const lookOffered = OFFERS_A_LOOK.test(pending.question);
    const read = readReply(
      lookOffered ? answer.split(/(?<=[、，,；;。.!！?？])/u).filter((part) => !ASKS_TO_SEE.test(part) || TAKES_A_GO.test(part)).join("") : answer,
      unlisted ? NUMBERED_SLOTS : pending.options,
    );
    // Only where the rules took nothing: a plain acceptance of the one recommended option.
    const reading: ReplyReading = accepted === undefined || read.selected.length > 0 || unlisted
      ? read
      : { verdicts: pending.options.map((option) => (option === accepted ? "selected" : null)), selected: [accepted] };
    const taken = reading.selected.length > 0;
    const takesListed = taken && !unlisted;
    const optionMatched = takesOne || takesListed || namesAnOption(answer, options);
    if (optionMatched) {
      score += ANSWER_WEIGHTS.optionIdOrLabel;
      signals.push(takesOne ? "answer_takes_one_option" : "answer_matches_option");
    }
    const scopeApproval = /^(?:只|仅)?(?:处理|实现|做)(?:第)?\s*[0-9一二三四五六七八九]/u.test(decisionAnswer) && /(?:要我|是否(?:需要)?我).{0,12}(?:做|处理|实现|执行)/u.test(pending.question);
    const diagnosticApproval = /^(?:先)?(?:用|使用).{1,80}(?:核实|定位|排查|诊断)/u.test(decisionAnswer) && pending.signals.includes("has_multiple_options") && /(?:核实|定位|排查|诊断)/u.test(pending.question);
    const stance =
      decisionAnswer
        .replace(ACKNOWLEDGEMENT_PREFIX, "")
        .replace(CONCEDING_LEAD, "") || decisionAnswer;
    const explicitApproval = scopeApproval || diagnosticApproval || EXPLICIT_APPROVAL_ANSWER.test(stance) ||
      /^(?:(?:我)?(?:确认|批准|同意)|I approve|approve)(?=$|[，,；;:：]|\s*[—–]|\s+because\b)/iu.test(stance) ||
      (COLLOQUIAL_APPROVAL.test(stance) && options.length < 2) || /^(?:确认|批准|可以|同意|要|需要)[，,。.!！]/u.test(stance) ||
      (/^(?:commit\s*\+\s*push|提交(?:并|、|，|\s)*推送)(?:\b|[，,、\s]|$)/iu.test(decisionAnswer) && /(?:提交|推送|评审|commit|push|PR)/iu.test(pending.question));
    const describedCommitment = pending.options.length >= 2 && clausesOf(answer).some(commitsByDescription);
    // "Approve — go ahead and implement it"、"Yes, implement it"、"批准，请实施…":
    // put to an approval question, a reply that opens on the approval answers it,
    // whatever work it goes on to name.
    const opensWithApproval =
      APPROVAL_CLAUSE.test(firstClauseOf(decisionAnswer)) && !DEFERS_DECISION.test(answer) && !SWAPS_THE_ACT.test(answer) &&
      (pending.signals.includes("asks_yes_or_no") || APPROVAL_ASKED.test(pending.question) ||
        (ASKS_FOR_A_GO.test(pending.question) && !/\bwhich\b|哪/iu.test(pending.question)));
    const directionalApproval =
      (DIRECTIONAL_APPROVAL_ANSWER.test(stance) && !(DECISION_WITHHELD.test(answer) && !taken)) || describedCommitment || opensWithApproval;
    const shortAnswer = SHORT_ANSWER.test(stance);
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
      `${pending.question}\n${options
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
    const listedPick =
      pending.options.length >= 2 &&
      !pending.signals.includes("options_across_paragraphs") &&
      !pending.signals.includes("has_inline_alternatives") &&
      (ASKS_TO_PICK.test(pending.question) || asksItemByItem(pending.question, true));
    const hasAnswerRelation =
      optionMatched ||
      explicitApproval ||
      directionalApproval ||
      shortAnswer ||
      answerRelated;
    const approves = explicitApproval || directionalApproval || shortAnswer;
    // The three "not deciding" caps below hold only when the reply neither
    // approves nor takes one option: "先用 A，之后再决定" and "就按 B 来，然后呢"
    // have decided, while "比较本地方案和云端方案后再决定" names both and takes none.
    const decides = approves || takesOne || takesListed;
    const actsOnOptions = reading.verdicts.some(
      (verdict) => verdict === "selected" || verdict === "refused",
    ) || (reading.verdicts.every((verdict) => verdict === "deferred") &&
      !WEIGHS_OPTIONS.test(answer) && !STILL_THINKING.test(answer) && !DEFERS_DECISION.test(answer) &&
      !clausesOf(answer).slice(1).some((clause) => PUTS_OFF.test(clause)));
    // "先不管这个，帮我…" leaves the question behind however much it shares with it.
    const unrelated =
      (TOPIC_SHIFT.test(answer) && !taken) ||
      // "不用了，帮我看下 README": a stance word up front does not tie a new
      // task back to the question; shared words must identify more than the topic.
      (answer.length >= 8 &&
        NEW_TASK.test(answer) &&
        !takesOne &&
        !taken &&
        !explicitApproval &&
        !opensWithApproval &&
        !(pending.options.some((option, index) => namesOption(answer, idOnly(option), index, true))) &&
        (pending.options.length >= 2 || !answerRelated));
    if (unrelated || answer.length === 0) {
      signals.push(
        unrelated ? "unrelated_new_task" : "empty_answer",
      );
      score = 0;
    } else if (
      !decides &&
      !actsOnOptions &&
      acknowledgesWithoutDeciding(answer, requestTokens)
    ) {
      signals.push("answer_is_acknowledgement");
      score = Math.min(score, 40);
    } else if (!decides && !actsOnOptions && READ_ONLY_REQUEST.test(answer) &&
      !clausesOf(answer).some(clause => /(?:批准|同意|\bapprov)/iu.test(clause) && !READ_ONLY_REQUEST.test(clause) && !DEFERS_DECISION.test(clause) && !REFUSES.test(clause))) {
      signals.push("answer_only_requests_information");
      score = Math.min(score, 40);
    } else if (!taken && !namesAnOption(answer, pending.options) &&
      reading.verdicts.every(verdict => verdict === "refused") && DEFERS_DECISION.test(answer)) {
      signals.push("answer_defers_decision");
      score = Math.min(score, 40);
    } else if (!decides && !actsOnOptions && DEFERS_DECISION.test(answer)) {
      // Naming every option on the way to "再决定" is not choosing one.
      signals.push("answer_defers_decision");
      score = Math.min(score, 40);
    } else if (
      !decides &&
      !actsOnOptions &&
      !ANSWER_IS_QUESTION.test(answer) &&
      (clausesOf(answer).every(
        (clause) =>
          ONLY_EVALUATES.test(clause) ||
          READ_ONLY_REQUEST.test(clause) ||
          WEIGHS_OPTIONS.test(clause) ||
          STILL_THINKING.test(clause) ||
          (clausesOf(answer).length > 1 && ANSWER_IS_QUESTION.test(clause)) ||
          DEFERS_DECISION.test(clause) ||
          TELLS_WHAT_HAPPENED.test(clause) ||
          (NO_CHANGE.test(clause) && clausesOf(answer).some(other => !NO_CHANGE.test(other))),
      ) || (READ_ONLY_REQUEST.test(answer) && clausesOf(answer).every(clause =>
        READ_ONLY_REQUEST.test(clause) || /^(?:暂时?|先)?不(?:修改|改动?)$/u.test(clause))))
    ) {
      // "1 还没看" / "Redis 太重了": the option is talked about, not taken;
      // "Redis 现在用着挺好，先不换" decides in its second clause.
      signals.push("answer_only_evaluates");
      score = Math.min(score, 40);
    } else if (
      !taken &&
      ANSWER_IS_QUESTION.test(answer) &&
      (!approves || !clausesOf(answer).some(
        (clause) =>
          !ANSWER_IS_QUESTION.test(clause) &&
          (EXPLICIT_APPROVAL_ANSWER.test(clause) || DIRECTIONAL_APPROVAL_ANSWER.test(clause) || commitsByDescription(clause)),
      ))
    ) {
      // Asking about an option is weighing it, not taking it.
      signals.push("answer_is_question");
      score = Math.min(score, 40);
    } else if (
      !decides &&
      !actsOnOptions &&
      // "We already added the CI config last week": what was done, not what to do.
      // How things are, said up front, unless a later clause goes on to act.
      ((DESCRIBES_CURRENT_STATE.test(answer) && !clausesOf(answer).slice(1).some(clause => !onlyDiscusses(clause) && commitsInWords(clause) &&
        (namesAnOption(clause, pending.options) || /\b(?:it|that)\b|它|这个/iu.test(clause)))) ||
        clausesOf(answer).every((clause) => TELLS_WHAT_HAPPENED.test(clause)))
    ) {
      signals.push("answer_describes_current_state");
      score = Math.min(score, 40);
    } else if (
      !decides &&
      !actsOnOptions &&
      pending.options.length >= 2 &&
      // Options gathered across paragraphs are a guess at what was offered;
      // "现在跑还是等窗口期？" under bold steps is answered "等窗口期", one of the
      // alternatives the question itself wrote out, and decides.
      !(
        pending.signals.includes("options_across_paragraphs") &&
        (INLINE_ALTERNATIVES.test(pending.question) || ENGLISH_INLINE_ALTERNATIVES.test(pending.question))
      ) &&
      // Only where the reader was asked to pick: "请确认是否提交" is answered "提交".
      (ASKS_WHICH.test(pending.question) || ASKS_TO_PICK.test(pending.question)) &&
      !ACTION_YES_NO.test(pending.question) &&
      !/(?:是否|要不要)/u.test(pending.question) &&
      reading.verdicts.every((verdict) => verdict === null) &&
      // "不合并，先等等" turns down the act both options share: that is a stance.
      !REFUSES.test(answer) &&
      !/(?:^|[，,；;\s])(?:先|暂时?)?(?:不|别)(?!错|太|行)/u.test(answer) &&
      sharesOnlyCommonWords(answer, pending)
    ) {
      // Options laid out and none of them named: "稳定优先"、"清理一下就好"、
      // "登录相关的都可以" share a word with every option and pick none.
      signals.push("answer_names_no_option");
      // Over options gathered across paragraphs the miss may be ours: better a
      // candidate to confirm than a decision lost.
      score = Math.min(score, pending.signals.includes("options_across_paragraphs") ? 74 : 40);
    } else if (!hasAnswerRelation) {
      signals.push("answer_relation_uncertain");
      // A listed pick needs an answer about its choices; keep unmapped names
      // and explicit choice wording as candidates rather than losing a decision.
      score = Math.min(
        score,
        (pending.signals.includes("asks_yes_or_no") ||
          (listedPick &&
            !actsOnOptions &&
            !EXCLUDES.test(answer) &&
            !DECISION_WORDS.test(answer) &&
            // "都不选" turns every option down, as "Neither" does.
            !/^(?:一个都|全都|都)不(?:选|要|做)/u.test(decisionAnswer) &&
            !/^[A-Za-z][A-Za-z0-9_+.#/-]*$/u.test(decisionAnswer))) ? 40 : 60,
      );
    }
    // "1 和 3 做，2 暂缓": some options taken, the rest turned down or put
    // off. With the options extracted the mapping is exact; without them the
    // numbers point at nothing the event can record, so it stays a candidate.
    if (
      !unrelated &&
      taken &&
      reading.verdicts.some((verdict) => verdict === "refused" || verdict === "deferred")
    ) {
      signals.push("answer_partially_approves");
      if (!unlisted) {
        score = Math.max(score, 75);
      }
    }
    // Bare numbers taken or turned down with no options extracted: at least a
    // candidate, however the request was phrased ("1 和 3 做"、"只做 1"). Two or
    // more of them point into a list that could not be read, so the event
    // cannot say what was chosen: a candidate at most. One bare letter answering
    // "A 还是 B？" names an alternative the request wrote out.
    if (!unrelated && unlisted && actsOnOptions) {
      signals.push("answer_settles_unlisted_options");
      score = Math.max(score, 50);
      if (reading.verdicts.filter((verdict) => verdict !== null).length >= 2) {
        score = Math.min(score, 74);
      }
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
    if (pending.signals.includes("question_before_closing_remark")) {
      signals.push("closing_remark_cap");
      score = Math.min(score, 74);
    }
    if (
      pending.signals.includes("awaits_confirmation") &&
      !pending.signals.includes("has_choice_prompt")
    ) {
      signals.push("implicit_confirmation_cap");
      score = Math.min(score, 74);
    }
    if (!unrelated && describedCommitment && !takesListed && !takesOne) {
      signals.push("answer_commits_unmapped_option");
      score = Math.max(50, Math.min(score, 74));
    }
    // "B 也行，具体你来定": handing the pick back with nothing taken or turned down
    // leaves it undecided; "A 不做，B 也不做，后续你来定" has decided both.
    if (!unlisted && !reading.verdicts.some((verdict) => verdict === "selected" || verdict === "refused") &&
      clausesOf(answer).some(handedBack) && score >= 50) {
      signals.push("answer_hands_choice_back");
      score = Math.min(score, 40);
    }
    // Offered a look beside a go-ahead, a reply that takes, turns down and
    // approves nothing has not gone ahead: "先看 B 的 diff" is a candidate at most.
    if (!decides && !actsOnOptions && !unlisted && lookOffered && score >= 75) {
      signals.push("answer_may_only_look");
      score = 74;
    }
    if (!decides && !actsOnOptions && !unlisted &&
      !EXCLUDES.test(answer) && clausesOf(answer).every(clause => onlyDiscusses(clause) || /\b(?:concerns|relates to)\b/iu.test(clause)) &&
      !pending.signals.includes("has_inline_alternatives") &&
      !clausesOf(answer).some(clause => DIRECTIONAL_APPROVAL_ANSWER.test(clause) || REFUSES.test(clause) || /^(?:先|暂时?)?不\p{Script=Han}+/u.test(clause)) && score >= 75) {
      signals.push("answer_has_no_commitment");
      score = 74;
    }
    if (DEICTIC_APPROVAL_ANSWER.test(decisionAnswer) && !taken &&
      !pending.signals.includes("recommends_one_option") &&
      !(RECOMMENDS_AN_OPTION.test(pending.question) && mentionsOption(pending.question, pending.options))) {
      signals.push("answer_has_no_commitment");
      score = Math.min(score, 74);
    }
    // Last: nothing above can say what the numbers meant, or lift a pair that does not belong together.
    // The list is often above the closing question, in what framed it.
    if (unlisted && answersNumbersNotAsked(`${pending.context?.decisionFraming ?? ""}\n${pending.question}`, answer)) {
      signals.push("answer_numbers_not_asked");
      score = Math.min(score, 40);
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
      selected: unrelated || unlisted ? [] : reading.selected,
    };
  }
}
