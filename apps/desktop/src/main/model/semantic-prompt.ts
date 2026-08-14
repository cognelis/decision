import type { SemanticClassifierInput } from "../semantic/semantic-classifier.js";

export const SEMANTIC_PROMPT_VERSION = "semantic-v1";
export const SEMANTIC_SCHEMA_VERSION =
  "semantic-classification-v1";

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
      oneOf: [
        { type: "string", maxLength: 160 },
        { type: "null" },
      ],
    },
    optionLabels: {
      type: "array",
      items: { type: "string", maxLength: 80 },
      maxItems: 8,
    },
    answerExcerpt: {
      oneOf: [
        { type: "string", maxLength: 120 },
        { type: "null" },
      ],
    },
    confidence: { type: "number" },
  },
  required: [
    "decisionIntent",
    "answerRelation",
    "question",
    "optionLabels",
    "answerExcerpt",
    "confidence",
  ],
  additionalProperties: false,
};

export const semanticSystemPrompt = `Classify whether an assistant message leaves a real decision to the human and whether the immediately following user message answers it.

decision: asks the human to choose among at least two viable paths.
approval: asks the human for yes/no permission to proceed.
information_request: asks for a fact, preference, or missing input without presenting a decision.
self_resolved: the assistant already chose the path and only reports it.
none: no human decision is requested.

answers: the user directly chooses or approves.
mixed: the user answers and also adds instructions or a new task.
new_task: the user does not answer and starts something else.
uncertain: the relation is genuinely ambiguous.

Copy question and answerExcerpt exactly from the supplied text. Use null when absent. Do not infer hidden alternatives.

When question is not null, copy one exact contiguous excerpt of at most 160 characters. When answerExcerpt is not null, copy one exact contiguous excerpt of at most 120 characters. Every option label must be an exact contiguous excerpt of at most 80 characters. Never copy the whole message into any field.

Do not reveal chain-of-thought or explanations. Return only the JSON structure.`;

const tail = (value: string, maximum: number): string =>
  value.length <= maximum ? value : value.slice(-maximum);

const head = (value: string, maximum: number): string =>
  value.length <= maximum ? value : value.slice(0, maximum);

export const buildSemanticUserPrompt = (
  input: SemanticClassifierInput,
): string => `Locale: ${input.locale}

<assistant_message>
${tail(input.assistantText, MAX_ASSISTANT_CHARACTERS)}
</assistant_message>

<user_message>
${head(input.userText, MAX_USER_CHARACTERS)}
</user_message>`;
