import type { ClientSummary } from "../shared/renderer-api.js";

/** Where a decision came from that is no client. A client's name is the registry's, from the snapshot. */
const OTHER_SOURCES: Record<string, string> = {
  manual: "手动记录",
  "pr-comment": "PR 评论",
  test: "Test",
};

let known: readonly ClientSummary[] = [];

/** The clients the latest snapshot listed: every label below reads them. */
export const rememberClients = (clients: readonly ClientSummary[] | undefined): void => {
  if (clients !== undefined) known = clients;
};

export const knownClients = (): readonly ClientSummary[] => known;

/** The clients' names as one choice among them: "Claude Code、Codex 或 Grok". */
export const clientNamesOr = (clients: readonly ClientSummary[] = known): string => {
  const names = clients.map((client) => client.name);
  return names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join("、")} 或 ${names.at(-1)}`;
};

/** A source's name, as the pages show it: one no list names keeps its id. */
export const sourceLabel = (source: string): string =>
  known.find((client) => client.id === source)?.name ?? OTHER_SOURCES[source] ?? source;
