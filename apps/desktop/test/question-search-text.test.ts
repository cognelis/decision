import { createManualDecisionRecord } from "@cognelis/decision-core";
import { SqliteIndex } from "@cognelis/decision-storage";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

import { questionSearchText } from "../src/renderer/components/pages/decisions/SameQuestionDecisions.js";

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
