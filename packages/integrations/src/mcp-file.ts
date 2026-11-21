import type { ClientDescriptor, McpByFile } from "./clients.js";
import { hookBridgeReference } from "./hooks.js";

/** The server's name in every client's MCP configuration. */
export const MCP_SERVER_NAME = "paraself";

/** The name Decision registered it by: one of this app's by that name is taken out at a connect and a disconnect. */
export const LEGACY_MCP_SERVER_NAME = "decision";

/** The bridge's file, by its name now or as Decision's: a server running either at an earlier place is this app's. */
const BRIDGE_FILE = /(?:paraself|decision)-bridge(?:\.cmd)?/u;

const asObject = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

/**
 * Whether a server's command line, as a client's MCP listing prints it, runs this app's bridge for this client: `mcp
 * <client>` in it, and the bridge by its name or where this run's is. For a listing alone (install.ts): a file's entry
 * is told by its form (isOwnServer).
 */
export const runsThisBridge = (line: string, client: string, bridgePath?: string): boolean =>
  new RegExp(`\\bmcp ${client}(?![\\w-])`, "u").test(line) &&
  (new RegExp(`${BRIDGE_FILE.source}(?=["'\\s]|$)`, "u").test(line) || (bridgePath !== undefined && line.includes(bridgePath)));

/** A bridge path as this app names it: the very one this run uses, or one at an earlier place, by its file's own name. */
const isBridge = (value: string, bridgePath?: string): boolean =>
  value === bridgePath || new RegExp(`^${BRIDGE_FILE.source}$`, "u").test(value.split(/[\\/]/u).at(-1) ?? "");

/**
 * Whether a server is this app's for this client, told by its form and nothing else: its command the bridge with
 * `args` exactly `["mcp", <client>]`, or on Windows `cmd` with exactly the arguments mergeMcpFile writes around it. A
 * word in an argument, or a program merely named like it, is no sign of it: anything else is not this app's.
 */
const isOwnServer = (entry: unknown, client: string, bridgePath?: string): boolean => {
  const server = asObject(entry);
  if (server === null || typeof server.command !== "string" || !Array.isArray(server.args)) return false;
  const args = server.args;
  if (!args.every((arg) => typeof arg === "string")) return false;
  if (isBridge(server.command, bridgePath)) return args.length === 2 && args[0] === "mcp" && args[1] === client;
  return (
    server.command === "cmd" &&
    args.length === 7 &&
    ["/d", "/v:off", "/c", "call"].every((arg, index) => args[index] === arg) &&
    isBridge(args[4] as string, bridgePath) &&
    args[5] === "mcp" &&
    args[6] === client
  );
};

/** The code of the error a `paraself` server not this app's ends an install in. */
export const MCP_NOT_THIS_APPS = "PARASELF_MCP_NOT_THIS_APPS";

const serversOf = (document: Record<string, unknown>): Record<string, unknown> => {
  if (document.mcpServers === undefined) return {};
  const servers = asObject(document.mcpServers);
  if (servers === null) throw new Error("其中的 mcpServers 应当是一个对象");
  return servers;
};

const cloneDocument = (input: unknown): Record<string, unknown> => {
  const object = asObject(input);
  if (object === null) throw new Error("整个文件应当是一个 JSON 对象，以 { 开头");
  return structuredClone(object);
};

/**
 * The client's MCP configuration with this app's server as `mcpServers.paraself`: everything else in it stays, and a
 * `paraself` that does not run this app's bridge for this client is not replaced. Decision's `mcpServers.decision`, this
 * app's, goes, what the reader added to it carried over; one not this app's stays, named in `left`. On Windows the
 * bridge is a .cmd, which a client starts through cmd, as Claude Code's is.
 */
export const mergeMcpFile = (
  input: unknown,
  bridgePath: string,
  client: ClientDescriptor & { mcp: McpByFile },
  platform: NodeJS.Platform = process.platform,
): { document: Record<string, unknown>; left: string[] } => {
  const document = cloneDocument(input);
  const servers = serversOf(document);
  const existing = servers[MCP_SERVER_NAME];
  if (existing !== undefined && !isOwnServer(existing, client.id, bridgePath)) {
    throw Object.assign(
      new Error(`${client.name} 的 MCP 配置里已有一个名为 ${MCP_SERVER_NAME} 的服务器，运行的不是本应用的桥接程序，没有改动它；如果不再需要它，先自行删除或改名再试`),
      { code: MCP_NOT_THIS_APPS },
    );
  }
  const legacy = servers[LEGACY_MCP_SERVER_NAME];
  const legacyOwn = legacy !== undefined && isOwnServer(legacy, client.id, bridgePath);
  const kept = Object.fromEntries(Object.entries(servers).filter(([name]) => !(legacyOwn && name === LEGACY_MCP_SERVER_NAME)));
  const reference = hookBridgeReference(bridgePath, platform);
  const command =
    platform === "win32"
      ? { command: "cmd", args: ["/d", "/v:off", "/c", "call", reference, "mcp", client.id] }
      : { command: bridgePath, args: ["mcp", client.id] };
  // This app's fields alone are set: what the reader added to its own entry (`disabled`, `env`, a field the client reads
  // later) stays, from Decision's entry where there is none of the new name yet.
  const base = asObject(existing) ?? (legacyOwn ? asObject(legacy) : null) ?? {};
  return {
    document: { ...document, mcpServers: { ...kept, [MCP_SERVER_NAME]: { ...structuredClone(base), ...structuredClone(client.mcp.entry ?? {}), ...command } } },
    left: legacy !== undefined && !legacyOwn ? [LEGACY_MCP_SERVER_NAME] : [],
  };
};

/**
 * The client's MCP configuration without this app's server, by its name now or as Decision registered it: one by those
 * names not this app's stays, named in `left`; with none of this app's there, `changed` is false and the file is left
 * as it was.
 */
export const removeMcpFile = (
  input: unknown,
  client: ClientDescriptor,
  bridgePath?: string,
): { document: Record<string, unknown>; changed: boolean; left: string[] } => {
  const document = cloneDocument(input);
  const servers = serversOf(document);
  const named = [MCP_SERVER_NAME, LEGACY_MCP_SERVER_NAME].filter((name) => servers[name] !== undefined);
  const ours = named.filter((name) => isOwnServer(servers[name], client.id, bridgePath));
  const left = named.filter((name) => !ours.includes(name));
  if (ours.length === 0) return { document, changed: false, left };
  const kept = Object.fromEntries(Object.entries(servers).filter(([name]) => !ours.includes(name)));
  return { document: { ...document, mcpServers: kept }, changed: true, left };
};
