import * as storage from "@cognelis/decision-storage";
import { randomBytes } from "node:crypto";
import { lstat, mkdtemp, readFile, readdir, rm, stat, unlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";

import { OrganizationDamagedError, OrganizationStore, emptyOrganizationState } from "../src/main/organization-store.js";
import { capacityState } from "./organization-capacity-fixture.js";

const roots: string[] = [];
const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), "paraself-capacity-")); roots.push(root);
  const path = join(root, "state.json");
  return { root, path, store: new OrganizationStore(path) };
};
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const envelope = (text: string) => ({ version: 2, compression: "gzip", data: gzipSync(text).toString("base64") });

describe("RSI-12: lossless organization capacity", () => {
  it('refreshes cached text after another store changes a refusal or forgetting receipt', async () => {
    const { path, store } = await fixture();
    await store.update(() => ({ state: capacityState(1), value: null }));
    const earlier = await store.read();
    const other = new OrganizationStore(path);
    await other.update(state => {
      state.ledger.forgotten['decision:newly-forgotten'] = '2026-11-15T01:00:00.000Z';
      state.suggestions['history-0']!.receipts.push({ action: 'reject', at: '2026-11-15T01:00:00.000Z', revision: 2, note: 'independent newer refusal' });
      return { state, value: null };
    });
    expect(await store.read()).toEqual(await other.read());
    expect(earlier.ledger.forgotten['decision:newly-forgotten']).toBeUndefined();
  });
  it('detects an in-place same-size edit even when modification time is restored', async () => {
    const { path, store } = await fixture(); const seed = capacityState(1);
    seed.settings.backgroundProfileId = 'one';
    await store.update(() => ({ state: seed, value: null }));
    const fixed = Date.UTC(2026, 10, 15) / 1000;
    await utimes(path, fixed, fixed); await store.read();
    const before = await lstat(path, { bigint: true });
    await writeFile(path, (await readFile(path, 'utf8')).replace('"one"', '"two"'));
    await utimes(path, fixed, fixed);
    const after = await lstat(path, { bigint: true });
    expect(after.ino).toBe(before.ino); expect(after.size).toBe(before.size); expect(after.mtimeNs).toBe(before.mtimeNs);
    expect((await store.read()).settings.backgroundProfileId).toBe('two');
  });
  it('does not fall back to cached text after corruption or deletion', async () => {
    const { path, store } = await fixture();
    await store.update(() => ({ state: capacityState(1), value: null }));
    const original = await readFile(path, 'utf8'); await store.read();
    await writeFile(path, '{');
    await expect(store.read()).rejects.toBeInstanceOf(OrganizationDamagedError);
    await expect(store.update(state => ({ state, value: null }))).rejects.toBeInstanceOf(OrganizationDamagedError);
    expect(await readFile(path, 'utf8')).toBe('{');
    await writeFile(path, original); expect((await store.read()).suggestions).toEqual(capacityState(1).suggestions);
    await unlink(path); expect(await store.read()).toEqual(emptyOrganizationState());
  });
  it('keeps concurrent readers independent while sharing only immutable text', async () => {
    const { store } = await fixture();
    await store.update(() => ({ state: capacityState(1600), value: null }));
    const [first, second] = await Promise.all([store.read(), store.read()]);
    first.ledger.forgotten = {}; first.suggestions['history-0']!.receipts.length = 0;
    const before = first.suggestions['history-0']!.apply!.steps[0]!.before as { body: { observation: string } };
    before.body.observation = 'changed only in this reader';
    expect(second.suggestions['history-0']!.receipts).toHaveLength(3);
    expect(second.suggestions['history-0']!.apply!.steps[0]!.before).toEqual(capacityState(1).suggestions['history-0']!.apply!.steps[0]!.before);
    expect((await store.read()).ledger.forgotten).toEqual(second.ledger.forgotten);
  });
  it('keeps reads and returned mutation values independent without an extra clone', async () => {
    const { path, store } = await fixture(); const seed = capacityState(1);
    await store.update(() => ({ state: seed, value: null }));
    const before = await readFile(path, 'utf8'); const earlier = await store.read();
    await expect(store.update(state => {
      state.suggestions['history-0']!.receipts.length = 0;
      state.ledger.forgotten = {};
      throw new Error('synthetic callback failure');
    })).rejects.toThrow('synthetic callback failure');
    expect(await readFile(path, 'utf8')).toBe(before);
    const returned = await store.update(state => ({ state, value: state }));
    returned.suggestions['history-0']!.receipts.length = 0;
    returned.ledger.forgotten = {};
    const saved = await store.read();
    expect(saved.suggestions).toEqual(seed.suggestions);
    expect(saved.ledger.forgotten).toEqual(seed.ledger.forgotten);
    expect(earlier.revision).toBe(1);
    expect(saved.revision).toBe(2);
  });
  it('does not let write observers change the immutable committed text', async () => {
    const { path } = await fixture(); const seed = capacityState(1);
    const store = new OrganizationStore(path, state => {
      state.ledger.forgotten = {};
      state.suggestions['history-0']!.receipts.length = 0;
    });
    await store.update(() => ({ state: seed, value: null }));
    expect((await store.read()).suggestions).toEqual(seed.suggestions);
    expect((await store.read()).ledger.forgotten).toEqual(seed.ledger.forgotten);
  });
  it("persists a state beyond the old limit without losing choices, receipts or recovery plans", async () => {
    const { path, store } = await fixture();
    const state = capacityState(1600);
    expect(Buffer.byteLength(JSON.stringify(state))).toBeGreaterThan(8 * 1024 * 1024);
    await store.update(() => ({ state, value: null }));
    expect((await stat(path)).size).toBeLessThanOrEqual(8 * 1024 * 1024);
    expect(await new OrganizationStore(path).read()).toEqual({ ...state, revision: 1 });
  });

  it("keeps small states readable as the original v1 JSON", async () => {
    const { path, store } = await fixture();
    const state = capacityState(1);
    await store.update(() => ({ state, value: null }));
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ ...state, revision: 1 });
  });

  it("can return to v1 after content is explicitly removed, keeping remaining receipts", async () => {
    const { path, store } = await fixture();
    await store.update(() => ({ state: capacityState(1600), value: null }));
    expect(JSON.parse(await readFile(path, "utf8")).version).toBe(2);
    await store.update(state => { state.suggestions = { retained: state.suggestions['history-0']! }; return { state, value: null }; });
    const raw = JSON.parse(await readFile(path, "utf8"));
    expect(raw.version).toBe(1);
    expect(raw.ledger.forgotten).toEqual(capacityState(0).ledger.forgotten);
    expect(raw.suggestions.retained).toEqual(capacityState(1).suggestions['history-0']);
  });

  it.each([
    { version: 2, compression: 'gzip', data: 'not base64!' },
    { version: 2, compression: 'gzip', data: Buffer.from('not gzip').toString('base64') },
    { ...envelope(JSON.stringify(emptyOrganizationState())), extra: 'unknown field' },
    envelope('{"version":99}'),
    { ...envelope(JSON.stringify(emptyOrganizationState())), data: envelope(JSON.stringify(emptyOrganizationState())).data.slice(0, -8) },
  ])('refuses damaged compressed state without replacing it (%#)', async damaged => {
    const { path, store } = await fixture();
    const original = JSON.stringify(damaged);
    await writeFile(path, original);
    await expect(store.read()).rejects.toBeInstanceOf(OrganizationDamagedError);
    await expect(store.update(() => ({ state: emptyOrganizationState(), value: null }))).rejects.toBeInstanceOf(OrganizationDamagedError);
    expect(await readFile(path, 'utf8')).toBe(original);
  });

  it('bounds actual decompression even when the compressed file is small', async () => {
    const { path, store } = await fixture();
    const original = JSON.stringify(envelope(`${JSON.stringify(emptyOrganizationState())}${' '.repeat(64 * 1024 * 1024)}`));
    await writeFile(path, original);
    await expect(store.read()).rejects.toBeInstanceOf(OrganizationDamagedError);
    expect(await readFile(path, 'utf8')).toBe(original);
  });

  it('still refuses an incompressible envelope above the physical limit without changing the current file', async () => {
    const { path, store } = await fixture();
    await store.update(() => ({ state: capacityState(1), value: null }));
    const original = await readFile(path, 'utf8');
    await expect(store.update(state => {
      state.suggestions['history-0']!.apply!.steps[0]!.before = randomBytes(7 * 1024 * 1024).toString('base64');
      return { state, value: null };
    })).rejects.toThrow('大小上限');
    expect(await readFile(path, 'utf8')).toBe(original);
  });

  it('refuses content beyond the expanded bound even if it would compress well', async () => {
    const { path, store } = await fixture();
    await store.update(() => ({ state: capacityState(1), value: null }));
    const original = await readFile(path, 'utf8');
    await expect(store.update(state => {
      state.suggestions['history-0']!.apply!.steps[0]!.before = 'x'.repeat(64 * 1024 * 1024);
      return { state, value: null };
    })).rejects.toThrow('大小上限');
    expect(await readFile(path, 'utf8')).toBe(original);
  });

  it('keeps the committed state on replacement failure and ignores an interrupted temporary write', async () => {
    const { root, path, store } = await fixture();
    await store.update(() => ({ state: capacityState(1), value: null }));
    const original = await readFile(path, 'utf8');
    vi.spyOn(storage, 'renameReplacing').mockRejectedValueOnce(new Error('synthetic replacement failure'));
    await expect(store.update(() => ({ state: capacityState(1600), value: null }))).rejects.toThrow('synthetic replacement failure');
    expect(await readdir(root)).toEqual(['state.json']);
    expect(await readFile(path, 'utf8')).toBe(original);
    await writeFile(`${path}.interrupted.tmp`, '{"version":2,"data":"partial');
    const restarted = new OrganizationStore(path);
    expect(await restarted.read()).toEqual(JSON.parse(original));
    await restarted.update(() => ({ state: capacityState(1600), value: null }));
    expect(Object.keys((await restarted.read()).suggestions)).toHaveLength(1600);
  });
});
