import { randomUUID } from "node:crypto";
import { mkdir, open, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { parse as parseYaml } from "yaml";

import { inFormOf, normalizedNote, noteText, withProperties } from "./markdown.js";
import { namedTitleHeading, titleAmbiguous, titleHeading, unescapeNoteText } from "./markdown-markers.js";
import { renameReplacing } from "./replace-file.js";

/** The note as it is on disk (refused with a byte that is not UTF-8, see noteText), or null when there is none yet. */
export const existingNote = (path: string): Promise<string | null> =>
  noteText(path).catch((error: NodeJS.ErrnoException) => (error.code === "ENOENT" ? null : Promise.reject(error)));

const CHANGED_MEANWHILE = "这篇笔记刚在 Obsidian 里被改过，这次没有写入；请重新打开它再试。";
// Nothing read, yet a file is there: one the app could not read as a note (found by neither id nor fingerprint),
// not one just saved in Obsidian, and not one to write over.
const IN_THE_WAY = "这个位置已有一篇 App 读不出的笔记，这次没有写入；请在 Obsidian 里处理它后再试。";

/**
 * Writes the note over the one read (`raw` as existingNote gave it, null for none yet), refusing when the file no
 * longer reads so: saved in Obsidian between the app's read and its write, a line the reader had just added was
 * written over without a word. Checked before the temporary file is written and again before the rename, as the
 * decision repository checks (markdown.ts #checkVersion). The temporary file is synced before it takes the note's
 * place, so a crash between the two leaves the note as it was, not empty.
 */
export const replaceNote = async (path: string, raw: string | null, content: string, renameFile: typeof rename = rename): Promise<void> => {
  const unchanged = async (): Promise<void> => {
    if ((await existingNote(path)) !== raw) throw new Error(raw === null ? IN_THE_WAY : CHANGED_MEANWHILE);
  };
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await unchanged();
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(content, "utf8");
      // A volume that cannot sync (some network mounts) still saves, as it did; a disk that fails to does not have
      // the temporary file, perhaps never written through, put in the note's place.
      await handle.sync().catch((error: NodeJS.ErrnoException) => {
        if (!["EINVAL", "ENOTSUP", "ENOSYS"].includes(error.code ?? "")) throw error;
      });
    } finally {
      await handle.close();
    }
    await unchanged();
    await renameReplacing(temporary, path, { renameFile, beforeRetry: unchanged });
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
};

/** What a record says, compared in any key order: read back, a note lists its fields in its own. */
export const canonical = (value: unknown): string => JSON.stringify(value, (_key, item: unknown) =>
  item !== null && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([left], [right]) => (left < right ? -1 : 1)))
    : item);

interface NoteRewrite {
  /** The properties the app writes, each a key or a path to one: set from the fresh note, or taken out when it has none. */
  ownKeys: ReadonlyArray<string | readonly string[]>;
  /** The marker pairs around the sections the app writes. */
  markers: ReadonlyArray<readonly [string, string]>;
  /** How the note is read: the one written must read as the fresh note does. */
  parse(note: string): unknown;
}

const parts = (note: string): { properties: string; body: string } => {
  const boundary = note.startsWith("---\n") ? note.indexOf("\n---\n", 4) : -1;
  if (boundary < 0) throw new Error("Note has no frontmatter");
  return { properties: note.slice(4, boundary), body: note.slice(boundary + 5) };
};

/** From a start marker to the end of its end marker, found as the parsers find them. */
const marked = (body: string, [start, end]: readonly [string, string]): [number, number] | null => {
  const from = body.indexOf(start);
  const to = from < 0 ? -1 : body.indexOf(end, from + start.length);
  return to < 0 ? null : [from, to + end.length];
};

const UNSAFE_TO_WRITE = "这篇笔记在 Obsidian 里的改动让 App 无法安全写入，请在 Obsidian 里修改它。";

/**
 * The fresh note written into the one that is there: the app's own properties, title and marked sections are
 * replaced, and what the reader added in Obsidian (tags, aliases, a link, a section of their own) is kept, in
 * the line endings and BOM it had. Written out whole, one click on 采纳 took all of that with it. A note the
 * app cannot read as one of its own is refused as one it cannot write safely is: written fresh, a relation the
 * reader had edited past reading (and had written their own analysis in) was replaced whole by the next 核对.
 */
export const rewrittenNote = (raw: string | null, fresh: string, rewrite: NoteRewrite): string => {
  if (raw === null) return fresh;
  try {
    rewrite.parse(raw);
  } catch (error) {
    throw new Error(UNSAFE_TO_WRITE, { cause: error });
  }
  const existing = parts(normalizedNote(raw));
  const written = parts(fresh);
  let properties = existing.properties;
  const freshProperties = parseYaml(written.properties) as Record<string, unknown>;
  for (const key of rewrite.ownKeys) {
    const path = typeof key === "string" ? [key] : key;
    const value = path.reduce<unknown>(
      (node, step) => (node !== null && typeof node === "object" ? (node as Record<string, unknown>)[step] : undefined),
      freshProperties,
    );
    properties = withProperties(properties, { [path.at(-1)!]: value }, path.slice(0, -1));
  }
  let body = existing.body;
  const starts = rewrite.markers.map(([start]) => start);
  const title = titleHeading(written.body, starts);
  let titleWritten = false;
  for (const markers of rewrite.markers) {
    const target = marked(body, markers);
    const source = marked(written.body, markers);
    // One missing from either reads back as another note, and is refused below.
    if (source === null || target === null) continue;
    if (title !== null && title.index >= source[0] && title.index < source[1]) titleWritten = true;
    const section = written.body.slice(source[0], source[1]);
    // Read back as the same text, a section keeps its bytes: written again escaped, the reader's own formatting in
    // it (a highlight, a heading, an embed) turned into literal text on a save that changed nothing in it. Text
    // that changed is written escaped, as every text the app writes is.
    if (unescapeNoteText(body.slice(target[0], target[1])) === unescapeNoteText(section)) continue;
    body = `${body.slice(0, target[0])}${section}${body.slice(target[1])}`;
  }
  // Written already by a marked section (a relation note's), it is not put again over the note's title line (the
  // one read as the title, below a heading of the reader's own above the app's part); nor over one that reads as
  // the same title. Standing as the same title further up, with a heading of the reader's nearer the app's part,
  // which one is the app's cannot be told: refused, rather than the reader's written over.
  // Named by the note's own `title` property, the line is known, wherever headings of the reader's stand: no guess.
  const named = namedTitleHeading(body, starts, (parseYaml(existing.properties) as Record<string, unknown> | null)?.title);
  const heading = named ?? titleHeading(body, starts, title?.line);
  const nearest = titleHeading(body, starts);
  if (named === null && title !== null && heading !== null && nearest !== null && !titleWritten && nearest.index !== heading.index) {
    throw new Error(titleAmbiguous(nearest.text));
  }
  if (title !== null && heading !== null && !titleWritten && unescapeNoteText(heading.line) !== unescapeNoteText(title.line)) {
    body = `${body.slice(0, heading.index)}${title.line}${body.slice(heading.index + heading.line.length)}`;
  }
  const markdown = `---\n${properties}\n---\n${body}`;
  if (canonical(rewrite.parse(markdown)) !== canonical(rewrite.parse(fresh))) {
    throw new Error(UNSAFE_TO_WRITE);
  }
  return inFormOf(raw, markdown);
};
