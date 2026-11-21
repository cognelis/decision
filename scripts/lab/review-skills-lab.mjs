// Pure pieces of the paraself-review / paraself-memory acceptance lab (no process is started here): the frozen seed, what a
// tool call and its result may be (bound to the one seeded record they name), the client commands, and what an event
// stream proves. Security notes: docs/review-skills-lab.md. Everything fails closed.
import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import {
  CONTENT_FIELDS, CONTEXT_KEYS, EMPTY_SCOPE, FIXED, RECORD_KEYS, SOURCE_REF_KEYS, checkResult as legacyCheckResult, checkTaskScope, only, said, same, textParts, unexplained,
} from "./mcp-guard.mjs";

export const sha256 = (value) => createHash("sha256").update(value).digest("hex");
export const TOOLS = ["search_decision_context", "consult_decision_principles", "search_obsidian_notes", "get_obsidian_note"];
export const SECRET_NAME = /KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL|AUTH/iu;
const JOURNAL = /^Decision Journal\//u;

// ---------------------------------------------------------------- seed (the only trusted source)
const walk = (dir, base = dir) => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
  const path = join(dir, entry.name);
  if (entry.isSymbolicLink()) throw new Error(`Seed holds a symbolic link: ${relative(base, path)}`);
  return entry.isDirectory() ? walk(path, base) : [relative(base, path).split("\\").join("/")];
});

