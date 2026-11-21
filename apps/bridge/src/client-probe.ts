import { transcriptReaders } from "@cognelis/decision-integrations";
import {
  CLIENT_PROBE_LIMITS,
  clientProbeIdSchema,
  clientProbeMarkerSchema,
  hookEventNameSchema,
  hookInputFields,
  type ClientProbeRecord,
} from "@cognelis/decision-protocol";
import { readFile, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

import { readParaselfEnvironment } from "../../../config/paraself-environment.mjs";

import { defaultBridgeDataDirectory } from "./runtime-client.js";
import { readLastAssistantText } from "./transcript-tail.js";

/** Where the App writes a 接入新工具 probe's marker and the bridge its records: moved as the bridge's other files are. */
export const defaultClientProbesPath = (environment: NodeJS.ProcessEnv = process.env): string =>
  readParaselfEnvironment(environment, "CLIENT_PROBES") ?? join(defaultBridgeDataDirectory(), "client-probes");

/** Fields whose value may be a transcript's path, at most this many tried. */
const MAXIMUM_TRANSCRIPT_FIELDS = 8;

/**
 * Which transcript format, read off which field of the input, holds the secret in its last reply: each format the
 * engine reads tried on each field naming a file. What the transcript says is not kept; nor is a read that did not hold
 * the secret, and past the limit the schema keeps, only how many more did.
 */
const transcriptMatches = async (input: unknown, secret: string): Promise<Pick<ClientProbeRecord, "transcripts" | "transcriptsCut">> => {
  const candidates = hookInputFields(input)
    .filter((field): field is { path: string; value: string } =>
      typeof field.value === "string" && field.value.length <= 4_000 && isAbsolute(field.value))
    .slice(0, MAXIMUM_TRANSCRIPT_FIELDS);
  const found: ClientProbeRecord["transcripts"] = [];
  for (const { path, value } of candidates) {
    if (!(await stat(value).then((status) => status.isFile(), () => false))) continue;
    for (const { format, reader } of transcriptReaders()) {
      const text = await readLastAssistantText(value, { format: reader }).catch(() => null);
      if (text?.includes(secret) === true) found.push({ field: path, format, matched: true });
    }
  }
  const cut = found.length - CLIENT_PROBE_LIMITS.transcripts;
  return { transcripts: found.slice(0, CLIENT_PROBE_LIMITS.transcripts), ...(cut > 0 ? { transcriptsCut: cut } : {}) };
};

/** Slot files, one record each: claimed with an exclusive create, so no number of hooks at once writes past the limit. */
export const probeRecordSlot = (index: number): string => `${String(index).padStart(2, "0")}.json`;

/**
 * `hook probe <probe id> <event>`: what the client sends on that event, recorded for the App while a probe's marker
 * stands and has not run out, within the limits whatever the marker says. The marker is read again just before the
 * write, and the records folder is the App's to make: a probe taken out meanwhile records nothing. Silent, and 0,
 * whatever happens.
 */
export const runProbeHook = async (
  probeId: string | undefined,
  event: string | undefined,
  dependencies: {
    environment?: NodeJS.ProcessEnv;
    readInput: (maximumBytes: number) => Promise<unknown>;
    now?: () => number;
  },
): Promise<number> => {
  try {
    if (!clientProbeIdSchema.safeParse(probeId).success || !hookEventNameSchema.safeParse(event).success) return 0;
    const directory = defaultClientProbesPath(dependencies.environment);
    const clock = dependencies.now ?? Date.now;
    // Read at each look: one that ran out while the input was read is no probe at the write.
    const standing = async () => {
      const now = clock();
      const marker = clientProbeMarkerSchema.safeParse(JSON.parse(await readFile(join(directory, `${probeId}.json`), "utf8")));
      if (!marker.success || marker.data.id !== probeId || !marker.data.events.includes(event!)) return null;
      const { createdAt, expiresAt } = marker.data;
      return now < createdAt || now >= expiresAt || expiresAt - createdAt > CLIENT_PROBE_LIMITS.lifetimeMs ? null : marker.data;
    };
    const marker = await standing();
    if (marker === null) return 0;
    const records = join(directory, probeId!);
    const input = await dependencies.readInput(CLIENT_PROBE_LIMITS.inputBytes);
    const record: ClientProbeRecord = { event: event!, receivedAt: clock(), input, ...(await transcriptMatches(input, marker.secret)) };
    // Taken out while the input was read: nothing is written.
    if ((await standing())?.secret !== marker.secret) return 0;
    const content = JSON.stringify(record);
    for (let index = 0; index < CLIENT_PROBE_LIMITS.records; index += 1) {
      try {
        await writeFile(join(records, probeRecordSlot(index)), content, { mode: 0o600, flag: "wx" });
        return 0;
      } catch (error) {
        // Taken: the next. Any other failure (no folder, the probe gone) is no record.
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") return 0;
      }
    }
  } catch {
    // A probe sees what it can: an input too large, not JSON, or a folder gone is no record, and the client goes on.
  }
  return 0;
};
