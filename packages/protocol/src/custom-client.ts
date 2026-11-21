import { z } from "zod";

import { sourceClientSchema } from "./capture.js";

export const CUSTOM_CLIENTS_VERSION = 1 as const;

/**
 * A command the client is run by, as a terminal finds it: a name alone, no path and nothing a shell reads as its own.
 * MCP commands run it without a shell, each argument as the template gives it.
 */
export const clientCommandNameSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/u, "命令名只能是一个名字，不能带路径、空格或 shell 符号");

/** A field of the hook's input: a name, or a dotted path into it (`payload.prompt`, `workspacePaths.0`). */
export const hookFieldPathSchema = z
  .string()
  .max(200)
  .regex(/^[A-Za-z0-9_$-]+(?:\.[A-Za-z0-9_$-]+)*$/u, "字段名只能是字母、数字、下划线、连字符，多级用点号连接");

/** An event the client fires hooks on, as its hook file names it. */
export const hookEventNameSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/u, "事件名只能是字母开头的字母、数字、下划线、点号、连字符");

/**
 * The client's hook file, under the reader's home folder: written `~/…`, with no `..` to climb out of it and nothing a
 * path cannot hold.
 */
export const customHookFileSchema = z
  .string()
  .max(500)
  .refine((value) => value.startsWith("~/") && value.length > 2, "钩子配置文件要写成 ~/ 开头、在用户主目录下的路径")
  .refine((value) => !/[\0\r\n\\]/u.test(value), "路径里不能有换行或反斜杠")
  .refine(
    (value) => value.slice(2).split("/").every((segment) => segment !== ".." && segment !== "." && segment !== ""),
    "路径里不能有 ..、. 或连续的 /",
  );

const PLACEHOLDER = /\{([^{}]*)\}/gu;

/**
 * One MCP subcommand of the client's, as arguments: `{bridge}` (the bridge, an argument of its own) and `{client}` are the
 * only placeholders; nothing else in braces, and no argument a line or a NUL breaks.
 */
const commandTemplateSchema = z
  .array(z.string().min(1).max(500))
  .min(1)
  .max(20)
  .superRefine((args, context) => {
    for (const [index, arg] of args.entries()) {
      if (/[\0\r\n]/u.test(arg)) context.addIssue({ code: "custom", message: "参数里不能有换行", path: [index] });
      for (const [, name] of arg.matchAll(PLACEHOLDER)) {
        if (name !== "bridge" && name !== "client") {
          context.addIssue({ code: "custom", message: `只能用 {bridge}、{client} 两个占位符，不认识 {${name}}`, path: [index] });
        }
      }
      if (arg.includes("{bridge}") && arg !== "{bridge}") {
        context.addIssue({ code: "custom", message: "{bridge} 要单独作为一个参数", path: [index] });
      }
      if (/[{}]/u.test(arg.replace(PLACEHOLDER, ""))) {
        context.addIssue({ code: "custom", message: "花括号只能用在 {bridge}、{client} 里", path: [index] });
      }
    }
  });

const tableWordSchema = z.string().regex(/^\S{1,40}$/u);

/** The fields of a hook handler that say what it runs and how: no extra field takes their place. */
const RESERVED_HANDLER_FIELDS = new Set(["type", "command", "args", "bash", "powershell", "hooks", "matcher"]);

/** A field name a client's file has beside this app's own: a word, no path. */
const extraKeySchema = z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/u);

/**
 * What else a client asks for beside this app's own fields, as data: JSON alone, small, written as it is (Auggie's
 * `metadata: { includeConversationData: true }` on a Stop group, Copilot's `tools: ["*"]` on its server).
 */
const extraFieldsSchema = z
  .record(extraKeySchema, z.json())
  .refine((fields) => JSON.stringify(fields).length <= 2_000, "附加字段太长了");

export const customClientMcpSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("none") }).strict(),
  /**
   * Written straight into the client's own MCP configuration (`mcpServers.paraself`), where its docs say it reads its
   * servers: what the client has there stays, a `paraself` not this app's is left alone, and only this app's goes
   * (Decision's `decision` with it).
   */
  z
    .object({
      mode: z.literal("file"),
      file: customHookFileSchema,
      entry: extraFieldsSchema.refine((fields) => !("command" in fields) && !("args" in fields), "command、args 由 Paraself 自己写").optional(),
      /** Older files the client reads its servers from only while `file` is absent: one there, `file` would hide it. */
      olderFiles: z.array(customHookFileSchema).max(4).optional(),
    })
    .strict(),
  z
    .object({
      mode: z.literal("command"),
      add: commandTemplateSchema.refine((args) => args.filter((arg) => arg === "{bridge}").length === 1, "添加命令里要有一个 {bridge}"),
      remove: commandTemplateSchema,
      // A listing it reads, always: without one there is no telling whether a server of this app's name there is the
      // reader's own, and an add may write over it.
      list: z.discriminatedUnion("output", [
        z.object({ output: z.literal("json"), args: commandTemplateSchema }).strict(),
        z
          .object({
            output: z.literal("table"),
            args: commandTemplateSchema,
            header: z.array(tableWordSchema).min(2).max(8),
            none: z.string().trim().min(1).max(200).optional(),
          })
          .strict(),
      ]),
    })
    .strict(),
]);

