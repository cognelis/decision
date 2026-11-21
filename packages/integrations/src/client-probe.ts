import { supportedTranscriptFormats, type ClientProbeMarker, type CustomClient } from "@cognelis/decision-protocol";

import type { ClientDescriptor } from "./clients.js";
import { customClientDescriptor } from "./custom-clients.js";

const placeholder = (probe: Pick<ClientProbeMarker, "id" | "hooks" | "events">): CustomClient => ({
  id: probe.id,
  name: "Decision 探针",
  shortName: "探",
  hooks: probe.hooks,
  prompt: { event: probe.events[0]!, field: "prompt" },
  reply: { event: probe.events[0]!, source: "field", field: "reply" },
  fields: { sessionId: "session_id", cwd: "cwd" },
  mcp: { mode: "none" },
});

/**
 * A 接入新工具 probe as the installer takes a client: its hook file in the format a client of that format writes, each
 * event running `hook probe <id> <event>`, and no MCP server. Installed and removed by the same paths a client is.
 */
export const probeDescriptor = (probe: Pick<ClientProbeMarker, "id" | "hooks" | "events">): ClientDescriptor => {
  const base = customClientDescriptor(placeholder(probe));
  return { ...base, hooks: { ...base.hooks, events: probe.events.map((event) => ({ event, operation: "probe" as const })) }, capture: {} };
};

/**
 * Every transcript format a client may name, with how the bridge reads it (its `capture.transcript`): read off the
 * descriptor a client of that format gets, so a format the engine learns is tried as well.
 */
export const transcriptReaders = (): { format: string; reader: NonNullable<ClientDescriptor["capture"]["transcript"]> }[] =>
  supportedTranscriptFormats().flatMap((format) => {
    const reader = customClientDescriptor({
      ...placeholder({ id: "probe-formats", hooks: { file: "~/.probe/hooks.json", format: "claude" }, events: ["Stop"] }),
      reply: { event: "Stop", source: "transcript", format: format as never, field: "transcript_path" },
    }).capture.transcript;
    return reader === undefined ? [] : [{ format, reader }];
  });
