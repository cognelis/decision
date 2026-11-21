import { clipText } from "@cognelis/decision-protocol";

import type { SemanticClassifierInput } from "../semantic/semantic-classifier.js";

/** Visible tokens one classification needs; thinking is budgeted on top. */
export const SEMANTIC_OUTPUT_TOKENS = 256;

export const SEMANTIC_PROMPT_VERSION = "semantic-v4";
export const SEMANTIC_SCHEMA_VERSION =
  "semantic-classification-v2";

const MAX_ASSISTANT_CHARACTERS = 1_800;
const MAX_USER_CHARACTERS = 700;

export const semanticOutputJsonSchema: Record<
  string,
  unknown
> = {
  type: "object",
  properties: {
    decisionIntent: {
      enum: [
        "decision",
        "approval",
        "information_request",
        "self_resolved",
        "none",
      ],
    },
    answerRelation: {
      enum: ["answers", "mixed", "new_task", "uncertain"],
    },
    question: {
      type: ["string", "null"],
      maxLength: 160,
    },
    optionLabels: {
      type: "array",
      items: { type: "string", maxLength: 80 },
      maxItems: 8,
    },
    selectedOptionIndices: { type: "array", items: { type: "integer", minimum: 1, maximum: 8 }, maxItems: 8 },
    answerExcerpt: {
      type: ["string", "null"],
      maxLength: 120,
    },
    confidence: { type: "number" },
  },
  required: [
    "decisionIntent",
    "answerRelation",
    "question",
    "optionLabels",
    "selectedOptionIndices",
    "answerExcerpt",
    "confidence",
  ],
  additionalProperties: false,
};

const semanticOutputProperties =
  semanticOutputJsonSchema.properties as Record<
    string,
    unknown
  >;

export const qwenSemanticOutputJsonSchema: Record<
  string,
  unknown
> = {
  ...semanticOutputJsonSchema,
  properties: {
    ...semanticOutputProperties,
    question: {
      oneOf: [
        { type: "string", maxLength: 160 },
        { type: "null" },
      ],
    },
    answerExcerpt: {
      oneOf: [
        { type: "string", maxLength: 120 },
        { type: "null" },
      ],
    },
  },
};

export const semanticSystemPrompt = `Classify whether an assistant message leaves a real decision to the human and whether the immediately following user message answers it.
decisionIntent describes the assistant's request, even when the user does not answer it. answerRelation describes the user's current stance.

decision: asks the human to choose among at least two viable paths.
approval: asks the human for yes/no permission to proceed.
information_request: asks for a fact, preference, or missing input without presenting a decision.
self_resolved: the assistant already chose the path and only reports it, or ends by saying it will go ahead on its own.
none: no human decision is requested.

answers: the user's reply takes, approves, or rejects one or more of the proposed paths. Picking some items, excluding one ("all except the second"), rejecting every option ("neither", "none of these"), refusing to approve any, stating which option they favour ("I'd lean towards B", "3 beats 2", "B should be the default"), or approving after a check named in the same reply ("check the diff of 2, then approve it") all answer.
mixed: the user answers and in the same reply also asks a question, adds instructions, or starts another task (for example "go with A; what did B involve?").
new_task: the user does not answer and starts something else.
uncertain: the user talks about the options without taking, favouring, or rejecting any.

Taking an option for now or as a trial ("use A for the time being, we can revisit it"), or taking one and then mentioning a follow-up such as confirming a date or telling someone, still answers: only a reply that keeps the choice itself open is uncertain.

Distinguish the object of each clause. A tentative preference followed by handing the final choice back to the assistant is uncertain, not a selected option. Handing over deployment timing, a reviewer, or other details AFTER choosing the implementation does not undo that choice. A quotation of an earlier person's choice is background unless the user currently endorses it. Approval of a general direction does not select a concrete implementation that the user explicitly leaves open. Rejecting every proposed option (including "None of these options") answers the decision; it selects no option.

selectedOptionIndices: the 1-based positions of options the user currently selects or approves. When selection_options is supplied, use its fixed index values and return optionLabels=[]; these labels are already extracted from the source and must not be re-extracted or reordered. Otherwise, copy complete option labels from the assistant into optionLabels in source order and use their 1-based positions. Never emit an index outside the supplied/extracted list. Return [] for refused, deferred, merely mentioned, quoted-only, delegated, or still undecided options. A rejection of all options has answerRelation=answers and selectedOptionIndices=[]. Approval of an unlisted alternative selects no listed option. If answerRelation is uncertain or new_task, selectedOptionIndices must be [].
Return EVERY selected position, including every remaining alternative in an "all except" answer. For mixed replies, record the choices actually made before the follow-up question; asking about another option does not select it or undo the choice.

A reply is uncertain, not answers, when it only points out a drawback or property of an option without favouring it ("B is slow", "option 2 needs a maintenance window"), only asks to look at, read, or check something with no choice after it, only describes how things currently are, explicitly holds the decision open ("not decided yet", "let's benchmark before choosing"), or makes the choice depend on a condition that is not settled.

Judge the user's reply against the actual pending proposal, not incidental questions in code, reports, or deferred side issues.
Approval may accept only part of a proposed scope (for example, implement the first two items and skip the third), or specify a tool for the requested next step of the same plan. Such replies still answer the proposal.
Approval followed by a request to explain deferred alternatives is mixed, rather than a wholly new task.
A completed-status update such as "already merged" is information, not new permission to change another item or execute the next step.
If the user criticizes an earlier implementation detail or starts a different task without answering the pending proposal, classify that relation as new_task; do not treat a negative word alone as rejection of the pending choices.

Copy question and answerExcerpt exactly from the supplied text. Use null when absent. Do not infer hidden alternatives.

When question is not null, copy one exact contiguous excerpt of at most 160 characters. When answerExcerpt is not null, copy one exact contiguous excerpt of at most 120 characters. Every option label must be an exact contiguous excerpt of at most 80 characters. Never copy the whole message into any field.

Do not reveal chain-of-thought or explanations. Return only the JSON structure.`;

// Never half an emoji at a cut: a lone surrogate is what stricter APIs refuse the whole request over.
const tail = (value: string, maximum: number): string =>
  value.length <= maximum ? value : value.slice(-maximum).replace(/^[\uDC00-\uDFFF]/, "");

const head = (value: string, maximum: number): string => clipText(value, maximum);

export const buildSemanticUserPrompt = (
  input: SemanticClassifierInput,
): string => `Locale: ${input.locale}

<assistant_message>
${tail(input.assistantText, MAX_ASSISTANT_CHARACTERS)}
</assistant_message>
${input.selectionOptions?.length ? `\n<selection_options>\n${JSON.stringify(input.selectionOptions.map((option, index) => ({ index: index + 1, ...(option.id === undefined ? {} : { id: option.id }), label: option.label })))}\n</selection_options>\n` : ""}

<user_message>
${head(input.userText, MAX_USER_CHARACTERS)}
</user_message>`;
