import { HISTORICAL_DECISION_REFUSALS, historicalChangeSummary, historicalDecisionLink as link, planHistoricalDecisionRecord, planHistoricalDecisionUpdate } from "@cognelis/decision-core";
import {
  getHistoricalDecisionRequestSchema,
  getHistoricalDecisionResultSchema,
  HISTORICAL_DECISION_VERSION,
  listHistoricalDecisionsRequestSchema,
  recordHistoricalDecisionRequestSchema,
  updateHistoricalDecisionRequestSchema,
  type GetHistoricalDecisionRequest,
  type GetHistoricalDecisionResult,
  type HistoricalDecision,
  type HistoricalDecisionEvent,
  type HistoricalDecisionIndexState,
  type ListHistoricalDecisionsRequest,
  type ListHistoricalDecisionsResult,
  type RebuildHistoricalDecisionIndexResult,
  type RecordHistoricalDecisionRequest,
  type RecordHistoricalDecisionResult,
  type UpdateHistoricalDecisionRequest,
  type UpdateHistoricalDecisionResult,
} from "@cognelis/decision-protocol";
import { HistoricalDecisionIndex, type HistoricalDecisionRepository, type HistoricalDecisionScan, type StoredHistoricalDecision } from "@cognelis/decision-storage";
import { existsSync, renameSync } from "node:fs";

export interface HistoricalDecisionServiceOptions {
  repository: Pick<HistoricalDecisionRepository, "scan" | "create" | "revise">;
  /** The index's own file, beside the App and outside the vault. */
  indexPath: string;
  idFactory: () => string;
  clock?: () => Date;
  /** Makes a decision record from one of these and answers with its id. */
  promote?(record: HistoricalDecision): Promise<string>;
  /** Told each time a record is written, by an agent or on the page: a list in view reads again. */
  onWritten?(): void;
}

/**
 * 历史决定 for the page and for agents: one way to read them, one way to change them. The notes in the vault are
 * the facts; the index beside the App is brought up to them at every list, and keeps each record's history of
 * changes. Every write waits for the one before it.
 *
 * Nothing here writes a decision record, a vector or a review date: a record becomes one only by `promote`.
 */
export class HistoricalDecisionService {
  readonly #repository: HistoricalDecisionServiceOptions["repository"];
  readonly #indexPath: string;
  readonly #idFactory: () => string;
  readonly #clock: () => Date;
  readonly #promote: HistoricalDecisionServiceOptions["promote"];
  readonly #onWritten: () => void;
  #index: HistoricalDecisionIndex | null = null;
  #writeTail: Promise<unknown> = Promise.resolve();

  constructor(options: HistoricalDecisionServiceOptions) {
    this.#repository = options.repository;
    this.#indexPath = options.indexPath;
    this.#idFactory = options.idFactory;
    this.#clock = options.clock ?? (() => new Date());
    this.#promote = options.promote;
    this.#onWritten = options.onWritten ?? (() => undefined);
  }

  async list(input: ListHistoricalDecisionsRequest): Promise<ListHistoricalDecisionsResult> {
    const { version: _version, ...filters } = listHistoricalDecisionsRequestSchema.parse(input);
    const scan = await this.#repository.scan();
    const diagnostics = scan.diagnostics.slice(0, 200).map((diagnostic) => ({ path: diagnostic.path.slice(0, 2_000), message: diagnostic.message.slice(0, 1_000) }));
    try {
      const index = this.#opened();
      index.sync(scan.records, this.#clock());
      const { records, total } = index.query(filters);
      const { kept, projects, tags } = index.facets();
      return { version: HISTORICAL_DECISION_VERSION, records, total, kept, projects, tags, diagnostics, index: { state: "ready", message: null, indexed: kept, found: scan.records.length, syncedAt: index.syncedAt() } };
    } catch (error) {
      // The notes are all still there: the list is not made up from memory, and says how to get the index back.
      return { version: HISTORICAL_DECISION_VERSION, records: [], total: 0, kept: scan.records.length, projects: [], tags: [], diagnostics, index: this.#unavailable(error, scan) };
    }
  }

  async get(input: GetHistoricalDecisionRequest): Promise<GetHistoricalDecisionResult> {
    const { id } = getHistoricalDecisionRequestSchema.parse(input);
    const scan = await this.#repository.scan();
    const stored = this.#found(scan, id);
    const predecessor = stored.record.supersedesId === null ? undefined : scan.records.find((item) => item.record.id === stored.record.supersedesId);
    return getHistoricalDecisionResultSchema.parse({
      version: HISTORICAL_DECISION_VERSION,
      record: stored.record,
      predecessor: predecessor === undefined ? null : link(predecessor.record),
      successors: scan.records.filter((item) => item.record.supersedesId === id).slice(0, 20).map((item) => link(item.record)),
      notePath: stored.notePath,
      history: this.#history(id),
    });
  }

  // Each is async so that input refused by its schema is a rejected promise, as a failed write is, never a throw.

  async record(input: RecordHistoricalDecisionRequest): Promise<RecordHistoricalDecisionResult> {
    const { version: _version, ...request } = recordHistoricalDecisionRequestSchema.parse(input);
    return this.#enqueue(async () => {
      const scan = await this.#repository.scan();
      const now = this.#clock();
      const actor = request.sourceClient ?? "app";
      const plan = planHistoricalDecisionRecord(scan.records.map((item) => item.record), request, `hdec-${this.#idFactory()}`, now);
      const record = plan.status === "duplicate" ? plan.record : (await this.#repository.create(plan.record)).record;
      if (plan.status === "created") this.#remember(record.id, { at: now.toISOString(), actor, kind: "created", summary: "记录" });
      try {
        if (plan.superseded !== null) await this.#rewrite(scan, plan.superseded, { at: now.toISOString(), actor, kind: "superseded", summary: `被「${record.title}」替代` });
      } finally {
        if (plan.status === "created" || plan.superseded !== null) this.#onWritten();
      }
      return { version: HISTORICAL_DECISION_VERSION, status: plan.status, record, supersededId: plan.superseded?.id ?? null };
    });
  }

  async update(input: UpdateHistoricalDecisionRequest): Promise<UpdateHistoricalDecisionResult> {
    const { version: _version, sourceClient, ...request } = updateHistoricalDecisionRequestSchema.parse(input);
    return this.#enqueue(async () => {
      const scan = await this.#repository.scan();
      const records = scan.records.map((item) => item.record);
      const now = this.#clock();
      const actor = sourceClient ?? "app";
      // Planned first without the promotion: refused here, no decision record is made; and the record made is of
      // this one as it will read once the change is in. Made before the note says so, a note that says it was
      // promoted always has the decision record it names.
      const before = planHistoricalDecisionUpdate(records, request, now);
      if (request.promote === true && this.#promote === undefined) throw new Error("这里不能转为正式决策。");
      const promotedDecisionId = request.promote === true ? await this.#promote!(before.record) : null;
      const plan = promotedDecisionId === null ? before : planHistoricalDecisionUpdate(records, request, now, { promotedDecisionId });
      if (plan.changed.length === 0) return { version: HISTORICAL_DECISION_VERSION, record: plan.record, supersededId: null, releasedIds: [], promotedDecisionId: null };

      const event = (kind: HistoricalDecisionEvent["kind"], summary: string, changes: HistoricalDecisionEvent["changes"] = []): HistoricalDecisionEvent =>
        ({ at: now.toISOString(), actor, kind, summary: summary.slice(0, 1_000), ...(changes.length === 0 ? {} : { changes: changes.slice(0, 20) }) });
      const record = await this.#rewrite(scan, plan.record, event(promotedDecisionId !== null ? "promoted" : plan.statusChanged ? "status" : "updated", historicalChangeSummary(plan.changed), plan.changes));
      try {
        if (plan.superseded !== null) await this.#rewrite(scan, plan.superseded, event("superseded", `被「${record.title}」替代`));
        for (const released of plan.released) await this.#rewrite(scan, released, event("released", `「${record.title}」恢复有效，解除替代关系`));
      } finally {
        this.#onWritten();
      }
      return { version: HISTORICAL_DECISION_VERSION, record, supersededId: plan.superseded?.id ?? null, releasedIds: plan.released.map((released) => released.id), promotedDecisionId };
    });
  }

