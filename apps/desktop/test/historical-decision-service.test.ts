import { HISTORICAL_DECISION_REFUSALS, RationaleQueue } from "@cognelis/decision-core";
import { HISTORICAL_DECISION_VERSION as version, type HistoricalDecision } from "@cognelis/decision-protocol";
import { HistoricalDecisionRepository } from "@cognelis/decision-storage";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { HistoricalDecisionService } from "../src/main/historical-decision-service.js";
import { LocalCaptureServer } from "../src/main/local-server.js";

const token = "historical-token-".padEnd(64, "x");

const setup = async () => {
  const vault = await mkdtemp(join(tmpdir(), "paraself-historical-"));
  await mkdir(join(vault, "Decision Journal"), { recursive: true });
  let ids = 0;
  let minutes = 0;
  const onWritten = vi.fn();
  const promote = vi.fn(async (record: HistoricalDecision) => `decision-of-${record.id}`);
  const indexPath = join(`${vault}-app`, "historical-decisions.sqlite");
  const service = new HistoricalDecisionService({
    repository: new HistoricalDecisionRepository(vault, { existingVault: true }),
    indexPath,
    idFactory: () => `${++ids}`,
    clock: () => new Date(Date.UTC(2026, 10, 21, 3, minutes++)),
    promote,
    onWritten,
  });
  return { vault, service, onWritten, promote, indexPath };
};

const old = { version, sourceClient: null, title: "首页待办入口放在哪一层？", decision: "放在首页卡片区第二屏", decidedOn: "2026-09-30", project: "decision" } as const;
const next = { ...old, decision: "放进主导航第六项，首页只留计数", decidedOn: "2026-11-12", supersedesId: "hdec-1" } as const;
const all = { version, includeWithdrawn: true } as const;