/** The seed vault as written on disk: each note's text and hash. `decision` = under Decision Journal, `note` = ordinary. */
export const loadSeed = (vaultDir) => {
  const files = walk(vaultDir).filter((path) => path.toLowerCase().endsWith(".md")).sort().map((path) => {
    const text = readFileSync(join(vaultDir, path), "utf8");
    const id = JOURNAL.test(path) ? text.match(/^id: "?([^"\n]+)"?$/mu)?.[1] ?? null : null;
    return { path, text, hash: sha256(text), kind: JOURNAL.test(path) ? "decision" : "note", id,
      title: text.match(/^# (.+)$/mu)?.[1] ?? basename(path, ".md") };
  });
  if (files.some((file) => file.kind === "decision" && file.id === null)) throw new Error("A seeded decision has no id");
  return { files, byPath: new Map(files.map((file) => [file.path, file])), byId: new Map(files.filter((f) => f.id).map((f) => [f.id, f])) };
};

/** `shasum -a 256` lines ("<hash>  ./<path>") against the files now there, and nothing else in the tree. */
export const verifyFrozen = (dir, hashesFile = join(dir, "HASHES.sha256")) => {
  const expected = new Map(readFileSync(hashesFile, "utf8").split("\n").filter(Boolean).map((line) => [line.slice(66).replace(/^\.\//u, ""), line.slice(0, 64)]));
  const present = walk(dir).filter((path) => path !== "HASHES.sha256");
  const problems = [
    ...present.filter((path) => !expected.has(path)).map((path) => `unlisted file ${path}`),
    ...[...expected].filter(([path]) => !present.includes(path)).map(([path]) => `missing file ${path}`),
    ...present.filter((path) => expected.has(path) && sha256(readFileSync(join(dir, path))) !== expected.get(path)).map((path) => `changed file ${path}`),
  ];
  if (problems.length > 0) throw new Error(`Frozen set differs: ${problems.join("; ")}`);
  return expected.size;
};

// ---------------------------------------------------------------- checks of a call and its result
const fail = (reason) => ({ ok: false, reason });
const ok = { ok: true };
const normal = (text) => text.replace(/\s+/gu, " ").trim();
// plainText of apps/desktop/src/main/obsidian-search/obsidian-search-service.ts:262-273, copied by hand: a search hit's snippet is the
// chunk with Markdown marks taken out, so it is a piece of the note's plain text, not of its raw text.
const plainText = (value) => value
  .replace(/!\[\[/gu, "[[").replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/gu, "$2").replace(/\[\[([^\]]+)\]\]/gu, "$1")
  .replace(/!\[([^\]]*)\]\([^)]*\)/gu, "$1").replace(/\[([^\]]+)\]\([^)]*\)/gu, "$1").replace(/<[^>]*>/gu, " ")
  .replace(/^\s{0,3}(?:#{1,6}|>|[-+*]|\d+[.)])\s+/gmu, "").replace(/```[^\n]*|~~~[^\n]*/gu, " ").replace(/[`*_~]+/gu, "").replace(/\s+/gu, " ").trim();
/** Every `…`-separated piece of snippet is a contiguous piece of the note: of its text as written, or of its plain text (whitespace-normalized). */
export const isNoteExcerpt = (snippet, noteText) => {
  const haystacks = [normal(noteText), normal(plainText(noteText))];
  const pieces = snippet.split(/…|\.\.\./u).map(normal).filter(Boolean);
  return pieces.length > 0 && pieces.every((piece) => haystacks.some((haystack) => haystack.includes(piece)));
};

/** Arguments a client may send. Paths must name a seeded ordinary note exactly; nothing else is opened. */
const ARG_KEYS = {
  search_decision_context: ["query", "recordId", "source", "mode", "minSimilarity", "includeWithdrawn", "project", "includeOutOfScope", "relation", "limit", "offset", "repositoryPath", "module", "layer", "files"],
  consult_decision_principles: ["question", "options", "context", "project", "languages"],
  search_obsidian_notes: ["query", "limit"],
  get_obsidian_note: ["path", "startLine", "startColumn", "maxLines"],
};
export const checkArgs = (tool, args, seed) => {
  if (!TOOLS.includes(tool)) return fail(`tool ${tool} is not opened`);
  if (args === null || typeof args !== "object" || Array.isArray(args)) return fail("arguments are not an object");
  // Unknown keys are refused as the tool's own strict schema would (bridge: mcp-context.ts decisionContextToolShape, mcp-server.ts
  // inputSchema, obsidian-notes.ts request schemas); the shape-2 keys are not in the list on purpose.
  const unknown = Object.keys(args).filter((key) => !ARG_KEYS[tool].includes(key));
  if (unknown.length > 0) return fail(`argument ${unknown[0]} is not one of ${tool}'s`);
  const decisionArgs = checkDecisionArgs(tool, args);
  if (!decisionArgs.ok) return decisionArgs;
  // The MCP stays inside the same task the shell does: the one synthetic repository, or none (the bridge then infers nothing
  // from the client: the guard starts it with the lab root as its directory).
  if ("repositoryPath" in args) {
    const path = args.repositoryPath, repo = seed.taskRepo;
    // The task repository or a directory inside it, spelled canonically (no "..", ".", doubled or trailing slash): never a path beside or above it.
    const inside = typeof path === "string" && repo !== undefined && (path === repo || (path.startsWith(`${repo}/`) && !path.slice(repo.length + 1).split("/").some((part) => part === "" || part === "." || part === "..")));
    if (!inside) return fail("repositoryPath is not the synthetic task repository");
  }
  const int = (value, min, max) => Number.isInteger(value) && value >= min && value <= max;
  if (tool === "search_obsidian_notes" && (typeof args.query !== "string" || args.query.trim() === "" || args.query.length > 200 || ("limit" in args && !int(args.limit, 1, 10)))) return fail("search_obsidian_notes arguments");
  if (tool === "get_obsidian_note" && (("startLine" in args && !int(args.startLine, 1, 1e9)) || ("startColumn" in args && !int(args.startColumn, 0, 1e9)) || ("maxLines" in args && !int(args.maxLines, 1, 400)))) return fail("get_obsidian_note arguments");
  if (tool === "get_obsidian_note") {
    if (typeof args.path !== "string" || /[\0\r\n]/u.test(args.path) || args.path.startsWith("/") || args.path.split("/").some((part) => part === ".." || part === "." || part === "")) return fail("unsafe note path");
    const file = seed.byPath.get(args.path);
    if (!file || file.kind !== "note") return fail("path is not a seeded ordinary note");
  }
  return ok;
};

const lines = (text) => { const parts = text.split("\n"); return text.endsWith("\n") ? parts.slice(0, -1) : parts; };

// The App's own sentences (apps/desktop/src/main/obsidian-search/obsidian-note-tools.ts:19-26, copied by hand) and the bridge's
// rendering of a checked response (apps/bridge/src/mcp-notes.ts:20-50). A message is accepted by decomposing it into them.
const SEARCH_WORDS = {
  unavailable: "Obsidian 笔记索引现在不可用，没有检索；这不代表没有相关笔记。",
  notBuilt: "Obsidian 笔记索引还没有建好，结果可能不全；这不代表没有相关笔记。",
  indexing: "Obsidian 笔记索引正在更新，结果可能不全。",
  missed: "有的笔记没能建立索引，结果可能不全。",
  dropped: "有命中的笔记现在读不到了（刚被删除、排除或改成了链接），已从结果里去掉。",
  semanticOff: "本地语义检索不可用，只按关键词检索。",
};
const READ_WORDS = { unavailable: "Obsidian 笔记索引现在不可用，没有读取。",
  notAvailable: "这个路径不是可检索的普通笔记（不存在、被排除、在隐藏或 Decision Journal 文件夹里、是链接、过大，或尚未建立索引），没有读取。" };
const NOT_SCOPED = "普通笔记没有项目范围，只作参考，不是已采纳的原则或决定。";
const KINDS = { keyword: "关键词", semantic: "语义相近", hybrid: "关键词与语义" };
const searchMessage = (message) => {
  if (typeof message !== "string") return null;
  if (message === SEARCH_WORDS.unavailable) return { others: false, semanticOff: false };
  let rest = message, others = false, semanticOff = false;
  for (const [name, sentence] of Object.entries(SEARCH_WORDS)) {
    if (name === "unavailable" || !rest.includes(sentence)) continue;
    rest = rest.replace(sentence, "");
    if (name === "semanticOff") semanticOff = true; else others = true;
  }
  return rest === "" ? { others, semanticOff } : null;
};
const readOkMessage = (message) => message === "" || message === "起始行超过了笔记末尾。"
  || /^只读到第 \d+ 行(?:的一部分)?；从 startLine \d+(?:、startColumn \d+)? 继续读。$/u.test(message);
/** What mcp-notes.ts searchText / readText make of a checked response. */
export const searchText = (search) => {
  if (search.availability === "unavailable") return search.message;
  const head = search.results.length === 0 ? `没有找到相关的普通笔记${search.availability === "partial" ? "，但检索不完整，不能当作没有" : ""}。` : `找到 ${search.results.length} 篇普通笔记。`;
  const hits = search.results.map((hit) => `- \`${hit.path}${hit.line === null ? "" : `:${hit.line}`}\` 《${hit.title}》${hit.heading === null ? "" : ` › ${hit.heading}`}（${KINDS[hit.matchKind]}）`
    + `${hit.changedSinceIndexed ? "（索引后已改动，以原文为准）" : ""}\n  ${hit.snippet}`);
  return [head + search.message, ...hits, NOT_SCOPED].join("\n");
};
export const readText = (read) => {
  if (read.note === null) return read.message;
  const { note } = read;
  const range = note.totalLines === 0 ? "（空笔记）" : `第 ${note.startLine}–${note.endLine} 行（共 ${note.totalLines} 行）`;
  return [`《${note.title}》 \`${read.path}\` ${range}${note.changedSinceIndexed ? "，索引后已改动，以下是现在的原文" : ""}`, note.text, ...(read.message === "" ? [] : [read.message]), NOT_SCOPED].join("\n");
};

/** A heading is "parent > child" (mcp-notes.test): every part is a heading line of the note, in that order. */
const headingPathIn = (heading, text) => {
  if (typeof heading !== "string" || heading.length > 1000 || heading === "") return false;
  const found = text.split("\n").map((line) => line.match(/^#{1,6}\s+(.*?)\s*#*\s*$/u)?.[1]).filter((title) => title !== undefined);
  let from = 0;
  return heading.split(" > ").every((part) => { const at = found.indexOf(part, from); from = at + 1; return at >= 0; });
};

/** search_obsidian_notes (packages/protocol/src/obsidian-notes.ts): each hit bound to the one note its path names. */
export const checkObsidianSearch = (value, seed) => {
  const keys = ["availability", "semanticAvailable", "indexedNotes", "discoveredNotes", "projectScope", "message", "results"];
  if (value === null || typeof value !== "object" || Object.keys(value).sort().join() !== [...keys].sort().join()) return fail("search response keys");
  if (!["ready", "partial", "unavailable"].includes(value.availability)) return fail("availability");
  if (typeof value.semanticAvailable !== "boolean" || value.projectScope !== "none") return fail("flags");
  const notes = seed.files.filter((file) => file.kind === "note").length;
  for (const key of ["indexedNotes", "discoveredNotes"]) if (!Number.isInteger(value[key]) || value[key] < 0 || value[key] > notes) return fail(`${key} beyond the seed`);
  if (value.indexedNotes > value.discoveredNotes) return fail("indexed beyond discovered");
  const said_ = searchMessage(value.message);
  if (said_ === null) return fail("message is not the App's fixed wording");
  if (value.availability === "unavailable" ? value.message !== SEARCH_WORDS.unavailable : value.availability !== (said_.others ? "partial" : "ready") || value.semanticAvailable === said_.semanticOff) return fail("availability or semanticAvailable contradicts its message");
  if (!Array.isArray(value.results) || value.results.length > 10) return fail("results");
  if (value.availability === "unavailable" && value.results.length > 0) return fail("results of an unavailable search");
  const hitKeys = ["path", "title", "heading", "snippet", "matchKind", "line", "contentHash", "changedSinceIndexed"].sort().join();
  for (const hit of value.results) {
    if (hit === null || typeof hit !== "object" || Object.keys(hit).sort().join() !== hitKeys) return fail("hit keys");
    const note = seed.byPath.get(hit.path);
    if (typeof hit.path !== "string" || !note || note.kind !== "note") return fail("hit names no seeded ordinary note");
    if (typeof hit.title !== "string" || hit.title.length > 1000 || hit.title !== note.title || hit.contentHash !== note.hash || hit.changedSinceIndexed !== false) return fail("hit title/hash is not its note's");
    if (hit.heading !== null && !headingPathIn(hit.heading, note.text)) return fail("heading is not a heading path of its note");
    if (typeof hit.snippet !== "string" || hit.snippet.length > 2000 || !isNoteExcerpt(hit.snippet, note.text)) return fail("snippet is not an excerpt of its note");
    if (!["keyword", "semantic", "hybrid"].includes(hit.matchKind)) return fail("matchKind");
    if (hit.line !== null && (!Number.isInteger(hit.line) || hit.line < 1 || hit.line > lines(note.text).length)) return fail("line outside its note");
  }
  return ok;
};

/** get_obsidian_note: the text must be exactly the lines asked of the seeded note, from startColumn. */
export const checkObsidianRead = (value, seed, args) => {
  const keys = ["status", "path", "projectScope", "message", "note"];
  if (value === null || typeof value !== "object" || Object.keys(value).sort().join() !== [...keys].sort().join()) return fail("read response keys");
  if (!["ok", "not_available", "unavailable"].includes(value.status) || value.projectScope !== "none" || value.path !== args.path) return fail("status/path");
  if (value.status === "unavailable" ? value.message !== READ_WORDS.unavailable : value.status === "not_available" ? value.message !== READ_WORDS.notAvailable : !readOkMessage(value.message)) return fail("message is not the App's fixed wording");
  if (value.status !== "ok") return value.note === null ? ok : fail("note beside a refusal");
  const note = seed.byPath.get(value.path);
  const n = value.note;
  const noteKeys = ["title", "contentHash", "changedSinceIndexed", "totalLines", "startLine", "startColumn", "endLine", "truncated", "nextStartLine", "nextStartColumn", "text"];
  if (!note || n === null || typeof n !== "object" || Object.keys(n).sort().join() !== [...noteKeys].sort().join()) return fail("note keys");
  if (n.title !== note.title || n.contentHash !== note.hash || n.changedSinceIndexed !== false) return fail("note title/hash");
  const int = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;
  const all = lines(note.text);
  const total = all.length;
  // Every field by its schema's type and bounds first (obsidian-notes.ts), then against the request and the seeded note.
  if (typeof n.truncated !== "boolean" || typeof n.text !== "string" || n.text.length > 24_000 || !int(n.totalLines, 0, 1e9) || !int(n.startLine, 1, 1e9) || !int(n.startColumn, 0, 1e9) || !int(n.endLine, 0, 1e9)) return fail("note field types");
  if (n.totalLines !== total) return fail("totalLines is not the note's");
  const askedLine = args.startLine ?? 1;
  if (n.startLine !== askedLine) return fail("startLine is not the one asked for");
  const lineLength = (all[n.startLine - 1] ?? "").length;
  if (n.startColumn !== Math.min(args.startColumn ?? 0, lineLength)) return fail("startColumn is not the one asked for");
  const remainder = (n.startLine > total ? [] : all.slice(n.startLine - 1)).map((line, index) => (index === 0 ? line.slice(n.startColumn) : line)).join("\n");
  const maxLines = args.maxLines ?? 200;
  if (n.endLine > total || n.endLine < n.startLine - 1 || n.endLine - n.startLine + 1 > maxLines) return fail("endLine outside the request");
  if (!n.truncated) {
    if (n.nextStartLine !== null || n.nextStartColumn !== null) return fail("continuation beside a full read");
    const expected = (n.startLine > total ? [] : all.slice(n.startLine - 1, n.endLine)).map((line, index) => (index === 0 ? line.slice(n.startColumn) : line)).join("\n");
    if (n.text !== expected && n.text !== `${expected}\n`) return fail("text is not the seeded lines");
    if (/^只读到第 /u.test(value.message)) return fail("truncation message beside a full read");
    if (value.message === "起始行超过了笔记末尾。" && !(n.startLine > total && total > 0)) return fail("past-the-end message inside the note");
    return ok;
  }
  // Truncated: the text is a prefix of what remains of the note, the continuation integers lie after it and inside the note,
  // and the message names exactly these numbers; nothing in them is free text.
  if (!int(n.nextStartLine, n.startLine, total) || !int(n.nextStartColumn, 0, (all[n.nextStartLine - 1] ?? "").length)) return fail("continuation outside the note");
  if (n.nextStartLine === n.startLine && n.nextStartColumn <= n.startColumn) return fail("continuation does not advance");
  if (!remainder.startsWith(n.text) || n.text.length >= remainder.length) return fail("truncated text is not a proper prefix of the seeded note");
  const m = value.message.match(/^只读到第 (\d+) 行(的一部分)?；从 startLine (\d+)(?:、startColumn (\d+))? 继续读。$/u);
  if (!m || Number(m[1]) !== n.endLine || Number(m[3]) !== n.nextStartLine || Number(m[4] ?? 0) !== n.nextStartColumn || (m[2] !== undefined) !== (n.nextStartColumn > 0)) return fail("message does not name the continuation fields");
  return ok;
};

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const SOURCES = ["summarize", "decisions", "principles", "preferences", "ideas", "experiences"];
/** The query the skill sends, in full: any of the six sources (one or a list), any mode (checkArgs holds the types). */
export const checkDecisionArgs = (tool, args) => {
  if (tool !== "search_decision_context") return ok;
  const sources = typeof args.source === "string" ? [args.source] : args.source;
  if (sources !== undefined && (!Array.isArray(sources) || sources.length === 0 || sources.length > 6 || new Set(sources).size !== sources.length || !sources.every((item) => SOURCES.includes(item)))) return fail("search source is not one of the six or a list of them");
  if ("mode" in args && !["keyword", "semantic", "hybrid"].includes(args.mode)) return fail("search mode");
  if ("minSimilarity" in args && !(typeof args.minSimilarity === "number" && args.minSimilarity >= 0 && args.minSimilarity <= 1)) return fail("search minSimilarity");
  if ("includeWithdrawn" in args && typeof args.includeWithdrawn !== "boolean") return fail("search includeWithdrawn");
  return ok;
};

// decisionContextResponseSchema as the baseline has it (packages/protocol/src/decision-context.ts): every key of every level
// held to the schema, every query-independent field of a record equal to the App's own reading of the seed.
const RECORD_KEYS_EXT = [...RECORD_KEYS, "similarity", "amendment", "signal", "experience"];
const SNAPSHOT_FIELDS = [...CONTENT_FIELDS, "amendment", "signal", "experience"];
const count = (value) => Number.isInteger(value) && value >= 0;
const checkRecordExt = (record, allow, words) => {
  if (!only(record, RECORD_KEYS_EXT)) return "unknown key in a record";
  const entry = allow.find((item) => item.source === record.source && item.id === record.id);
  if (!entry) return "record outside the seeded catalog";
  if (!isObject(entry.record) || typeof entry.note !== "string") return "record without a trusted snapshot";
  const ref = record.sourceRef;
  if (!only(ref, SOURCE_REF_KEYS) || ref.contentHash !== entry.contentHash) return "record outside the seeded catalog";
  for (const field of SNAPSHOT_FIELDS) if (!same(record[field], entry.record[field])) return `record ${field} differs from the seed`;
  for (const field of ["relativePath", "client", "sessionId", "contentHash"]) if (!same(ref[field], entry.record.sourceRef?.[field])) return `sourceRef ${field} differs from the seed`;
  if (typeof ref.excerpt !== "string" || !ref.excerpt.split("…").every((piece) => entry.note.includes(piece.replace(/^\n+|\n+$/gu, ""))) || !Number.isInteger(ref.excerptStartLine) || ref.excerptStartLine < 1 || typeof ref.truncated !== "boolean") return "excerpt not from the seed";
  if (record.similarity !== undefined && !(typeof record.similarity === "number" && record.similarity >= -1 && record.similarity <= 1 && record.matchReason.startsWith("语义相近"))) return "similarity without a meaning match";
  if (!said(record.matchReason, words)) return "matchReason not in fixed words";
  if (!Array.isArray(record.warnings) || !record.warnings.every((warning) => said(warning, words))) return "warning not in fixed words";
  const applies = record.applicability;
  if (applies !== undefined) {
    if (!only(applies, ["status", "reasons", "scope"]) || !["scope_match", "needs_review", "out_of_scope"].includes(applies.status)) return "applicability beyond its schema";
    if (!Array.isArray(applies.reasons) || !applies.reasons.every((reason) => said(reason, words))) return "applicability reason not in fixed words";
    if (!same(applies.scope, entry.record.applicability?.scope ?? EMPTY_SCOPE)) return "applicability scope differs from the seed";
  }
  return null;
};
/** structuredContent as forwarded: only the schema's keys, rebuilt from what was checked (the extended record keys included). */
export const rebuildContext = (structured) => ({ message: structured.message, availability: structured.availability, context: {
  ...Object.fromEntries(CONTEXT_KEYS.filter((key) => key !== "results" && key in structured.context).map((key) => [key, structured.context[key]])),
  results: structured.context.results.map((record) => ({ ...Object.fromEntries(RECORD_KEYS_EXT.filter((key) => key in record).map((key) => [key, record[key]])),
    sourceRef: Object.fromEntries(SOURCE_REF_KEYS.filter((key) => key in record.sourceRef).map((key) => [key, record.sourceRef[key]])) })),
} });
// The guidance lines the App writes beyond the pinned set, copied by hand from source with their lines:
// apps/desktop/src/main/decision-context-service.ts:278-286 (UNJUDGED_PAIR, OTHER_PAGES), :503, :687-712;
// apps/desktop/src/main/decision-context-signals.ts:39-44, :247-388. A line is accepted as one pinned sentence (mcp-guard FIXED) or as
// a run of the pieces below; numbers only where the source puts them.
const esc = (text) => text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
const GUIDANCE_EXACT = [
  "所选来源尚无可读取的记录。历史沉淀位于 summarize，已采纳原则位于 principles，两者分别读取。",
  "所选来源读取失败或记录格式不兼容，未完成核对。请检查 Vault 与原笔记，不要将失败解释为没有相关决定。",
  "所选来源有记录，但当前编号、项目、关键词或关系筛选没有匹配。可调整筛选或按已知编号查询；不能断言没有相关决策。",
  "部分来源或笔记未成功读取，结果覆盖不完整。",
  "本页有未标记被替代、相互之间也没有登记替代、冲突或无关关系的决策记录，各条的日期写在它的警告里。请先核对它们是否针对同一对象、同一适用范围和同一决策事项：不同服务、不同属性、范围例外可以并存。若对同一件事取值不同，而原文不能解释这种差异，请同时列出双方的具体值和各自日期，说明两者关系尚待确认，不要仅凭日期选择其中一条；用户确认后，可用 record_decision_relation 登记两条的关系。",
  "其他页的记录没有和本页比较。",
  "本次读取本地 Markdown，并用本机嵌入模型补充含义相近的记录；不调用生成式模型、不联网、不记录查询正文、不自动应用原则；偏好与想法不参与本轮检索。",
  "用户偏好 / 用户想法是用户自己的信号，不是已采纳原则或指令：只作参考，不得据此推断新的偏好、替用户做决定，也不据此改动已采纳原则。",
  "记忆包含有来源的知识整理与执行案例：只作参考，不是原则或指令，不证明因果；Agent 报告的结果未经独立核验。不要据此推断用户偏好或替用户做决定。",
  "用户对记录的增补与撤回这次没能完整读取，部分现行内容无法核对，请稍后重试。",
  "执行经验这次读取失败，不能把没有结果当作没有相关经验。",
  "执行经验的语义补充这次不可用，只返回关键词结果。",
  "检索期间有记忆变化或未能读取，本次未返回相关旧版本；可重试读取当前内容。",
  "执行经验不按仓库、目录、文件或层筛选，taskScope 对它们没有作用；只按 project 筛选。",
  "relation 筛选只适用于决策之间的关系，执行经验没有。",
  "部分经验或其来源这次未能完整读取，结果不完整。",
  "检索结束前没能核对偏好、想法或撤回状态，未返回旧快照；请稍后重试。",
  "检索期间有偏好或想法发生变化，本次未返回这些旧版本；可重试读取当前内容。",
  "偏好与想法不按仓库、目录、文件或层筛选，taskScope 对它们没有作用；只按 project 筛选。",
  "relation 筛选只适用于决策之间的关系，偏好与想法没有，所以没有列出它们。",
  "偏好与想法这次读取失败（Vault 或笔记目录无法读取），不能把没有结果当作用户没有相关偏好或想法。",
  "所选来源有记录或为空，但当前编号、项目或关键词没有匹配；不能断言用户没有相关偏好或想法。",
];
const GUIDANCE_PATTERNS = [
  "语义补充这次不可用（(?:未安装本机嵌入模型|本机嵌入未在时限内完成|本机嵌入模型出错)），只返回关键词结果；没有匹配不代表没有含义相近的记录。",
  "语义检索这次不可用（(?:未安装本机嵌入模型|本机嵌入未在时限内完成|本机嵌入模型出错)），没有返回任何结果，也没有退化成关键词结果；这不代表没有含义相近的记录。可改用 mode=keyword 或 hybrid。",
  "偏好与想法的语义补充这次不可用（(?:未安装本机嵌入模型|本机嵌入未在时限内完成|本机嵌入模型出错)），只返回关键词结果；没有匹配不代表没有含义相近的记录。",
  "执行经验的语义检索这次不可用（(?:未安装本机嵌入模型|本机嵌入未在时限内完成|本机嵌入模型出错)），没有退化成关键词结果。",
  "语义模式：只按本机向量的相似度排序（不低于 \\d+(?:\\.\\d+)?），没有关键词结果；相关不等于适用。",
  "其中 \\d+ 条只按含义找到（本机向量），排在全部关键词结果之后。",
  "历史沉淀的语义向量这次无法建立（向量索引没能升级，下次启动时重试），\\d+ 条历史沉淀没有参与语义补充。",
  "还有 \\d+ 条历史沉淀的语义向量正在后台建立，这次语义补充没有覆盖它们。",
  "有 \\d+ 条决策尚无可用于当前模型和内容版本的语义向量，已请求后台补建，这次未参与语义补充。",
  "有 \\d+ 条已采纳原则尚无可用于当前模型和内容版本的语义向量，已请求后台补建，这次未参与语义补充。",
];
const GUIDANCE_LINE = new RegExp(`^(?:${[...GUIDANCE_EXACT.map(esc), ...GUIDANCE_PATTERNS].join("|")})+$`, "u");
export const guidanceOk = (guidance) => typeof guidance === "string" && guidance.split("\n").every((line) => said(line, FIXED) || GUIDANCE_LINE.test(line));


// ------------------------------------------------------------ catalog bound to the seed's own text (not to the App's word)
const frontmatterOf = (text) => {
  const block = text.match(/^---\n([\s\S]*?)\n---\n/u)?.[1] ?? "";
  const value = (key) => { const raw = block.match(new RegExp(`^${key}: (.*)$`, "mu"))?.[1]; if (raw === undefined) return undefined; try { return JSON.parse(raw); } catch { return raw; } };
  return { id: value("id"), status: value("status"), project: value("project"), tags: value("tags") ?? [], supersedes: value("supersedes") ?? [], supersededBy: value("superseded_by") ?? null, selected: value("selected_option"), appliesWhen: value("applies_when") ?? null, caution: value("caution") ?? null };
};
/**
 * The App's reading of the seeded decisions against the seed Markdown itself: id, source, path, title, project, status, tags, the
 * summary as a piece of the note, supersession (in both directions) and the current flag, each parsed from the note. What the
 * App computes from them (relations, applicability, lifecycle) is not parsed here; it is accepted as the App's own output and said so.
 */
export const bindCatalog = (listed, seed) => {
  const problems = [];
  const decisions = seed.files.filter((file) => file.kind === "decision");
  if (listed.length !== decisions.length) problems.push(`App lists ${listed.length} records for ${decisions.length} seeded decisions`);
  const supersededBySomeone = new Set(decisions.flatMap((file) => frontmatterOf(file.text).supersedes));
  for (const record of listed) {
    const file = seed.byId.get(record.id);
    if (!file) { problems.push(`record ${record.id} is not seeded`); continue; }
    const fm = frontmatterOf(file.text);
    const expectSource = file.path.split("/")[1];
    const supersededBy = fm.supersededBy === null ? [] : [fm.supersededBy];
    const checks = [
      ["source", record.source === expectSource], ["path", record.sourceRef?.relativePath === file.path], ["hash", record.sourceRef?.contentHash === file.hash],
      // summarize titles are the file name (packages/storage/src/decision-context.ts:141)
      ["title", record.title === (expectSource === "summarize" ? basename(file.path, ".md") : file.title)],
      ["project", record.project === (fm.project ?? null)],
      ["status", record.status === fm.status],
      ["tags", same(record.tags, fm.tags)], ["supersedes", same(record.supersedes, fm.supersedes)], ["supersededBy", same(record.supersededBy, supersededBy)],
      ["summary", expectSource === "summarize" ? record.summary === fm.selected : typeof record.summary === "string" && record.summary !== "" && isNoteExcerpt(record.summary, file.text)],
      ["appliesWhen/caution", expectSource !== "summarize" || (record.appliesWhen === fm.appliesWhen && record.caution === fm.caution)],
      ["current", record.current === (fm.supersededBy === null && !supersededBySomeone.has(record.id))],
    ];
    for (const [name, pass] of checks) if (!pass) problems.push(`${record.id}: ${name} is not what the seed note says`);
  }
  return problems;
};
/** The guard's catalog entries for the App's listing: bound to the seed notes first (throws, naming the field, when any differs). */
export const catalogFromSeed = (listed, seed) => {
  const problems = bindCatalog(listed, seed);
  if (problems.length > 0) throw new Error(`The App's catalog is not the seeded decisions: ${problems.join("; ")}`);
  return listed.map((record) => ({ source: record.source, id: record.id, contentHash: record.sourceRef.contentHash, record, note: seed.byId.get(record.id).text }));
};
/** The strings a checked record may use freely: its note and the fields bindCatalog verified (never the App's other output). */
// The strings a checked record may use freely: the seed note's lines and the fields catalogFromSeed has already proved equal to what the
// note says (id, title, project, status, summary, tags, path and its parts). Nothing else the App said about itself.
const seedStrings = (allow) => allow.flatMap((entry) => {
  const r = entry.record ?? {};
  const path = r.sourceRef?.relativePath ?? "";
  return [entry.note ?? "", ...(entry.note ?? "").split("\n"), ...[r.id, r.title, r.project, r.status, r.summary, path, ...path.split("/"), basename(path, ".md"), ...(r.tags ?? [])].filter((v) => typeof v === "string")];
});
// Words mcp-context.ts adds for a meaning match beyond the pinned set (git diff 7269a75d..f4d67d16, runtime text "，相似度 N%").
const EXTRA_WORDS = ["，相似度 ", "%", "preferences", "ideas", "experiences"]; // the last three: the source names the coverage line prints (decisionContextAnySourceSchema)
/** What of a search result's prose the checked fields and the fixed words do not explain (empty = nothing). Exported for the preflight's diagnosis. */
export const textResidue = (body, structured, allow) => {
  const results = structured.context.results;
  return unexplained(body, [...FIXED, ...EXTRA_WORDS, ...GUIDANCE_EXACT, ...Object.values(structured).flatMap((v) => (typeof v === "string" ? [v] : [])), structured.context.guidance, ...structured.context.guidance.split("\n"),
    ...seedStrings(allow), ...results.flatMap((r) => [r.matchReason, ...r.warnings, ...(r.applicability?.reasons ?? [])])]);
};
export const checkContextMessage = (message, allow, { text, args, raw = false }) => {
  const result = message?.result;
  if (!isObject(result)) return "no result";
  const parts = textParts(result.content);
  if (parts === null) return "content other than text";
  const body = parts.join("\n");
  if (body.length > 64 * 1024) return "text over 64 KiB";
  const structured = result.structuredContent;
  // An error reaches a client as the guard's fixed notice: short, with no records.
  if (result.isError === true) {
    // What the bridge sent (raw, seen by the guard alone): an error with its availability word; the guard hands the client only the fixed
    // notice made from that word. What the client was shown (not raw): that notice, short, no records.
    if (raw) return only(structured, ["message", "availability", "context"]) && ["invalid_input", "scope_unresolved", "unavailable", "semantic_unavailable"].includes(structured?.availability) ? null : "error result beyond the bridge's availability words";
    return structured === undefined && body.length <= 800 ? null : "error result with content beyond a fixed notice";
  }
  if (!only(structured, ["message", "availability", "context"]) || structured.availability !== "available" || !said(structured.message ?? "", FIXED)) return "structuredContent beyond its schema or fixed words";
  const context = structured.context;
  if (!only(context, CONTEXT_KEYS) || context.contextVersion !== 1 || !["matched", "no_match", "empty", "unavailable"].includes(context.status)
    || !["complete", "partial", "unavailable"].includes(context.coverage) || !count(context.total) || !(context.nextOffset === null || count(context.nextOffset))
    || !(context.excludedByScope === undefined || count(context.excludedByScope)) || !same(context.boundary, { advisoryOnly: true, noDecisionWritten: true, noPrincipleApplied: true })) return "context beyond its schema";
  if (!Array.isArray(context.sources) || context.sources.length > 6 || !context.sources.every((item) => only(item, ["source", "status", "records", "skipped"]) && SOURCES.includes(item.source)
    && ["ready", "empty", "partial", "unavailable"].includes(item.status) && count(item.records) && count(item.skipped))) return "context sources beyond their schema";
  if (!guidanceOk(context.guidance)) return "guidance not in fixed words";
  if (context.taskScope !== undefined) { const why = checkTaskScope(context.taskScope, args); if (why) return why; }
  if (!Array.isArray(context.results) || context.results.length > 20) return "result without context.results";
  const words = [...FIXED, ...EXTRA_WORDS, ...seedStrings(allow)];
  for (const record of context.results) { const why = checkRecordExt(record, allow, words); if (why) return why; }
  if (text) { const residue = textResidue(body, structured, allow); if (residue !== "") return "text not accounted for by its records"; }
  return null;
};

/** What a client may be handed for a note tool, rebuilt from the checked inner response; null where the guard's fixed notice goes instead. */
export const noteForward = (tool, result) => {
  const key = tool === "search_obsidian_notes" ? "search" : "read";
  const inner = result.structuredContent?.[key];
  if (inner === null || inner === undefined) return null;
  const message = key === "search" ? searchText(inner) : readText(inner);
  return { ...(result.isError === true ? { isError: true } : {}), structuredContent: { message, [key]: inner }, content: [{ type: "text", text: message }] };
};

/**
 * Why a tool result may not reach the client, or null. `message` is the JSON-RPC response. The two decision tools: search against
 * the strict extended checker above (consult against mcp-guard's, unchanged since 7af5e85c), `allow` being the catalog the driver
 * read from the App. The two note tools: {message, search|read} exactly, the inner response against obsidian-notes.ts and its seeded
 * note, `message` equal to the bridge's rendering of those checked fields, and the text beside it equal to that. `text: false` = the
 * client was shown structuredContent alone (Claude Code).
 */
export const checkToolMessage = (tool, args, message, { seed, allow = [], text = true, raw = false }) => {
  if (!TOOLS.includes(tool)) return `tool ${tool} is not opened`;
  const argCheck = checkArgs(tool, args, seed);
  if (!argCheck.ok) return argCheck.reason;
  if (tool === "search_decision_context") return checkContextMessage(message, allow, { text, args, raw });
  if (tool === "consult_decision_principles") return legacyCheckResult(message, allow, { text, args, tool });
  const result = message?.result;
  if (!isObject(result)) return "no result";
  const structured = result.structuredContent;
  if (structured === undefined) return result.isError === true ? null : "success without structured content";
  const key = tool === "search_obsidian_notes" ? "search" : "read";
  if (!isObject(structured) || Object.keys(structured).sort().join() !== ["message", key].sort().join()) return `structuredContent is not {message, ${key}}`;
  const inner = structured[key];
  if (inner === null) return result.isError === true ? null : `null ${key} in a success`;
  const verdict = key === "search" ? checkObsidianSearch(inner, seed) : checkObsidianRead(inner, seed, args);
  if (!verdict.ok) return verdict.reason;
  if ((result.isError === true) !== (key === "search" ? inner.availability === "unavailable" : inner.status !== "ok")) return "isError contradicts the checked response";
  const expected = key === "search" ? searchText(inner) : readText(inner);
  if (structured.message !== expected) return "message is not the rendering of its checked fields";
  if (text && !same(result.content, [{ type: "text", text: expected }])) return "content text is not the rendering of its checked fields";
  return null;
};

/** Handshake: a known protocol version, capabilities {tools} only, serverInfo exactly paraself at the version of the package under test. */
export const PROTOCOL_VERSIONS = ["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"];
export const checkInitialize = (result, version) => {
  if (!isObject(result)) return "initialize without a result";
  if (!PROTOCOL_VERSIONS.includes(result.protocolVersion)) return "protocolVersion is not a known one";
  if (!isObject(result.capabilities) || Object.keys(result.capabilities).some((key) => key !== "tools")) return "capabilities beyond tools";
  if (typeof version !== "string" || !isObject(result.serverInfo) || result.serverInfo.name !== "paraself" || result.serverInfo.version !== version) return "serverInfo is not paraself at the package version";
  return null;
};

// ---------------------------------------------------------------- environment, commands
const CLIENT_ENV = ["HOME", "USER", "LOGNAME", "PATH", "SHELL", "TERM", "TMPDIR", "LANG", "LC_ALL", "VOLTA_HOME", "SSL_CERT_FILE", "NODE_EXTRA_CA_CERTS", "CODEX_HOME", "MODEL_PROXY_URL"];
const PROXY_NAME = /^(?:https?_proxy|all_proxy|no_proxy)$/iu;
/** Throws, naming the variables and never their values, unless env holds the allowlist (and policy proxy variables) alone. */
export const assertClientEnvironment = (env, extra = []) => {
  const refused = Object.keys(env).filter((name) => !(CLIENT_ENV.includes(name) || PROXY_NAME.test(name) || extra.includes(name) || ["PARASELF_PROVIDER_CHILD", "DECISION_PROVIDER_CHILD"].includes(name))
    || (SECRET_NAME.test(name) && !extra.includes(name)));
  if (refused.length > 0) throw new Error(`Client environment holds variables outside its allowlist: ${refused.join(", ")}`);
  if (env.PARASELF_PROVIDER_CHILD !== "1") throw new Error("PARASELF_PROVIDER_CHILD must be 1 so the user's own Paraself does not capture the lab session");
  return env;
};

/** The paths a model may read under a restricted shell: the installed skill copy and the task files, nothing else. */
export const allowedReadRoots = ({ skillDirs, taskDir }) => [...skillDirs, taskDir].map((dir) => resolve(dir));

const codexProfile = ({ roots, extraRead = ["/opt/homebrew"] }) => `{":minimal"="read","/private/tmp"="deny","/private/var"="deny",${[...extraRead, ...roots].map((path) => `${JSON.stringify(path)}="read"`).join(",")}}`;

/**
 * Codex: no user config, a read-only profile that denies /private/tmp and /private/var and grants only the skill and task
 * directories (the vault is not among them: notes come through the guarded tools alone), the shell kept for native skill
 * loading, paraself through the guard only. `off` = isolated-app CODEX_TOOLS_OFF without shell_tool alone (shell_snapshot stays off).
 */
/**
 * What the lab tells Codex about its shell, as `developer_instructions`: the tool environment and nothing else. It lists the command forms
 * `classifyCommand` accepts and says paths stay within the session's read permissions (no root is named); it says nothing of what to look for, which
 * tools or notes to use, how a task is judged or what a good answer is, and does not ask to read anything. It is a fact about the harness
 * (a restricted shell), the same for every case, and results are to be read as "Codex told its shell limits".
 */
export const codexShellNote = () => [
  "Tool environment: the shell in this session is restricted. Each tool call is one line of at most 4 commands joined by ; or &&.",
  "Supported commands: cat <path>; head -n <N> <path>; sed -n '<A>,<B>p' <path>; nl -ba <path>; ls with only the flags l, a, 1, A (a path, or none to list the working directory);",
  "rg --files <directory> (file names only); git status --short; git diff -- <path>.",
  "Every path must stay within this session's filesystem read permissions.",
  "Not supported: commands on separate lines, any other command or flag, pipes, redirects, command substitution, variable or glob expansion. Nothing can be written.",
].join(" ");
export const codexCommand = ({ model, prompt, work, roots, guard, isolationKeys, off, catalog }) => ({ command: "codex", args: [
  "exec", "--ignore-user-config", "--ephemeral", "--json", "--skip-git-repo-check", "-m", model, "-C", work,
  "-c", 'default_permissions="lab"', "-c", `permissions.lab.filesystem=${codexProfile({ roots })}`,
  "-c", `developer_instructions=${JSON.stringify(codexShellNote())}`,
  ...off.flatMap((setting) => ["-c", setting]), "-c", "features.hooks=false", ...(catalog ? ["-c", `model_catalog_json=${JSON.stringify(catalog)}`] : []),
  "-c", "mcp_servers.paraself.enabled=true", "-c", `mcp_servers.paraself.command=${JSON.stringify(guard.command)}`,
  "-c", `mcp_servers.paraself.args=${JSON.stringify(guard.args)}`, "-c", `mcp_servers.paraself.env_vars=${JSON.stringify(isolationKeys)}`, "-"], stdin: prompt });
/** Claude: project and local settings only, three own tools (Skill, Read limited to the same two directories, ToolSearch), dontAsk. */
export const claudeCommand = ({ model, prompt, roots, mcpConfig }) => ({ command: "claude", args: [
  "-p", "--model", model, "--setting-sources", "project,local", "--tools", "Skill,Read,ToolSearch", "--permission-mode", "dontAsk",
  "--allowedTools", "Skill", "ToolSearch", ...roots.map((root) => `Read(/${root}/**)`), ...TOOLS.map((tool) => `mcp__paraself__${tool}`),
  "--strict-mcp-config", "--mcp-config", mcpConfig, "--output-format", "stream-json", "--verbose"], stdin: prompt });

// ---------------------------------------------------------------- what an event stream proves
const jsonLines = (stdout) => stdout.split("\n").flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });
const CAT = /^(?:cat|head|sed|nl|ls)$/u;
const NUMBER = /^\d+$/u;
const SED_PRINT = /^\d+(?:,(?:\d+|\$))?p$/u;
/** One command's words, quotes taken off: single quotes literal, double quotes literal too unless they hold an expansion. Null = not plain words. */
const wordsOf = (text) => {
  const words = [];
  let word = null, i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === " " || c === "\t") { if (word !== null) words.push(word); word = null; i += 1; continue; }
    if (c === "'" || c === '"') {
      const end = text.indexOf(c, i + 1);
      if (end < 0) return null;
      const inside = text.slice(i + 1, end);
      if (/[\n\0]/u.test(inside) || (c === '"' && /[$`\\!]/u.test(inside))) return null;
      word = (word ?? "") + inside; i = end + 1; continue;
    }
    if (/[;&|<>()$`\\*?{}~!#\n\0]/u.test(c)) return null;
    word = (word ?? "") + c; i += 1;
  }
  if (word !== null) words.push(word);
  return words;
};
/** Splits at `;` and `&&` outside quotes, and nowhere else (any other operator stays in its piece, where wordsOf refuses it). Null = unterminated quote. */
const splitCommands = (text) => {
  const parts = [];
  let current = "", quote = null;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quote !== null) { current += c; if (c === quote) quote = null; continue; }
    if (c === "'" || c === '"') { quote = c; current += c; continue; }
    if (c === ";") { parts.push(current); current = ""; continue; }
    if (c === "&" && text[i + 1] === "&") { parts.push(current); current = ""; i += 1; continue; }
    current += c;
  }
  if (quote !== null) return null;
  parts.push(current);
  return parts.map((part) => part.trim());
};
const MAX_SEGMENTS = 4;
/** A path as the command named it, resolved against cwd, if it is plain and under the roots; else null. */
const resolveUnder = (arg, roots, cwd) => {
  const absolute = arg.startsWith("/") ? arg : cwd === undefined ? null : `${cwd}/${arg}`;
  // "=" opens a zsh EQUALS expansion (=ls is /bin/ls), whatever it follows: never a plain path.
  if (absolute === null || arg.startsWith("-") || arg.startsWith("=") || arg.split("/").includes("..") || (arg.split("/").includes(".") && arg !== ".")) return null;
  const clean = absolute.replace(/\/+/gu, "/");
  return roots.some((root) => clean === root || clean.startsWith(`${root}/`)) ? clean : null;
};
/** One plain read command (cat, head, sed -n with a print script, nl, ls) already split into words. */
const classifyReadWords = (words, roots, cwd) => {
  const [program, ...args] = words;
  if (!CAT.test(program ?? "")) return { why: "command" };
  const paths = [];
  for (const [index, arg] of args.entries()) {
    const previous = args[index - 1];
    if (arg.startsWith("-")) {
      // sed only prints (-n); head takes a count; no in-place, script-file or expression flags anywhere.
      if (!(arg === "-n" || (program === "head" && /^-\d+$/u.test(arg)) || (program === "ls" && /^-[la1A]+$/u.test(arg)) || (program === "nl" && arg === "-ba"))) return { why: "flag" };
      continue;
    }
    if (program === "sed" && SED_PRINT.test(arg) && !paths.length && args.includes("-n")) continue;
    if (NUMBER.test(arg) && previous === "-n" && program !== "sed") continue;
    if (program === "sed" && !paths.length && index === (args.indexOf("-n") + 1) && !SED_PRINT.test(arg)) return { why: "sed script is not a print" };
    const resolved = resolveUnder(arg, roots, cwd);
    if (resolved === null) return { why: "relative path without a working directory, with .., or outside the allowed roots" };
    paths.push(resolved);
  }
  // `ls` with no path lists the working directory (the synthetic repository): names only, so nothing is added to what was read.
  if (paths.length === 0 && program === "ls") return cwd === undefined ? { why: "ls without a working directory" } : { paths: [] };
  if (paths.length === 0 || (program === "sed" && !args.includes("-n"))) return { why: "no path or sed without -n" };
  return { paths };
};
/**
 * The two git commands a review begins with, in the synthetic repository (cwd) and nothing else: `git status --short`, and
 * `git diff -- <paths>` with every path under the roots. No other subcommand, no flag but --short and the `--` itself, no path that
 * starts with "-" (so no --no-index, --output, --ext-diff). They add no paths to what was read: git's own metadata is not an
 * allowed root, so in the sandbox they may fail, and a success of theirs is never counted as reading a file.
 */
const classifyGitWords = (words, roots, cwd) => {
  if (cwd === undefined) return { why: "git without a working directory" };
  const [, subcommand, ...args] = words;
  if (subcommand === "status" && args.length === 1 && args[0] === "--short") return { paths: [] };
  // A pathspec starting with ":" is git magic (":/" is the repository top, ":(top)" too), not the path it looks like.
  if (subcommand === "diff" && args[0] === "--" && args.length >= 2 && args.slice(1).every((arg) => !arg.startsWith(":") && resolveUnder(arg, roots, cwd) !== null)) return { paths: [] };
  return { why: "git other than status --short or diff -- <allowed paths>" };
};
/** `rg --files <paths>` and nothing else of rg: it only lists file names under paths that are under the roots (no pattern, no other flag). */
const classifyRgWords = (words, roots, cwd) => {
  const [, flag, ...paths] = words;
  if (flag !== "--files" || paths.length === 0 || !paths.every((arg) => resolveUnder(arg, roots, cwd) !== null)) return { why: "rg other than --files <allowed paths>" };
  return { paths: [] }; // names only: not a read of any file's content
};
/**
 * A shell command Codex ran, classified. Read = up to four commands joined by `;` or `&&`, each one a plain read (cat, head, sed -n
 * with a print script, nl, ls) whose paths, absolute or relative to `cwd`, resolve under `roots`, `rg --files <such paths>`, or one of the two git commands above;
 * quotes are taken off, nothing else is: no pipe, redirect, expansion, substitution, other program, write-capable sed script or ".."
 * anywhere. Every segment is judged on its own; one outside makes the whole command a violation.
 */
export const classifyCommand = (command, roots, cwd) => {
  const single = command.match(/^\/bin\/zsh -lc '(.*)'$/su)?.[1];
  const double = single === undefined ? command.match(/^\/bin\/zsh -lc "(.*)"$/su)?.[1] : undefined;
  const inner = single ?? double ?? command;
  // A command shown in double quotes may have been parsed by a shell as such: no expansion character survives anywhere in it.
  if (double !== undefined && /[$`\\]/u.test(double)) return { kind: "violation", why: "expansion character in a double-quoted command", inner };
  const segments = splitCommands(inner);
  if (segments === null || segments.length === 0 || segments.length > MAX_SEGMENTS || segments.some((segment) => segment === "")) return { kind: "violation", why: "empty segment, too many commands or an open quote", inner };
  const paths = [];
  for (const segment of segments) {
    const words = wordsOf(segment);
    if (words === null || words.length < 1) return { kind: "violation", why: "shell operators or not plain words", inner };
    const judged = words[0] === "git" ? classifyGitWords(words, roots, cwd) : words[0] === "rg" ? classifyRgWords(words, roots, cwd) : classifyReadWords(words, roots, cwd);
    if (judged.why !== undefined) return { kind: "violation", why: judged.why, inner };
    paths.push(...judged.paths);
  }
  return { kind: "read", paths, inner };
};

/**
 * Calls, reads and final text of a claude stream-json or codex --json run. `visible` is the JSON-RPC-shaped result the
 * client was shown, for the guard's second look. Unknown item types count as violations: nothing else is left to a client.
 */
export const parseRun = (client, stdout, { roots, cwd, allowedSkills = ["paraself-review", "paraself-memory"] }) => {
  const events = jsonLines(stdout);
  const calls = [], reads = [], outputs = [], violations = [];
  // The text a Skill load brought: the Skill call's own tool_result (matched by its tool_use_id, whatever the order of results) and the
  // text parts of user/meta messages that follow it, until the model's next tool_use of anything but that Skill. No other tool_result is
  // ever added, even in the same event; nothing later (a Read of the copy, the model's own words) can stand in for the load.
  let capture = null;
  let text = "", skills;
  if (client === "claude") {
    const pending = new Map();
    for (const event of events) {
      if (event.type === "system" && event.subtype === "init") skills = event.skills;
      // A user message whose content is a plain string is a text part.
      const parts = typeof event.message?.content === "string" ? [{ type: "text", text: event.message.content }] : event.message?.content ?? [];
      for (const part of parts) {
        if (capture !== null && event.type === "user" && part.type === "text" && typeof part.text === "string") capture.loadedText += `\n${part.text}`;
        if (event.type === "assistant" && part.type === "tool_use") {
          const name = part.name;
          if (name !== "Skill") capture = null; // per tool_use, in order: a Skill then a Read in one message ends the capture at the Read
          if (name === "Skill") {
            // Only the task copies' skills may be loaded; the result is paired below, since a call that failed loaded nothing.
            const call = { name: "Skill", skill: part.input?.skill, error: undefined };
            if (!allowedSkills.includes(call.skill)) violations.push(`Skill ${String(call.skill).slice(0, 80)} is not one of the task's`);
            call.loadedText = ""; calls.push(call); pending.set(part.id, call); capture = call;
          }
          else if (name === "Read") { const path = String(part.input?.file_path ?? ""); reads.push(path); if (!roots.some((root) => path.startsWith(`${root}/`))) violations.push(`Read ${path}`); }
          else if (name === "ToolSearch") calls.push({ name });
          else if (name.startsWith("mcp__paraself__")) { const call = { name: name.slice(15), args: part.input ?? {}, result: undefined }; calls.push(call); pending.set(part.id, call); }
          else violations.push(`tool ${name}`);
        }
        if (event.type === "user" && part.type === "tool_result" && pending.has(part.tool_use_id) && pending.get(part.tool_use_id).name === "Skill") {
          const skillCall = pending.get(part.tool_use_id);
          skillCall.error = part.is_error === true;
          skillCall.shown = typeof part.content === "string" ? part.content : (part.content ?? []).map((item) => item.text ?? "").join("\n");
          skillCall.loadedText += `\n${skillCall.shown}`; // its own result, by id: not subject to what the model called meanwhile
        } else if (event.type === "user" && part.type === "tool_result" && pending.has(part.tool_use_id)) {
          const call = pending.get(part.tool_use_id);
          const shown = typeof part.content === "string" ? part.content : (part.content ?? []).map((item) => item.text ?? "").join("\n");
          let structured; try { structured = JSON.parse(shown); } catch { structured = undefined; }
          call.error = part.is_error === true; call.result = structured; call.shown = shown;
          // Claude Code shows structuredContent as JSON, or plain text: no prose beside it to hold to the fields.
          call.message = { result: { isError: call.error, ...(structured && typeof structured === "object" ? { structuredContent: structured, content: [] } : { content: [{ type: "text", text: shown }] }) } };
          call.textShown = false;
        }
      }
      if (event.type === "result") text = event.result ?? "";
    }
  } else {
    for (const event of events) {
      const item = event.item;
      if (!item || !["item.started", "item.completed"].includes(event.type)) continue;
      if (["agent_message", "reasoning"].includes(item.type)) { if (item.type === "agent_message" && event.type === "item.completed") text = item.text ?? ""; continue; }
      if (item.type === "error") continue; // a client notice, never a tool
      if (item.type === "command_execution") {
        const c = classifyCommand(item.command ?? "", roots, cwd);
        if (c.kind === "violation") violations.push(`command ${c.why}: ${String(item.command).slice(0, 120)}`);
        else if (event.type === "item.completed") { reads.push(...c.paths); outputs.push({ paths: c.paths, exit: item.exit_code, output: String(item.aggregated_output ?? item.output ?? "") }); }
        continue;
      }
      if (item.type === "mcp_tool_call" && event.type === "item.completed") {
        // A failed call is logged with structured_content: null where it had none (R18): read as none.
        const structured = item.result?.structured_content ?? undefined;
        if (item.server !== "paraself") violations.push(`mcp server ${item.server}`);
        else {
          const error = item.status !== "completed" || !!item.error || item.result?.is_error === true;
          calls.push({ name: item.tool, args: item.arguments ?? {}, result: structured, error, textShown: true,
            message: item.result ? { result: { isError: error, ...(structured === undefined ? {} : { structuredContent: structured }), content: item.result.content ?? [] } } : { error: item.error ?? { message: "no result" } } });
        }
        continue;
      }
      if (item.type === "mcp_tool_call") continue;
      violations.push(`item ${item.type}`);
    }
  }
  return { calls, reads, outputs, violations, text, skills };
};

