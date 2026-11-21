import {
  clientSummary,
  KNOWN_CLIENTS,
  supersededBy,
  customClientDescriptor,
  customClientProblems,
  customHookPath,
  lockHookTarget,
  readCustomClients,
  setAsideCustomClients,
  writeCustomClients,
  type ClientDescriptor,
  type ClientSummary,
  type HookTargetLock,
  type InstallReport,
} from "@cognelis/decision-integrations";
import { customClientSchema, type CustomClient } from "@cognelis/decision-protocol";

interface CustomClientServiceOptions {
  /** custom-clients.json, where the bridge reads it too. */
  path: string;
  /** Where each client Paraself ships (built in, and the catalog's) keeps its hooks now, by id. */
  builtInPaths: () => Record<string, string>;
  /** Paraself's own folders, where no client's hooks go. */
  protectedDirectories: () => string[];
  home?: string;
  platform?: NodeJS.Platform;
  /** Takes one client out of its hook file and MCP, as 断开 does for all; run inside `serialize`, so it queues no further. */
  disconnect: (client: ClientDescriptor) => Promise<InstallReport>;
  /** The queue installs and removals wait in (inIntegrationsTurn): a save or a delete waits its turn there too. */
  serialize?: <T>(run: () => Promise<T>) => Promise<T>;
}

/** Why a client could not be taken out: what its report says of it. */
const notDisconnected = (report: InstallReport): string | null => {
  const failed = report.targets.find((target) => target.status === "failed");
  return failed === undefined ? null : failed.detail ?? "原因未知";
};

const MCP_DROPPED =
  "之前选的「不支持查询」已不再支持：查不了就确认不了名为 paraself 的服务是不是自己的，添加时可能覆盖它。这个客户端改为不注册 MCP；需要的话编辑它，选 JSON 或表格查询。";

/**
 * The clients the reader added on the 接入 page. Each is checked as a save checks it, at start too: one that would not
 * be saved (a built-in client's id, another's hook file, a file that really lies outside the home folder or in Paraself's
 * data) is listed with why, and is not connected. One edited or deleted is first disconnected where it was, so no hook of
 * this app's is left in a file it no longer knows to look in: not disconnected, nothing is changed.
 */
export class CustomClientService {
  readonly #options: CustomClientServiceOptions;
  #clients: CustomClient[] = [];
  /** Why a client read back is not connected, by id. */
  #problems = new Map<string, string>();
  /** What the page says of a client read back as other than it was saved, by id. */
  #notices = new Map<string, string>();
  /** Those a tool the catalog now ships takes the place of (its id, or its hook file): listed, in effect no longer. */
  #superseded = new Set<string>();

  constructor(options: CustomClientServiceOptions) {
    this.#options = options;
  }

