import { languageLabel, type JournalEntry } from "./journal-entry.js";
import type { MethodologyRecallInput } from "./methodology-recall.js";
import { hashSimilarity, matchedTerms, tokenHashCache, tokenHashes, tokens } from "./recall-text.js";

/**
 * Recalling the reader's own preferences and ideas before a choice.
 *
 * Deliberately separate from `buildMethodologyRecall`, and never merged into
 * its results: an accepted principle is a rule the reader confirmed through the
 * methodology flow, a preference is a current stance that allows exceptions,
 * and an idea is not a commitment at all. Consumers have to be able to tell
 * them apart, so they travel as their own kind with their own standing.
 */

/**
 * Always "possible". A preference is a current stance and an idea is not a
 * commitment at all, so neither can be a strong reason to do anything;
 * `relevanceScore` says how closely the text matched, which is a different
 * claim from how much weight the record deserves.
 */
export type JournalRecallStrength = "possible";

export interface JournalRecallMatch {
  recordId: string;
  kind: JournalEntry["kind"];
  title: string;
  /** What the record says, as the reader wrote it. */
  summary: string;
  /** What it is allowed to be used as. Always present, always said. */
  standing: string;
  /**
   * The fields that qualify it — a preference's conditions and exceptions, an
   * idea's open questions. Absent when the reader did not record any.
   */
  qualifier: string | null;
  score: number;
  strength: JournalRecallStrength;
  reason: string;
  matchedTerms: string[];
}

export const JOURNAL_STANDING: Readonly<Record<JournalEntry["kind"], string>> = {
  preference: "偏好：当前立场，允许例外；未经方法论流程确认前不是已采纳原则",
  idea: "想法：尚未形成承诺的观察或假设，不能当作已采纳的方向",
};

const KIND_LABEL: Readonly<Record<JournalEntry["kind"], string>> = {
  preference: "偏好",
  idea: "想法",
};

const qualifierOf = (entry: JournalEntry): string | null => {
  const parts =
    entry.kind === "preference"
      ? [
          entry.appliesWhen === null ? null : `适用：${entry.appliesWhen}`,
          entry.exceptions === null ? null : `例外：${entry.exceptions}`,
        ]
      : [
          entry.whyInteresting === null
            ? null
            : `为何值得保留：${entry.whyInteresting}`,
          entry.openQuestions.length === 0
            ? null
            : `未决问题：${entry.openQuestions.join("；")}`,
        ];
  const kept = parts.filter((part): part is string => part !== null);
  return kept.length === 0 ? null : kept.join("｜");
};

/** The second text a record is scored against: when it applies, not what it says. */
const conditionText = (entry: JournalEntry): string =>
  entry.kind === "preference"
    ? `${entry.appliesWhen ?? ""}\n${entry.exceptions ?? ""}`
    : `${entry.whyInteresting ?? ""}\n${entry.openQuestions.join("\n")}`;

const boundedLimit = (value: number): number =>
  Math.max(1, Math.min(5, Math.trunc(value)));

const entryHashes = tokenHashCache();

/** The fields an entry's two texts are made from: while they are the same, so are its hashes. */
const sourcesOf = (entry: JournalEntry): readonly unknown[] =>
  entry.kind === "preference"
    ? [entry.kind, entry.title, entry.content, entry.appliesWhen, entry.exceptions]
    : [entry.kind, entry.title, entry.content, entry.whyInteresting, ...entry.openQuestions];

/**
 * `languages`: those of the code the choice is about, as canonical ids (normalizedLanguages); null or empty when
 * not known. A preference or idea kept for some languages is recalled only where they meet them; one kept for none
 * holds whatever the code is written in, and so does every one while the languages are not known.
 */
export const buildJournalRecall = (
  entries: JournalEntry[],
  input: MethodologyRecallInput,
  limit = 3,
  languages: readonly string[] | null = null,
): JournalRecallMatch[] => {
  // Code in a language that holds another's is also code in that one: a preference kept for JavaScript holds in
  // TypeScript, one kept for C in C++. Matched on the names alone, the same preference in the same repository came or
  // went by whether the agent named the languages or the bridge worked them out.
  const current = new Set(languages ?? []);
  if (current.has("typescript")) current.add("javascript");
  if (current.has("cpp")) current.add("c");
  const applies = (entry: JournalEntry): boolean =>
    entry.languages.length === 0 || current.size === 0 || entry.languages.some((language) => current.has(language));
  const decisionTokens = tokens(
    `${input.question}\n${input.selectedAnswer ?? ""}\n${input.optionLabels.join("\n")}`,
  );
  const contextTokens = tokens(`${input.question}\n${input.context ?? ""}`);
  const decisionHashes = tokenHashes(decisionTokens);
  const contextHashes = tokenHashes(contextTokens);

  const scored = entries
    // An archived record is one the reader put away; recalling it would undo
    // that. An inbox idea is still unclear, but it is unclear about something
    // they wanted kept, so it stays in.
    .filter((entry) => entry.knowledgeStatus !== "archived" && applies(entry))
    .map((entry) => {
      const [bodyHashes, whenHashes] = entryHashes.hashes(entry.id, sourcesOf(entry), () => [
        `${entry.title}\n${entry.content}`,
        conditionText(entry),
      ]);
      const bodyScore = hashSimilarity(bodyHashes!, decisionHashes);
      const whenScore = hashSimilarity(whenHashes!, contextHashes);
      const score = Math.round(
        Math.max(
          bodyScore * 0.7 + whenScore * 0.3,
          Math.max(bodyScore, whenScore) * 0.74,
        ) * 100,
      );
      return { entry, score };
    });
  entryHashes.settle();

  return scored
    .filter((match) => match.score >= 10)
    .sort(
      (left, right) =>
        right.score - left.score ||
        right.entry.updatedAt.localeCompare(left.entry.updatedAt) ||
        left.entry.id.localeCompare(right.entry.id),
    )
    .slice(0, boundedLimit(limit))
    // The shared terms, from the tokens themselves, only for the few recalled.
    .map(({ entry, score }) => {
      const terms = [
        ...new Set([
          ...matchedTerms(tokens(`${entry.title}\n${entry.content}`), decisionTokens),
          ...matchedTerms(tokens(conditionText(entry)), contextTokens),
        ]),
      ].slice(0, 3);
      return {
        recordId: entry.id,
        kind: entry.kind,
        title: entry.title,
        summary: entry.content,
        standing: JOURNAL_STANDING[entry.kind],
        qualifier: qualifierOf(entry),
        score,
        strength: "possible" as const,
        // Read by the agent the consultation answers, not by the user: "你自己的立场" was the agent's.
        reason: `${KIND_LABEL[entry.kind]}与当前决策存在文本重合${
          terms.length > 0 ? `，共同出现“${terms.join("、")}”` : ""
        }。${
          // Said, so the agent sees what it is kept for: where the languages were not known, it may not apply here.
          entry.languages.length > 0 ? `适用语言：${entry.languages.map(languageLabel).join("、")}。` : ""
        }它不是已采纳原则，只作为用户自己的${KIND_LABEL[entry.kind]}提醒。`,
        matchedTerms: terms,
      };
    });
};