describe("HistoricalDecisionService", () => {
  it("keeps a record as a note under its own folder, lists it from the index, and answers a repeat with the one kept", async () => {
    const { vault, service, onWritten } = await setup();
    const saved = await service.record({ ...old, sourceClient: "codex", tags: ["信息架构"] });
    expect(saved).toMatchObject({ status: "created", supersededId: null, record: { id: "hdec-1", status: "active", sourceKind: "agent_capture", sourceClient: "codex", revision: 1 } });
    expect(await readdir(join(vault, "Decision Journal"))).toEqual(["history"]);
    expect(await readdir(join(vault, "Decision Journal", "history", "2026"))).toHaveLength(1);

    const listed = await service.list({ version });
    expect(listed).toMatchObject({ total: 1, kept: 1, projects: ["decision"], tags: ["信息架构"], diagnostics: [], index: { state: "ready", indexed: 1, found: 1 } });
    expect(listed.records[0]).toEqual(saved.record);

    expect(await service.record({ ...old, title: " 首页待办入口放在哪一层？ " })).toMatchObject({ status: "duplicate", record: { id: "hdec-1" } });
    expect(onWritten).toHaveBeenCalledTimes(1);
    service.close();
  });

  it("marks the record a new one replaces, shows the chain from both ends, and lets go of it when the old one is active again", async () => {
    const { service } = await setup();
    await service.record(old);
    expect(await service.record(next)).toMatchObject({ status: "created", supersededId: "hdec-1", record: { id: "hdec-2", supersedesId: "hdec-1" } });

    const replaced = await service.get({ version, id: "hdec-1" });
    expect(replaced).toMatchObject({ record: { status: "superseded", revision: 2 }, predecessor: null, successors: [{ id: "hdec-2", status: "active" }] });
    expect(replaced.history.map((event) => [event.kind, event.summary])).toEqual([["superseded", "被「首页待办入口放在哪一层？」替代"], ["created", "记录"]]);
    expect(await service.get({ version, id: "hdec-2" })).toMatchObject({ predecessor: { id: "hdec-1", status: "superseded" }, successors: [] });

    // The old one may not take the new one's place in turn: that would close the chain into a ring.
    await expect(service.update({ version, sourceClient: null, id: "hdec-1", expectedRevision: 2, supersedesId: "hdec-2" })).rejects.toThrow(HISTORICAL_DECISION_REFUSALS.loop);

    expect(await service.update({ version, sourceClient: null, id: "hdec-1", expectedRevision: 2, expectedStatus: "superseded", status: "active" })).toMatchObject({ record: { status: "active" }, releasedIds: ["hdec-2"] });
    expect(await service.get({ version, id: "hdec-2" })).toMatchObject({ record: { supersedesId: null, revision: 2 }, predecessor: null });
    service.close();
  });

  it("refuses a change made on a copy that is no longer the latest, and anything but a new status for a withdrawn record", async () => {
    const { service } = await setup();
    await service.record(old);
    const change = { version, sourceClient: "claude-code", id: "hdec-1" } as const;
    expect(await service.update({ ...change, expectedRevision: 1, scope: "桌面端导航", notes: "图标沿用待办页的" })).toMatchObject({ record: { revision: 2, scope: "桌面端导航" } });
    await expect(service.update({ ...change, expectedRevision: 1, scope: "别处" })).rejects.toThrow(HISTORICAL_DECISION_REFUSALS.changedSince);
    await expect(service.update({ ...change, expectedRevision: 2, expectedStatus: "ended", status: "withdrawn" })).rejects.toThrow(HISTORICAL_DECISION_REFUSALS.changedSince);

    await service.update({ ...change, expectedRevision: 2, expectedStatus: "active", status: "withdrawn", statusNote: "记录有误" });
    expect((await service.list({ version })).total).toBe(0);
    expect(await service.list(all)).toMatchObject({ total: 1, records: [{ status: "withdrawn", statusNote: "记录有误" }] });
    await expect(service.update({ ...change, expectedRevision: 3, title: "改个标题" })).rejects.toThrow(HISTORICAL_DECISION_REFUSALS.readOnly);
    // Withdrawn, it no longer stands in the way of recording the same matter again.
    expect(await service.record(old)).toMatchObject({ status: "created", record: { id: "hdec-2" } });
    expect(await service.update({ ...change, expectedRevision: 3, expectedStatus: "withdrawn", status: "active", title: "改个标题" })).toMatchObject({ record: { status: "active", title: "改个标题" } });
    const history = (await service.get({ version, id: "hdec-1" })).history;
    expect(history.map((event) => `${event.actor}:${event.kind}:${event.summary}`)).toEqual([
      "claude-code:status:状态：已撤回 → 有效；修改：决定事项", "claude-code:status:状态：有效 → 已撤回", "claude-code:updated:修改：影响范围、补充备注", "app:created:记录",
    ]);
    // Each field rewritten, with what it read before: the withdrawal's note too, as part of the status.
    expect(history.map((event) => event.changes)).toEqual([
      [{ field: "决定事项", before: old.title, after: "改个标题" }],
      [{ field: "状态说明", before: "", after: "记录有误" }],
      [{ field: "影响范围", before: "", after: "桌面端导航" }, { field: "补充备注", before: "", after: "图标沿用待办页的" }],
      undefined,
    ]);
    service.close();
  });

  it("makes a decision record of one once, from the record as the same change leaves it", async () => {
    const { service, promote } = await setup();
    await service.record(old);
    const promoted = await service.update({ version, sourceClient: null, id: "hdec-1", expectedRevision: 1, context: "待办刚上线两周", promote: true });
    expect(promoted).toMatchObject({ promotedDecisionId: "decision-of-hdec-1", record: { promotedDecisionId: "decision-of-hdec-1", context: "待办刚上线两周", status: "active" } });
    expect(promote.mock.calls[0]![0]).toMatchObject({ id: "hdec-1", context: "待办刚上线两周", promotedDecisionId: null });
    await expect(service.update({ version, sourceClient: null, id: "hdec-1", expectedRevision: 2, promote: true })).rejects.toThrow(HISTORICAL_DECISION_REFUSALS.promotedAlready);
    expect(promote).toHaveBeenCalledTimes(1);
    expect(await service.list({ version, promotedDecisionId: "decision-of-hdec-1" })).toMatchObject({ total: 1 });
    service.close();
  });

  it("follows what is changed in Obsidian, and says which notes it could not read", async () => {
    const { vault, service } = await setup();
    await service.record(old);
    const folder = join(vault, "Decision Journal", "history", "2026");
    const [name] = await readdir(folder);
    const note = await readFile(join(folder, name!), "utf8");
    await writeFile(join(folder, name!), note.replace("status: active", "status: ended"), "utf8");
    await writeFile(join(folder, "broken.md"), "---\ntype: [\n---\n", "utf8");
    const listed = await service.list({ version, status: "ended" });
    expect(listed).toMatchObject({ total: 1, kept: 1, index: { state: "ready" } });
    expect(listed.diagnostics).toEqual([{ path: "Decision Journal/history/2026/broken.md", message: "属性区无法解析" }]);
    service.close();
  });

  it("says so when its index cannot be read, lists nothing made up, and makes the index again from the notes", async () => {
    const { service, indexPath } = await setup();
    await service.record(old);
    service.close();
    await writeFile(indexPath, "not a database", "utf8");
    expect(await service.list({ version })).toMatchObject({ records: [], total: 0, kept: 1, index: { state: "unavailable", found: 1, indexed: null } });
    expect(await service.rebuildIndex()).toMatchObject({ index: { state: "ready", indexed: 1, found: 1 } });
    expect(await service.list({ version })).toMatchObject({ total: 1, index: { state: "ready" } });
    service.close();
  });

  it("serves agents over the authenticated local routes, and tells them why a change is refused", async () => {
    const { service } = await setup();
    const server = new LocalCaptureServer({
      queue: new RationaleQueue(),
      token,
      recordHistoricalDecision: (request) => service.record(request),
      listHistoricalDecisions: (request) => service.list(request),
      getHistoricalDecision: (request) => service.get(request),
      updateHistoricalDecision: (request) => service.update(request),
    });
    const { host, port } = await server.start();
    const post = (path: string, body: unknown, auth = true) =>
      fetch(`http://${host}:${port}/v1/historical-decisions${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(auth ? { authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify(body),
      });
    try {
      expect((await post("", { ...old, sourceClient: "codex" }, false)).status).toBe(401);
      expect(await (await post("", { ...old, sourceClient: "codex" })).json()).toMatchObject({ status: "created", record: { id: "hdec-1" } });
      expect((await post("", { ...old, sourceClient: "codex", rationale: "不收理由" })).status).toBe(400);
      expect(await (await post("/query", { version })).json()).toMatchObject({ total: 1 });
      expect(await (await post("/get", { version, id: "hdec-1" })).json()).toMatchObject({ record: { title: old.title }, notePath: expect.stringMatching(/^Decision Journal\/history\/2026\//u) });
      const refused = await post("/update", { version, sourceClient: "codex", id: "hdec-1", expectedRevision: 9, scope: "别处" });
      expect(refused.status).toBe(500);
      expect(await refused.json()).toMatchObject({ message: HISTORICAL_DECISION_REFUSALS.changedSince });
    } finally {
      await server.stop();
      service.close();
    }
  });
});