/** Hard conditions from the events alone; `skillPath` is the installed SKILL.md (Codex) and `skillName` the Claude Skill name. */
export const evidence = (client, run, { skillName, skillPath, skillDir, skillMarkers = [], notePath, seed, allow = [] }) => {
  const tools = run.calls.filter((call) => TOOLS.includes(call.name));
  const problems = [...run.violations];
  // Skills the client lists on its own (user-level ones among them) are metadata it always shows: recorded, not judged. What is judged is
  // what was loaded: parseRun refuses any Skill other than the task's, and Codex may read nothing outside the two copies.
  const ambientSkills = (run.skills ?? []).filter((name) => !["paraself-review", "paraself-memory"].includes(name));
  for (const call of tools) {
    const argCheck = checkArgs(call.name, call.args, seed);
    if (!argCheck.ok) problems.push(`${call.name}: ${argCheck.reason}`);
    if (call.message !== undefined && call.error === false) {
      const why = checkToolMessage(call.name, call.args, call.message, { seed, allow, text: call.textShown !== false });
      if (why) problems.push(`${call.name}: ${why}`);
    } else if (call.error !== true) problems.push(`${call.name}: no result to verify`);
  }
  const hard = {
    // Loaded = the call succeeded and the task copy's own text (its opening and closing lines) arrived after it; a bare call, a failed one
    // or another skill of the same name proves nothing. Codex: the read of the copy exited 0 and printed those lines.
    skillLoaded: skillMarkers.length > 0 && (client === "claude"
      ? typeof skillDir === "string" && run.calls.some((call) => call.name === "Skill" && call.skill === skillName && call.error === false
        && (call.loadedText ?? "").includes(skillDir) && skillMarkers.every((marker) => (call.loadedText ?? "").includes(marker)))
      : (run.outputs ?? []).some((read) => read.paths.includes(skillPath) && read.exit === 0 && skillMarkers.every((marker) => read.output.includes(marker)))),
    decisionSearch: tools.some((call) => ["search_decision_context", "consult_decision_principles"].includes(call.name) && call.error === false),
    obsidianSearch: tools.some((call) => call.name === "search_obsidian_notes" && call.error === false),
    obsidianRead: tools.some((call) => call.name === "get_obsidian_note" && call.args?.path === notePath && call.result?.read?.status === "ok") };
  // ok is all four hard conditions and no problem at all: a run that checked clean but never used the skill or a tool is not a pass.
  return { ...hard, ambientSkills, problems, ok: problems.length === 0 && Object.values(hard).every(Boolean) };
};