const fieldReplySchema = z.object({ event: hookEventNameSchema, source: z.literal("field"), field: hookFieldPathSchema }).strict();
/**
 * How a transcript's lines are read, by the client that writes it: `copilot`, Copilot CLI's events.jsonl;
 * `codebuddy`, CodeBuddy Code's Responses-style lines; `droid`, Factory Droid's `{type: "message", message}` lines.
 * Read by the bridge, the last 64 KiB alone, as Claude Code's are.
 */
export const transcriptFormatSchema = z.enum(["claude", "codex", "antigravity", "copilot", "codebuddy", "droid"]);
export const TRANSCRIPT_FORMATS = transcriptFormatSchema.options;

/**
 * How a client's hook file is laid out. `claude`: `{ hooks: { <event>: [{ matcher?, hooks: [handler] }] } }`, merged
 * among others' hooks; `claude-owned`, the same, the whole file this app's; `antigravity`, a named hook
 * `{ paraself: { <event>: [handler] } }`; `flat`, `{ version: 1, hooks: { <event>: [handler] } }` merged (Cursor's);
 * `flat-owned`, the same, the whole file this app's (Copilot's hooks folder).
 */
export const hookFileFormatSchema = z.enum(["claude", "claude-owned", "antigravity", "flat", "flat-owned"]);
export const HOOK_FILE_FORMATS = hookFileFormatSchema.options;

const transcriptReplySchema = z
  .object({
    event: hookEventNameSchema,
    source: z.literal("transcript"),
    format: transcriptFormatSchema,
    field: hookFieldPathSchema,
  })
  .strict();

/** A client the reader added on the 接入 page: data alone, read by the installer and the bridge as a built-in one is. */
export const customClientSchema = z
  .object({
    id: sourceClientSchema,
    name: z.string().trim().min(1).max(60),
    shortName: z.string().trim().min(1).max(2),
    command: clientCommandNameSchema.optional(),
    hooks: z
      .object({
        file: customHookFileSchema,
        format: hookFileFormatSchema,
        /** Fields each group of this app's has beside its handlers (a `claude` file's): Auggie's `metadata`. */
        group: extraFieldsSchema.refine((fields) => !("hooks" in fields) && !("matcher" in fields), "hooks、matcher 由 Paraself 自己写").optional(),
        /** `argv`: the bridge in `command`, its arguments in `args`, run with no shell (Auggie 0.x's). Left out: one command line. */
        invocation: z.literal("argv").optional(),
        /** A file whose being there makes the client read no hooks from this one (Droid's hooks.json): not connected then. */
        shadowedBy: customHookFileSchema.optional(),
        /** How long the client gives a handler, in its own field and unit: `timeout: 5` (seconds) unless said. */
        timeout: z
          .object({
            // A field of the handler's own: not one that names what it runs, or how.
            field: extraKeySchema.refine((field) => !RESERVED_HANDLER_FIELDS.has(field), "超时字段不能用 type、command、args、bash、powershell 这些处理器自己的字段"),
            value: z.number().int().min(1).max(600_000),
          })
          .strict()
          .optional(),
      })
      .strict()
      .refine((hooks) => hooks.group === undefined || hooks.format === "claude" || hooks.format === "claude-owned", {
        message: "只有 claude 格式的钩子分组能带附加字段",
        path: ["group"],
      }),
    prompt: z.object({ event: hookEventNameSchema, field: hookFieldPathSchema }).strict(),
    reply: z.discriminatedUnion("source", [fieldReplySchema, transcriptReplySchema]),
    fields: z
      .object({ sessionId: hookFieldPathSchema, cwd: hookFieldPathSchema, turnId: hookFieldPathSchema.optional() })
      .strict(),
    /** A turn's end read only where this field holds one of these. */
    complete: z
      .object({ field: hookFieldPathSchema, values: z.array(z.string().trim().min(1).max(100)).min(1).max(10) })
      .strict()
      .optional(),
    mcp: customClientMcpSchema,
  })
  .strict()
  .refine((client) => client.mcp.mode !== "command" || client.command !== undefined, {
    message: "用客户端自己的命令注册 MCP 时要填命令名",
    path: ["command"],
  });