  /** Reads the file; one that cannot be read is set aside, and the App starts with none of the reader's clients. */
  async load(): Promise<{ setAside: string | null }> {
    const read = await readCustomClients(this.#options.path);
    this.#clients = read.clients;
    this.#notices = new Map(read.mcpDropped.map((id) => [id, MCP_DROPPED]));
    await this.#check();
    return { setAside: read.unreadable ? await setAsideCustomClients(this.#options.path) : null };
  }

  list(): CustomClient[] {
    return structuredClone(this.#clients);
  }

  /** Those connected: each that passed the checks a save makes. */
  descriptors(): ClientDescriptor[] {
    return this.#clients.filter((client) => !this.#problems.has(client.id)).map(customClientDescriptor);
  }

  /** What the page lists: every one, with why one is not connected and what changed of one read back. */
  summaries(): ClientSummary[] {
    return this.#clients.map((client) => ({
      ...clientSummary(customClientDescriptor(client)),
      custom: true as const,
      ...(this.#problems.has(client.id) ? { problem: this.#problems.get(client.id)! } : {}),
      ...(this.#superseded.has(client.id) ? { superseded: true as const } : {}),
      ...(this.#notices.has(client.id) ? { notice: this.#notices.get(client.id)! } : {}),
    }));
  }

  /** Checked again just before its file is written: where it really is may have moved since it was saved. */
  async targetProblems(id: string): Promise<string[]> {
    const index = this.#clients.findIndex((client) => client.id === id);
    if (index < 0) return [];
    const others = this.#clients.filter((client, at) => at !== index && !this.#problems.has(client.id));
    return this.#problemsOf(this.#clients[index]!, others);
  }

  /**
   * An installer's check of a file it is about to change (its `checkTarget`): a built-in client's is not this one's to
   * check. One of the reader's must still be there, at the very path being written, and pass the checks a save makes;
   * at `write` its file is locked, to be written there and nowhere else.
   */
  async checkTarget(id: string, path: string, stage: "check" | "write"): Promise<HookTargetLock | undefined> {
    if (KNOWN_CLIENTS.some((client) => client.id === id)) return undefined;
    const client = this.#clients.find((entry) => entry.id === id);
    if (client === undefined) throw new Error("这个客户端已经删除，没有写入");
    const home = this.#options.home;
    // Its hook file, or the MCP file it registers its server in: nowhere else.
    const own = [client.hooks.file, ...(client.mcp.mode === "file" ? [client.mcp.file] : [])].map((file) => customHookPath(file, home));
    if (!own.includes(path)) throw new Error("这个客户端刚被改动过，没有按原来的位置写入；再点一次「全部修复」");
    const problems = await this.targetProblems(id);
    if (problems.length > 0) throw new Error(problems.join("；"));
    return stage === "write" ? lockHookTarget(path, home) : undefined;
  }

  /** Runs in the queue installs and removals wait in: what it reads of the clients is as they are once its turn comes. */
  inTurn<T>(run: () => Promise<T>): Promise<T> {
    return this.#serialize(run);
  }

  save(input: CustomClient, previousId?: string): Promise<CustomClient[]> {
    return this.#serialize(async () => {
      const client = customClientSchema.parse(input);
      const previous = previousId === undefined ? undefined : this.#clients.find((entry) => entry.id === previousId);
      if (previousId !== undefined && previous === undefined) throw new Error("要修改的客户端已经不在了，刷新后再试");
      const others = this.#clients.filter((entry) => entry !== previous && !this.#problems.has(entry.id));
      const problems = await this.#problemsOf(client, others);
      if (problems.length > 0) throw new Error(problems.join("；"));
      // One never connected (it did not pass the checks) has nothing of this app's where it was to take out.
      if (previous !== undefined && !this.#problems.has(previous.id)) await this.#disconnect(previous, "改动");
      const next = previous === undefined ? [...this.#clients, client] : this.#clients.map((entry) => (entry === previous ? client : entry));
      await writeCustomClients(this.#options.path, next);
      this.#clients = next;
      if (previous !== undefined) this.#notices.delete(previous.id);
      await this.#check();
      return this.list();
    });
  }

  delete(id: string): Promise<InstallReport> {
    return this.#serialize(async () => {
      const client = this.#clients.find((entry) => entry.id === id);
      if (client === undefined) throw new Error("要删除的客户端已经不在了");
      // One never connected (it did not pass the checks) has no hooks of this app's to take out: its file, perhaps
      // another client's, is left alone.
      const report = this.#problems.has(id)
        ? { mode: "apply" as const, targets: [], commands: [], restartRequired: false }
        : await this.#disconnect(client, "删除");
      const next = this.#clients.filter((entry) => entry !== client);
      await writeCustomClients(this.#options.path, next);
      this.#clients = next;
      this.#notices.delete(id);
      await this.#check();
      return report;
    });
  }

  #serialize<T>(run: () => Promise<T>): Promise<T> {
    return this.#options.serialize === undefined ? run() : this.#options.serialize(run);
  }

  /** Any failure of the check itself is this client's problem too: one client never keeps the others, or the App, from starting. */
  async #problemsOf(client: CustomClient, others: readonly CustomClient[]): Promise<string[]> {
    try {
      return await customClientProblems(client, others, {
        builtInPaths: this.#options.builtInPaths(),
        protectedDirectories: this.#options.protectedDirectories(),
        ...(this.#options.home === undefined ? {} : { home: this.#options.home }),
        ...(this.#options.platform === undefined ? {} : { platform: this.#options.platform }),
      });
    } catch (error) {
      return [`检查它的钩子配置文件时出错（${error instanceof Error ? error.message : String(error)}）`];
    }
  }

  /** Each in turn against the built-in ones and those before it that passed: the first to take a file keeps it. */
  async #check(): Promise<void> {
    const problems = new Map<string, string>();
    const passed: CustomClient[] = [];
    for (const client of this.#clients) {
      const found = await this.#problemsOf(client, passed);
      if (found.length > 0) problems.set(client.id, found.join("；"));
      else passed.push(client);
    }
    this.#problems = problems;
    this.#superseded = new Set(
      this.#clients.filter((client) => {
        if (!problems.has(client.id)) return false;
        try {
          return supersededBy(client, this.#options.builtInPaths(), this.#options.home) !== null;
        } catch {
          return false;
        }
      }).map((client) => client.id),
    );
  }

  async #disconnect(client: CustomClient, action: string): Promise<InstallReport> {
    const report = await this.#options.disconnect(customClientDescriptor(client));
    const reason = notDisconnected(report);
    if (reason !== null) throw new Error(`${client.name} 没能先断开（${reason}），没有${action}它；处理好后再试`);
    return report;
  }
}
