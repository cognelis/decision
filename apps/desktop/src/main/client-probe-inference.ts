import {
  HOOK_FIELD_LIMITS,
  hookInputFields,
  previewCustomClientSample,
  readHookField,
  readHookText,
  supportedTranscriptFormats,
  type ClientProbeMarker,
  type ClientProbeRecord,
  type CustomClient,
  type OnboardingCard,
} from "@cognelis/decision-protocol";

/** What the reader is asked to send in the tool, its secret in it: the prompt holds the whole line, a reply the secret. */
export const PROBE_PHRASE_PREFIX = "请原样回复：";
export const probePhrase = (secret: string): string => `${PROBE_PHRASE_PREFIX}${secret}`;

type Probe = Pick<ClientProbeMarker, "hooks" | "events" | "secret">;
type Mapping = Pick<CustomClient, "hooks" | "prompt" | "reply" | "fields"> & Partial<Pick<CustomClient, "complete">>;

const text = (value: unknown, maximum?: number): string | null => {
  const reading = readHookText(value, maximum);
  return reading.state === "text" ? reading.text : null;
};

const named = (path: string, pattern: RegExp): boolean => pattern.test(path.split(".").at(-1) ?? path);
const shortestFirst = <T extends { path: string }>(left: T, right: T): number => left.path.length - right.path.length;
/** Fields named like the pattern first, then the shorter path. */
const preferring = (pattern: RegExp) => <T extends { path: string }>(left: T, right: T): number =>
  Number(named(right.path, pattern)) - Number(named(left.path, pattern)) || shortestFirst(left, right);

const textFields = (record: ClientProbeRecord, maximum?: number): { path: string; text: string }[] =>
  hookInputFields(record.input).flatMap(({ path, value }) => {
    const found = text(value, maximum);
    return found === null ? [] : [{ path, text: found }];
  });

const isPath = (value: string): boolean => value.startsWith("/") || /^[A-Za-z]:[\\/]/u.test(value);

/**
 * Whether both secrets are in: the whole line in some field, and after it the secret alone in a field or in a transcript
 * a format read. What a probe waits for, whatever else of the fields can be worked out.
 */
export const secretsSeen = (records: readonly ClientProbeRecord[], secret: string): boolean => {
  const phrase = probePhrase(secret);
  const asked = records.filter((record) => textFields(record).some((field) => field.text.includes(phrase)));
  if (asked.length === 0) return false;
  const first = Math.min(...asked.map((record) => record.receivedAt));
  return records.some((record) => record.receivedAt >= first && (record.transcripts.some((entry) => entry.matched) ||
    textFields(record).some((field) => field.text.includes(secret) && !field.text.includes(PROBE_PHRASE_PREFIX))));
};

export type Inference =
  | { ok: true; mapping: Mapping; notes: string[] }
  | { ok: false; reasons: string[] };

/**
 * Where the prompt and the reply are, found by the secret in what the tool really sent, and the session, folder and
 * turn read by their fields' names and values: worked out by the program, for the model only to explain.
 */
