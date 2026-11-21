import { createManualDecisionRecord } from "@cognelis/decision-core";
import { SqliteIndex } from "@cognelis/decision-storage";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

import {
  listSameQuestionAnswers,
  questionSearchText,
  sameQuestionAnswers,
  sameQuestionSearchText,
} from "../src/renderer/components/pages/decisions/SameQuestionDecisions.js";
import type { DecisionLibraryItem } from "../src/shared/renderer-api.js";

it("finds every writing of a question, spaced between Chinese and Latin words or not", async () => {
  const index = new SqliteIndex(join(await mkdtemp(join(tmpdir(), "question-search-")), "index.sqlite"));
  const writings = ["是否使用 Redis 缓存会话？", "是否使用Redis缓存会话？"];
  writings.forEach((question, n) =>
    index.upsert({
      id: `d${n}`,
      path: `/vault/d${n}.md`,
      contentHash: `h${n}`,
      record: createManualDecisionRecord(
        { question, decision: "先做", project: "Decision", sourceKind: "app_manual", sourceForm: "user_original" },
        `d${n}`,
        new Date(2026, 8, 29 + n),
      ),
    }),
  );
  try {
    for (const question of writings) {
      const found = index.queryDecisions({ query: questionSearchText(question), limit: 50 });
      expect(found.map(({ id }) => id).sort()).toEqual(["d0", "d1"]);
    }
  } finally {
    index.close();
  }
});

it("finds every writing of a question, spaced between Chinese words or not", async () => {
  const index = new SqliteIndex(join(await mkdtemp(join(tmpdir(), "question-search-")), "index.sqlite"));
  const writings = ["部署前 要不要先跑全量回归？", "部署前要不要先跑全量回归？", "部署前要不要 先跑全量回归？"];
  writings.forEach((question, n) =>
    index.upsert({
      id: `d${n}`,
      path: `/vault/d${n}.md`,
      contentHash: `h${n}`,
      record: createManualDecisionRecord(
        { question, decision: "先跑", project: "Decision", sourceKind: "app_manual", sourceForm: "user_original" },
        `d${n}`,
        new Date(2026, 8, 29 + n),
      ),
    }),
  );
  try {
    // One question, as questionKey says, each found from the others: searched for as written, the unspaced one found
    // neither spaced writing, and each spaced one missed the other.
    for (const [n, question] of writings.entries()) {
      const found = index.queryDecisions({ query: sameQuestionSearchText(question), limit: 50 });
      const others = sameQuestionAnswers(found as unknown as DecisionLibraryItem[], question, `d${n}`);
      expect(others.map(({ id }) => id).sort(), `asked as「${question}」`).toEqual(["d0", "d1", "d2"].filter((id) => id !== `d${n}`));
    }
  } finally {
    index.close();
  }
});

it("lists the earlier answer to the very question among many newer ones holding its characters", async () => {
  const index = new SqliteIndex(join(await mkdtemp(join(tmpdir(), "question-search-")), "index.sqlite"));
  const recorded = (id: string, question: string, day: number) =>
    index.upsert({
      id,
      path: `/vault/${id}.md`,
      contentHash: id,
      record: createManualDecisionRecord(
        { question, decision: "方案 A", project: "Decision", sourceKind: "app_manual", sourceForm: "user_original" },
        id,
        new Date(2026, 6, day),
      ),
    });
  recorded("earlier", "选哪个方案？", 1);
  for (let n = 0; n < 60; n += 1) recorded(`newer-${n}`, `第 ${n} 个模块里方案 A 和方案 B 选哪个？`, 2 + (n % 25));
  try {
    // Looked for by character alone, sixty newer questions held each of them, ranked as high, and the fifty listed,
    // newest first, left the very question out.
    const found = await listSameQuestionAnswers(
      async (input) => index.queryDecisions({ query: input.query ?? "", limit: 50 }) as unknown as DecisionLibraryItem[],
      "选哪个方案？",
      "now",
    );
    expect(found.map(({ id }) => id)).toEqual(["earlier"]);
  } finally {
    index.close();
  }
});
