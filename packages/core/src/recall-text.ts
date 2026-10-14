/**
 * The deterministic scorer behind recall: a Chinese-aware bigram tokenizer,
 * Dice similarity over the token sets, and the shared terms that explain a
 * match to the reader.
 *
 * It lives here because two kinds of record are now recalled the same way —
 * accepted principles and the reader's own preferences and ideas — and a
 * second copy of the tokenizer would let the two drift apart silently.
 * `methodology-evidence-match.ts` keeps its own, slightly different tokenizer;
 * unifying that one would change matches nobody asked to change.
 */
const genericTerms = new Set([
  "一个",
  "以及",
  "已经",
  "以后",
  "仍然",
  "可以",
  "如果",
  "应该",
  "进行",
  "结果",
  "需要",
  "选择",
  "方案",
  "问题",
  "项目",
  "方法",
  "时候",
  "决策",
  "使用",
  "the",
  "and",
  "for",
  "with",
]);

export const tokens = (value: string): Set<string> => {
  const result = new Set<string>();
  const chunks =
    value
      .normalize("NFKC")
      .toLocaleLowerCase("zh-CN")
      // Han runs apart from the words glued to them: "统一用Redis缓存" holds the word redis.
      .match(/\p{Script=Han}+|(?:(?!\p{Script=Han})[\p{Letter}\p{Number}])+/gu) ?? [];
  for (const chunk of chunks.slice(0, 120)) {
    if (/^\p{Script=Han}+$/u.test(chunk)) {
      for (let index = 0; index < chunk.length - 1; index += 1) {
        const token = chunk.slice(index, index + 2);
        if (!genericTerms.has(token)) result.add(token);
      }
    } else if (chunk.length > 1 && !genericTerms.has(chunk)) {
      result.add(chunk);
    }
  }
  return result;
};

/** FNV-1a: a token as the 32-bit number its text's hashes keep. */
const hashed = (token: string): number => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < token.length; index += 1) {
    hash = Math.imul(hash ^ token.charCodeAt(index), 0x01000193);
  }
  return hash | 0;
};

/**
 * A text's tokens as the sorted numbers scoring needs, a tenth of the memory of the tokens themselves.
 * ponytail: two tokens that hash alike count as one; at 32 bits that moves a score a point in a million cases.
 */
export const tokenHashes = (tokenSet: Set<string>): Int32Array => {
  const sorted = Int32Array.from(tokenSet, hashed).sort();
  return sorted.filter((hash, index) => index === 0 || hash !== sorted[index - 1]);
};

/** similarity, over two texts' tokenHashes. */
export const hashSimilarity = (left: Int32Array, right: Int32Array): number => {
  if (left.length === 0 || right.length === 0) return 0;
  let shared = 0;
  for (let leftIndex = 0, rightIndex = 0; leftIndex < left.length && rightIndex < right.length;) {
    const leftHash = left[leftIndex]!;
    const rightHash = right[rightIndex]!;
    if (leftHash === rightHash) shared += 1;
    if (leftHash <= rightHash) leftIndex += 1;
    if (rightHash <= leftHash) rightIndex += 1;
  }
  return (2 * shared) / (left.length + right.length);
};

/**
 * Each record's texts as tokenHashes, kept by its id while the fields they were made from are the same: worked out
 * again for every record on every consultation, five thousand preferences and ideas held the main process for a
 * fifth of a second each time an agent asked. Kept as tokens, they took 40 MB. `settle()`, after a pass over every
 * record, lets go of those the pass did not ask for: a record deleted or archived since stayed until a restart.
 */
export const tokenHashCache = () => {
  const kept = new Map<string, { sources: readonly unknown[]; hashes: Int32Array[] }>();
  const asked = new Set<string>();
  return {
    hashes: (id: string, sources: readonly unknown[], texts: () => string[]): Int32Array[] => {
      asked.add(id);
      const known = kept.get(id);
      if (known !== undefined && known.sources.length === sources.length && known.sources.every((source, index) => source === sources[index])) {
        return known.hashes;
      }
      const hashes = texts().map((text) => tokenHashes(tokens(text)));
      kept.set(id, { sources, hashes });
      return hashes;
    },
    settle: (): void => {
      for (const id of kept.keys()) if (!asked.has(id)) kept.delete(id);
      asked.clear();
    },
  };
};

export const similarity = (left: Set<string>, right: Set<string>): number => {
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const token of left) {
    if (right.has(token)) shared += 1;
  }
  return (2 * shared) / (left.size + right.size);
};

export const matchedTerms = (left: Set<string>, right: Set<string>): string[] =>
  [...left]
    .filter((token) => right.has(token) && !genericTerms.has(token))
    .sort(
      (first, second) =>
        second.length - first.length || first.localeCompare(second, "zh-CN"),
    )
    .slice(0, 3);