export const customClientsFileSchema = z
  .object({
    version: z.literal(CUSTOM_CLIENTS_VERSION),
    clients: z.array(customClientSchema).max(32),
  })
  .strict()
  .superRefine((file, context) => {
    const seen = new Set<string>();
    for (const [index, client] of file.clients.entries()) {
      if (seen.has(client.id)) context.addIssue({ code: "custom", message: `客户端 id ${client.id} 重复了`, path: ["clients", index, "id"] });
      seen.add(client.id);
    }
  });

export type CustomClient = z.infer<typeof customClientSchema>;

/**
 * A file an earlier build wrote, as this one reads it: a client registering its MCP server by a command that could not
 * list its servers registers none now, and is named so the 接入 page can say so. Anything else is left as it was.
 */
export const upgradeCustomClientsFile = (raw: unknown): { file: unknown; mcpDropped: string[] } => {
  const file = typeof raw === "object" && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
  if (file === null || !Array.isArray(file.clients)) return { file: raw, mcpDropped: [] };
  const mcpDropped: string[] = [];
  const clients = file.clients.map((client: unknown) => {
    const entry = typeof client === "object" && client !== null ? (client as Record<string, unknown>) : null;
    const mcp = entry?.mcp as { mode?: unknown; list?: { output?: unknown } } | undefined;
    if (entry === null || mcp?.mode !== "command" || mcp.list?.output !== "none") return client;
    mcpDropped.push(String(entry.id));
    return { ...entry, mcp: { mode: "none" } };
  });
  return { file: { ...file, clients }, mcpDropped };
};
export type CustomClientsFile = z.infer<typeof customClientsFileSchema>;

/**
 * A field of a hook's input by its dotted path: a list's item by its index, and a list at the end by its first item
 * (Antigravity's `workspacePaths`). Read as data alone.
 */
export const readHookField = (input: unknown, path: string): unknown => {
  let value: unknown = input;
  for (const segment of path.split(".")) {
    if (Array.isArray(value)) {
      value = /^\d+$/u.test(segment) ? value[Number(segment)] : undefined;
    } else if (typeof value === "object" && value !== null && Object.hasOwn(value, segment)) {
      value = (value as Record<string, unknown>)[segment];
    } else {
      return undefined;
    }
  }
  return Array.isArray(value) ? value[0] : value;
};

/**
 * A field as the bridge takes it: text, trimmed not empty and within the limit it holds that field to, and nothing
 * else. What the form's 试解析 shows is what the capture would read, a number as well as an empty string being none.
 */
export type HookFieldReading = { state: "text"; text: string } | { state: "missing" } | { state: "unusable"; reason: string };

export const readHookText = (value: unknown, maximum?: number): HookFieldReading => {
  if (value === undefined || value === null || (typeof value === "string" && value.trim() === "")) return { state: "missing" };
  if (typeof value !== "string") {
    const reason = typeof value === "number" ? "数字" : typeof value === "boolean" ? "真假值" : Array.isArray(value) ? "列表" : "对象";
    return { state: "unusable", reason };
  }
  return maximum !== undefined && value.length > maximum ? { state: "unusable", reason: `超过 ${maximum} 字` } : { state: "text", text: value.trim() };
};

/** The limits the bridge holds these fields to (text-fallback): one past it is no field at all. */
export const HOOK_FIELD_LIMITS = { sessionId: 500, cwd: 2_000, turnId: 500 } as const;

/** What the 添加客户端 form shows of a pasted hook input: each field as the bridge would read it. Nothing kept. */
export interface CustomClientSample {
  prompt: HookFieldReading;
  /** None where the reply is read off a transcript. */
  reply: HookFieldReading | null;
  /** The transcript the reply would be read from, by its field's value: not read here. None where the reply is a field. */
  transcriptPath: HookFieldReading | null;
  sessionId: HookFieldReading;
  cwd: HookFieldReading;
  turnId: HookFieldReading;
  /** Whether the input counts as a turn that ended of itself; null where no condition is set. */
  complete: boolean | null;
}

export const previewCustomClientSample = (
  client: Pick<CustomClient, "prompt" | "reply" | "fields" | "complete">,
  sample: unknown,
): CustomClientSample => {
  const read = (path: string | undefined, maximum?: number) =>
    path === undefined ? { state: "missing" as const } : readHookText(readHookField(sample, path), maximum);
  return {
    prompt: read(client.prompt.field),
    reply: client.reply.source === "field" ? read(client.reply.field) : null,
    transcriptPath: client.reply.source === "transcript" ? read(client.reply.field, 4_000) : null,
    sessionId: read(client.fields.sessionId, HOOK_FIELD_LIMITS.sessionId),
    cwd: read(client.fields.cwd, HOOK_FIELD_LIMITS.cwd),
    turnId: read(client.fields.turnId, HOOK_FIELD_LIMITS.turnId),
    complete:
      client.complete === undefined ? null : client.complete.values.includes(String(readHookField(sample, client.complete.field))),
  };
};
