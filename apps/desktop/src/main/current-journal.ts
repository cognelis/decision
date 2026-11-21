import { amendmentKey, selectJournalEntries, type JournalEntryQuery, type JournalEntryRepository, type JournalEntryScan } from "@cognelis/decision-storage";
import { amendmentUncertain, entriesForConsultation, journalContentHash, type AmendmentSource } from "./decision-context-amendments.js";

type CurrentScan = { scan: JournalEntryScan; blocked: Set<string>; rawIncomplete: boolean; known: Set<string> };
/** Shared current-evidence view; raw notes and their edit history remain unchanged. */
export class CurrentJournal {
  #reading: Promise<CurrentScan> | null = null;
  constructor(private readonly journal: Pick<JournalEntryRepository, "list">, private readonly amendments: Pick<AmendmentSource, "scan">) {}

  #snapshot(): Promise<CurrentScan> {
    if (this.#reading === null) {
      const reading = this.#load(); this.#reading = reading;
      void reading.finally(() => { if (this.#reading === reading) this.#reading = null; }).catch(() => undefined);
    }
    return this.#reading;
  }

  async #load(): Promise<CurrentScan> {
    const before = await this.journal.list({ everything: true });
    const previous = await this.amendments.scan();
    const current = await this.journal.list({ everything: true });
    const amendments = await this.amendments.scan();
    if (previous.unavailable || amendments.unavailable) throw new Error("偏好与想法的增补或撤回状态无法读取");
    const diagnostics = [...before.diagnostics, ...current.diagnostics];
    const originals = new Map(before.entries.map(entry => [entry.id, entry]));
    const blocked = new Set(diagnostics.flatMap(item => item.recordId === undefined ? [] : [item.recordId]));
    const trusted = current.entries.filter(entry => {
      const key = amendmentKey(entry.kind === "preference" ? "preferences" : "ideas", entry.id);
      const old = originals.get(entry.id);
      if (!blocked.has(entry.id) && !amendmentUncertain(previous, key) && !amendmentUncertain(amendments, key) && old !== undefined &&
        journalContentHash(old) === journalContentHash(entry) && old.updatedAt === entry.updatedAt &&
        (previous.records.get(key)?.revision ?? 0) === (amendments.records.get(key)?.revision ?? 0)) return true;
      blocked.add(entry.id);
      diagnostics.push({ path: current.relativePaths?.get(entry.id) ?? entry.id, message: "该记录的现行内容或撤回状态无法核对，未作为当前依据" });
      return false;
    });
    return { scan: { ...current, diagnostics, entries: entriesForConsultation(trusted, amendments.records) }, blocked,
      rawIncomplete: before.diagnostics.length > 0 || current.diagnostics.length > 0, known: new Set(current.entries.map(entry => entry.id)) };
  }

  async list(query: JournalEntryQuery = {}): Promise<JournalEntryScan> {
    const { scan } = await this.#snapshot();
    return { ...scan, entries: selectJournalEntries(scan.entries, query) };
  }

  async find(id: string) {
    const { scan, blocked, rawIncomplete, known } = await this.#snapshot();
    if (blocked.has(id) || (rawIncomplete && !known.has(id))) throw new Error("该记录的现行内容或撤回状态无法核对");
    return scan.entries.find(entry => entry.id === id) ?? null;
  }
}