export const inferMapping = (records: readonly ClientProbeRecord[], probe: Probe): Inference => {
  const phrase = probePhrase(probe.secret);
  const ordered = [...records].sort((left, right) => left.receivedAt - right.receivedAt);
  const prompts = ordered.flatMap((record) =>
    textFields(record).filter((field) => field.text.includes(phrase)).map((field) => ({ record, path: field.path })));
  if (prompts.length === 0) {
    return { ok: false, reasons: ["没有一个事件的字段里出现带暗号的整句：要么用户还没在工具里发这句话，要么监听的事件里没有提问那一个"] };
  }
  const firstAt = prompts[0]!.record.receivedAt;
  const prompt = prompts.filter((candidate) => candidate.record.receivedAt === firstAt)
    .sort(preferring(/prompt|input|message|text|query/iu))[0]!;
  // The same record may hold the reply too (a tool that sends one event at a turn's end, prompt and reply in it): another
  // field of it, the one with the secret alone.
  const later = ordered.filter((record) => record.receivedAt >= prompt.record.receivedAt);
  // The reply holds the secret and not the line asking for it (that is the prompt, wherever it is repeated).
  const replies = later.flatMap((record) =>
    textFields(record).filter((field) => field.text.includes(probe.secret) && !field.text.includes(PROBE_PHRASE_PREFIX))
      .map((field) => ({ record, path: field.path })));
  const transcripts = later.flatMap((record) =>
    record.transcripts.filter((entry) => entry.matched).map((entry) => ({ record, path: entry.field, format: entry.format })));
  let reply: Mapping["reply"];
  let replyRecord: ClientProbeRecord;
  const notes: string[] = [];
  if (replies.length > 0) {
    const lastAt = Math.max(...replies.map((candidate) => candidate.record.receivedAt));
    const chosen = replies.filter((candidate) => candidate.record.receivedAt === lastAt)
      .sort(preferring(/assistant|reply|response|output|message|result|answer/iu))[0]!;
    reply = { event: chosen.record.event, source: "field", field: chosen.path };
    replyRecord = chosen.record;
  } else if (transcripts.length > 0) {
    // The latest event that read it, and of the formats that read it there, the first the engine lists: Claude Code's,
    // Codex's and Droid's lines are read alike, and one turn does not tell them apart.
    const last = transcripts.at(-1)!.record;
    const order = supportedTranscriptFormats();
    const there = transcripts.filter((entry) => entry.record === last).sort((left, right) => order.indexOf(left.format) - order.indexOf(right.format));
    const chosen = there[0]!;
    reply = { event: chosen.record.event, source: "transcript", format: chosen.format as never, field: chosen.path };
    replyRecord = chosen.record;
    const also = [...new Set(there.slice(1).map((entry) => entry.format))];
    notes.push(`回复不在事件字段里，要从 ${chosen.path} 指向的会话记录里读（${chosen.format} 格式读出了暗号${also.length === 0 ? "" : `；${also.join("、")} 格式也读得出，这几种读法相同，取了第一个`}）`);
  } else {
    return {
      ok: false,
      reasons: [
        "提问之后没有一个事件的字段里出现暗号，支持的会话记录格式也都没读出它：" +
          "可能工具的回复还没写完、监听的事件里没有回复结束的那一个，或者它的会话记录格式 Paraself 还不认识",
      ],
    };
  }

  // A field under a key that changes with each session (an id, a hash) cannot be named once for every turn: said so
  // before anything else is said of the fields, and no such path in what is said.
  const DYNAMIC = "要读的字段放在随会话变化的键下面（像 id 或哈希），没法用一个固定的字段路径接入";
  if ([prompt.path, reply.field].some(isDynamicPath)) return { ok: false, reasons: [DYNAMIC] };
  // Each found in the prompt's input and the reply's alike, with the same value: one session, one turn.
  const shared = (pattern: RegExp, maximum: number, exclude: readonly string[] = []) => {
    const inPrompt = new Map(textFields(prompt.record, maximum).map((field) => [field.path, field.text]));
    return textFields(replyRecord, maximum)
      .filter((field) => inPrompt.get(field.path) === field.text && named(field.path, pattern) && !exclude.includes(field.path))
      .sort(shortestFirst);
  };
  // An id field by its name first (session_id, conversationId); one that names a kind of thing (chat_type) never. Two
  // with different values say nothing of which is the session's, and none is taken.
  const sessions = shared(/session|conversation|chat|thread/iu, HOOK_FIELD_LIMITS.sessionId)
    .filter((field) => !named(field.path, /type|kind|name|mode/iu));
  if (sessions.some((field) => isDynamicPath(field.path))) return { ok: false, reasons: [DYNAMIC] };
  const ids = sessions.filter((field) => named(field.path, /^(?:session|conversation|thread|chat)[_-]?id$/iu));
  const pool = ids.length > 0 ? ids : sessions;
  const session = pool[0];
  if (session === undefined) return { ok: false, reasons: ["提问和回复两个事件里，找不到值相同、名字像会话 id 的字段（session_id、conversationId 之类）"] };
  if (new Set(pool.map((field) => field.text)).size > 1) {
    return { ok: false, reasons: [`有几个字段都像会话 id，值又不一样（${pool.map((field) => shownPath(field.path)).join("、")}），分不清哪个是`] };
  }
  const directories = textFields(replyRecord, HOOK_FIELD_LIMITS.cwd)
    .filter((field) => isPath(field.text) && named(field.path, /cwd|work|dir|root|project|folder|path/iu) && !named(field.path, /transcript|log|file|history|session/iu))
    .sort(preferring(/^cwd$|^workdir$|^working_?dir/iu));
  const cwd = directories[0];
  if (cwd === undefined) return { ok: false, reasons: ["回复那个事件里找不到工作目录（名字像 cwd、workspace、project 的路径字段）"] };
  const turn = shared(/turn|prompt_?id|request_?id|message_?id|generation/iu, HOOK_FIELD_LIMITS.turnId, [session.path])[0];
  const chosen = new Set([reply.field, session.path, cwd.path, turn?.path]);
  const ending = textFields(replyRecord, 100)
    .filter((field) => !chosen.has(field.path) && named(field.path, /reason|status|stop|finish|termination/iu) && !field.text.includes(probe.secret))
    .sort(shortestFirst)[0];
  if (ending !== undefined) notes.push(`回复事件里 ${ending.path} 的值算作「正常完成」；同一事件别的值（如会话关闭）不当回复`);
  if ([cwd.path, turn?.path, ending?.path].some((path) => path !== undefined && isDynamicPath(path))) return { ok: false, reasons: [DYNAMIC] };
  return {
    ok: true,
    notes,
    mapping: {
      hooks: probe.hooks,
      prompt: { event: prompt.record.event, field: prompt.path },
      reply,
      fields: { sessionId: session.path, cwd: cwd.path, ...(turn === undefined ? {} : { turnId: turn.path }) },
      ...(ending === undefined ? {} : { complete: { field: ending.path, values: [ending.text] } }),
    },
  };
};