/** Every planned (client, case) has a row, and every row is ok: a missing row is a failure, not a smaller run. */
export const coverage = (planned, rows) => {
  const missing = planned.filter(({ client, model, caseId }) => !rows.some((row) => row.client === client && row.model === model && row.case === caseId));
  return { missing, ok: missing.length === 0 && rows.length === planned.length && rows.every((row) => row.evidence?.ok === true && (row.flagged ?? []).length === 0) };
};

/** The task copy's own text, as the lines a load must bring: the first and last 200 characters of its body (after the front matter). */
export const skillMarkers = (skillFile) => {
  const body = readFileSync(skillFile, "utf8").replace(/^---\n[\s\S]*?\n---\n/u, "").trim();
  if (body.length < 400) throw new Error("A skill body too short to hold two distinct markers");
  return [body.slice(0, 200), body.slice(-200)];
};
/** The copy made for the run equals the seed it came from, file for file (the App writes into the copy as it runs, the seed does not move). */
export const verifyVaultCopy = (copyDir, frozenVault) => {
  const mine = walk(copyDir), theirs = walk(frozenVault);
  const problems = [...theirs.filter((path) => !mine.includes(path)).map((p) => `missing ${p}`), ...mine.filter((path) => !theirs.includes(path)).map((p) => `extra ${p}`),
    ...mine.filter((path) => theirs.includes(path) && sha256(readFileSync(join(copyDir, path))) !== sha256(readFileSync(join(frozenVault, path)))).map((p) => `differs ${p}`)];
  if (problems.length > 0) throw new Error(`The vault copy is not the frozen seed: ${problems.join("; ")}`);
};