  /** The index rows made again from the vault. A file that cannot be opened is set aside first, its history with it. */
  async rebuildIndex(): Promise<RebuildHistoricalDecisionIndexResult> {
    return this.#enqueue(async () => {
      const scan = await this.#repository.scan();
      const now = this.#clock();
      let setAside: string | null = null;
      try {
        this.#opened().rebuild(scan.records, now);
      } catch {
        this.close();
        if (existsSync(this.#indexPath)) {
          setAside = `${this.#indexPath}.corrupt-${now.getTime()}-${this.#idFactory().slice(0, 8)}`;
          renameSync(this.#indexPath, setAside);
        }
        try {
          this.#opened().rebuild(scan.records, now);
        } catch (error) {
          return { version: HISTORICAL_DECISION_VERSION, index: this.#unavailable(error, scan) };
        }
      }
      this.#onWritten();
      const index = this.#opened();
      return {
        version: HISTORICAL_DECISION_VERSION,
        index: {
          state: "ready",
          message: setAside === null ? null : "原来的索引文件读不了，已另存一份并从 Vault 重新建立；此前的变更历史留在另存的那份里。",
          indexed: index.facets().kept,
          found: scan.records.length,
          syncedAt: index.syncedAt(),
        },
      };
    });
  }

  close(): void {
    this.#index?.close();
    this.#index = null;
  }

  #opened(): HistoricalDecisionIndex {
    this.#index ??= new HistoricalDecisionIndex(this.#indexPath);
    return this.#index;
  }

  #unavailable(error: unknown, scan: HistoricalDecisionScan): HistoricalDecisionIndexState {
    // Opened again at the next read: a file locked for a moment is not one lost for the session.
    this.close();
    return { state: "unavailable", message: (error instanceof Error ? error.message : String(error)).slice(0, 1_000), indexed: null, found: scan.records.length, syncedAt: null };
  }

  #found(scan: HistoricalDecisionScan, id: string): StoredHistoricalDecision {
    const stored = scan.records.find((item) => item.record.id === id);
    if (stored === undefined) throw new Error(HISTORICAL_DECISION_REFUSALS.gone);
    return stored;
  }

  /** A record written into its own note as it now reads, and that change kept in its history. */
  async #rewrite(scan: HistoricalDecisionScan, record: HistoricalDecision, event: HistoricalDecisionEvent): Promise<HistoricalDecision> {
    const written = await this.#repository.revise(this.#found(scan, record.id), record);
    this.#remember(record.id, event);
    return written.record;
  }

  /** The history is the App's own account of a change already in the note: failing to keep it does not undo the change. */
  #remember(id: string, event: HistoricalDecisionEvent): void {
    try {
      this.#opened().appendEvent(id, event);
    } catch (error) {
      this.close();
      console.error(`[paraself] historical decision history not kept: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  #history(id: string): HistoricalDecisionEvent[] {
    try {
      return this.#opened().events(id);
    } catch {
      this.close();
      return [];
    }
  }

  #enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#writeTail.then(operation, operation);
    this.#writeTail = result.catch(() => undefined);
    return result;
  }
}
