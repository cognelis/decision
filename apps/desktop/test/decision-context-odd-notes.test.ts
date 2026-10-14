import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decisionContextQuerySchema } from "@cognelis/decision-protocol";
import { afterEach, describe, expect, it } from "vitest";

import { DecisionContextRepository, MarkdownRepository, type DecisionContextDocument } from "@cognelis/decision-storage";
import { recordFixture } from "../../../packages/storage/test/fixtures.js";
import { DecisionContextService } from "../src/main/decision-context-service.js";

const roots: string[] = [];
const makeVault = async () => {
  const root = await mkdtemp(join(tmpdir(), "r34c-empty-supersedes-"));
  roots.push(root);
  await mkdir(join(root, "Decision Journal", "summarize"), { recursive: true });
  return root;
};
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

// A recorded decision whose `supersedes` was cleared by hand to "" (a template, or a property editor that writes an
// empty string) parses as a predecessor named "", and every search whose page holds it fails on the response schema.
describe("decisions note with supersedes: \"\"", () => {
  it("is set aside or read as having no predecessor, not a crash of every search", async () => {
    const vault = await makeVault();
    const written = await new MarkdownRepository(vault).write(recordFixture());
    const edited = (await readFile(written.path, "utf8")).replace(/^supersedes: .*$/mu, 'supersedes: ""');
    expect(edited).not.toBe(await readFile(written.path, "utf8"));
    await writeFile(written.path, edited);
    await writeFile(join(vault, "Decision Journal/summarize/A.md"), [
      "---", "id: DEC-A", "created: 2026-09-01", "status: accepted", "selected_option: 用 Markdown 存。", "project: decision", "---", "# Markdown", "", "用 Markdown 存。", "",
    ].join("\n"));

    const repository = new DecisionContextRepository(vault);
    const service = new DecisionContextService(repository);
    const snapshot = await repository.scan();
    const broken = snapshot.documents.find((doc) => doc.kind === "recorded_decision");

    // The legacy note DEC-A is on the same page: the search for it throws (ZodError on supersedes[0] min 1).
    const response = await service.search(decisionContextQuerySchema.parse({ query: "Markdown" }));
    expect(response.status).toBe("matched");
    expect(response.results.map((item) => item.id)).toContain("DEC-A");
  });
});

// Same root cause from another field: the question text deleted in Obsidian (the heading kept) reads as "", and
// the result's title must have one character.
describe("decisions note whose 决策点 text was deleted", () => {
  it("is set aside, not a crash of every search", async () => {
    const vault = await makeVault();
    const written = await new MarkdownRepository(vault).write(recordFixture());
    const edited = (await readFile(written.path, "utf8")).replace("# 决策点\n\nMarkdown 还是数据库？\n\n## 可选方案", "# 决策点\n\n\n\n## 可选方案");
    expect(edited).not.toBe(await readFile(written.path, "utf8"));
    await writeFile(written.path, edited);
    await writeFile(join(vault, "Decision Journal/summarize/A.md"), [
      "---", "id: DEC-A", "created: 2026-09-01", "status: accepted", "selected_option: 用 Markdown 存。", "project: decision", "---", "# Markdown", "", "用 Markdown 存。", "",
    ].join("\n"));
    const repository = new DecisionContextRepository(vault);
    const snapshot = await repository.scan();
    const response = await new DecisionContextService(repository).search(decisionContextQuerySchema.parse({ query: "Markdown" }));
    expect(response.results.map((item) => item.id)).toContain("DEC-A");
  });
});

// Same root cause from another field: the result's warnings are built without a cap, and the response schema
// allows ten. A legacy record replaced by several decisions that were each replaced in turn gets one warning per
// successor, and the page it is on fails as a whole.
describe("record with many replaced successors", () => {
  const document = (id: string, overrides: Partial<DecisionContextDocument> = {}): DecisionContextDocument => ({
    id, source: "summarize", kind: "historical_decision", title: `${id} 列表稳定标识`, project: "web", status: "accepted",
    created: "2026-09-01", summary: "可排序列表采用稳定的业务标识。", appliesWhen: null, caution: null,
    tags: [], supersedes: [], supersededBy: [], relativePath: `Decision Journal/summarize/${id}.md`,
    client: null, sessionId: null, body: "# 列表标识\n\n使用稳定业务标识。", bodyStartLine: 4, ...overrides,
  });
  it("is listed with its warnings capped rather than failing the search", async () => {
    const successors = Array.from({ length: 9 }, (_, i) => `DEC-B${i}`);
    const documents = [
      document("DEC-A", { supersededBy: successors }),
      ...successors.map((id) => document(id, { status: "superseded", supersededBy: ["DEC-FINAL"] })),
      document("DEC-FINAL"),
    ];
    const service = new DecisionContextService({ scan: async () => ({ documents, sources: [{ source: "summarize", records: documents.length, skipped: 0, status: "ready" }] }) });
    const response = await service.search(decisionContextQuerySchema.parse({ query: "列表标识", limit: 20 }));
    expect(response.results.map((item) => item.id)).toContain("DEC-A");
  });
});