const typeOf = (value: unknown): string => {
  if (typeof value === "string") return isPath(value) ? "文本(路径)" : "文本";
  if (typeof value === "number") return "数字";
  if (typeof value === "boolean") return "真假";
  if (value === null || value === undefined) return "空";
  return Array.isArray(value) ? "列表" : "对象";
};

/** A key that looks like a value (an id, a hash, a long number, a date): one that changes with each session. */
export const isDynamicSegment = (segment: string): boolean =>
  (segment.length >= 16 && /\d/u.test(segment)) || /^[0-9a-f-]{12,}$/iu.test(segment) || /^\d{6,}$/u.test(segment);

export const isDynamicPath = (path: string): boolean => path.split(".").some(isDynamicSegment);

/** Such a key is not said: the field's place is enough. */
export const shownPath = (path: string): string => path.split(".").map((segment) => (isDynamicSegment(segment) ? "‹键›" : segment)).join(".");

/**
 * What the model is told of what the probe caught: each event's name, its fields' paths and types, where the secret
 * was found, and which transcript format read it. No value of the tool's input is in it.
 */
export const describeRecords = (records: readonly ClientProbeRecord[], secret: string): string => {
  const phrase = probePhrase(secret);
  const lines = [...records].sort((left, right) => left.receivedAt - right.receivedAt).slice(0, 20).map((record, index) => {
    const fields = hookInputFields(record.input, { count: 60 }).map(({ path, value }) => {
      const mark = typeof value !== "string" ? "" : value.includes(phrase) ? "（含整句暗号）" : value.includes(secret) ? "（含暗号）" : "";
      return `${shownPath(path)}: ${typeOf(value)}${mark}`;
    });
    const transcripts = record.transcripts.map((entry) => `${shownPath(entry.field)} 按 ${entry.format} 格式${entry.matched ? "读出了暗号" : "没读出暗号"}`);
    return [`事件 ${index + 1}：${record.event}`, `  字段：${fields.join("；") || "（没有）"}`, ...(transcripts.length === 0 ? [] : [`  会话记录：${transcripts.join("；")}`])].join("\n");
  });
  return lines.length === 0 ? "探针没有收到任何事件。" : lines.join("\n");
};

export interface PlanCheck {
  problems: string[];
  preview: Extract<OnboardingCard, { kind: "plan" }>["preview"] | null;
}

/**
 * A proposed client tried on what the probe caught, as the capture would read it: the prompt reads the line with the
 * secret, the reply the secret, the session and the folder are there, and its hooks are where the probe's were.
 */