// ---------------------------------------------------------------- metadata snapshot (no contents read)
/** Paths, types, sizes and mtimes under each dir, hashed: proves a tree was not touched without reading a byte of it. */
export const metadataSnapshot = (dirs) => {
  const rows = [];
  const visit = (path) => {
    let stat; try { stat = lstatSync(path); } catch { rows.push(`${path}\0absent`); return; }
    rows.push(`${path}\0${stat.isDirectory() ? "d" : stat.isSymbolicLink() ? "l" : "f"}\0${stat.size}\0${Math.trunc(stat.mtimeMs)}`);
    if (stat.isDirectory()) for (const entry of readdirSync(path).sort()) visit(join(path, entry));
  };
  dirs.forEach(visit);
  return { entries: rows.length, digest: sha256(rows.join("\n")) };
};

/** Installed skill copies (made by the product's own helper into a temp home) against their packaged sources. */
export const verifyInstalled = (home, targets) => targets.map(({ rel, sourceDir }) => {
  const dir = join(home, rel);
  const real = realpathSync(dir);
  if (!real.startsWith(`${realpathSync(home)}/`)) throw new Error(`${rel} resolves outside the temp home`);
  const mine = walk(real), theirs = walk(sourceDir);
  const problems = [...theirs.filter((path) => !mine.includes(path)).map((p) => `missing ${p}`), ...mine.filter((path) => !theirs.includes(path)).map((p) => `extra ${p}`),
    ...mine.filter((path) => theirs.includes(path) && sha256(readFileSync(join(real, path))) !== sha256(readFileSync(join(sourceDir, path)))).map((p) => `differs ${p}`)];
  return { rel, files: mine.length, problems };
});