export const checkPlan = (
  client: CustomClient,
  records: readonly ClientProbeRecord[],
  probe: Probe,
  context: { command: string | null; mcpAddSeen: boolean },
): PlanCheck => {
  const problems: string[] = [];
  const phrase = probePhrase(probe.secret);
  if (client.hooks.file !== probe.hooks.file || client.hooks.format !== probe.hooks.format) {
    problems.push(`hooks 要和探针用的一样：file ${probe.hooks.file}，format ${probe.hooks.format}`);
  }
  for (const event of [client.prompt.event, client.reply.event]) {
    if (!probe.events.includes(event)) problems.push(`事件 ${event} 不在探针监听过的事件里（${probe.events.join("、")}），没法验证`);
  }
  if ((client.command ?? null) !== context.command) {
    problems.push(context.command === null ? "这个工具没有确认过命令名，command 要留空" : `command 要是确认过的 ${context.command}`);
  }
  // Registered by its own command only where its help offers one; its configuration file is checked where it is.
  if (client.mcp.mode === "command" && !context.mcpAddSeen) problems.push("检查命令时没在帮助里看到 mcp add，不能用命令注册 MCP；可以选 none，或写进它的 MCP 配置文件（file）");
  const promptRecord = records.find((record) =>
    record.event === client.prompt.event && (text(readHookField(record.input, client.prompt.field)) ?? "").includes(phrase));
  if (promptRecord === undefined) problems.push(`按 prompt.field ${client.prompt.field} 读不到用户发的那句话`);
  const replyRecord = records.find((record) => {
    // The prompt's own record too, another field of it: a tool that sends prompt and reply in one event.
    if (record.event !== client.reply.event) return false;
    const reply = client.reply;
    // Read as the inference reads it: the secret alone, not the line asking for it repeated in the turn's end.
    const replied = text(readHookField(record.input, reply.field)) ?? "";
    return reply.source === "field"
      ? replied.includes(probe.secret) && !replied.includes(PROBE_PHRASE_PREFIX)
      : record.transcripts.some((entry) => entry.field === reply.field && entry.format === reply.format && entry.matched);
  });
  if (replyRecord === undefined) problems.push(`按 reply（${client.reply.source} ${client.reply.field}）读不到带暗号的回复`);
  if (promptRecord === undefined || replyRecord === undefined || problems.length > 0) return { problems, preview: null };
  const asked = previewCustomClientSample(client, promptRecord.input);
  const answered = previewCustomClientSample(client, replyRecord.input);
  if (asked.sessionId.state !== "text") problems.push(`提问事件里按 ${client.fields.sessionId} 读不到会话 id`);
  if (answered.sessionId.state !== "text") problems.push(`回复事件里按 ${client.fields.sessionId} 读不到会话 id`);
  if (answered.cwd.state !== "text") problems.push(`回复事件里按 ${client.fields.cwd} 读不到工作目录`);
  // One turn of one session: its prompt and its reply carry the same session, and the same turn where there is one.
  if (asked.sessionId.state === "text" && answered.sessionId.state === "text" && asked.sessionId.text !== answered.sessionId.text) {
    problems.push(`提问和回复两个事件里，${client.fields.sessionId} 的值不一样，它不是会话 id`);
  }
  if (client.fields.turnId !== undefined && (asked.turnId.state !== "text" || answered.turnId.state !== "text" || asked.turnId.text !== answered.turnId.text)) {
    problems.push(`提问和回复两个事件里，${client.fields.turnId} 的值不一样或读不到，它不是轮次 id`);
  }
  if (answered.complete === false) problems.push(`回复事件按 complete（${client.complete?.field}）不算正常完成，回复会被丢掉`);
  if (problems.length > 0) return { problems, preview: null };
  const shown = (reading: { state: string; text?: string }): string => (reading.state === "text" ? reading.text! : "");
  return {
    problems,
    preview: {
      prompt: shown(asked.prompt),
      reply: answered.reply === null ? `从会话记录读到了暗号 ${probe.secret}` : shown(answered.reply),
      sessionId: shown(answered.sessionId),
      cwd: shown(answered.cwd),
      turnId: answered.turnId.state === "text" ? answered.turnId.text : null,
      complete: answered.complete,
    },
  };
};
