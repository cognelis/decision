import { Document, Scalar, visit, type ToStringOptions } from "yaml";

const MARKER_PREFIX = "<!-- decision:";
const ESCAPED_MARKER_PREFIX = "<!\\-- decision:";
const ZERO_WIDTH_SPACE = String.fromCharCode(0x200b);

/**
 * Text written into a note, from an agent or a person, so that none of it reads as the note's own structure
 * or as live content. Read back, an app marker, a `##` heading or a code fence in it was taken for the note's
 * own sections: an agent's question stood as the user's rationale. Opened in Obsidian, a fence (Dataview's
 * dataviewjs) or Dataview's inline `$=` ran code. Each is given backslashes, which Markdown shows as the
 * characters themselves and which take the searched-for text apart; reading takes them off again.
 */
export const escapeNoteText = (value: string): string =>
  value
    .replaceAll(MARKER_PREFIX, ESCAPED_MARKER_PREFIX)
    // Dataview runs any code whose text starts with `$=`, however it got there: after a tab or a no-break
    // space, in an HTML <code>, in an indented block. One backslash more between `$` and `=`, however many the
    // text had, is never that prefix, and reading takes exactly that one off again: `$\=` itself survives.
    .replace(/\$(\\*)=/gu, (_match, slashes: string) => `$${slashes}\\=`)
    .replace(/#{2,}|`{3,}|~{3,}/gu, (run) => [...run].map((character) => `\\${character}`).join(""))
    // Templater, set to run on new files, runs the JavaScript between `<%` and `%>` wherever a file holds it.
    .replaceAll("<%", "<\\%")
    // What Obsidian fetches as it shows a note (an image, an iframe, any HTML tag) could carry what an agent read
    // out to a server, from outside the agent's sandbox: taken apart, it is shown as the text it is. After an odd
    // run of the text's own backslashes, one more made the run even, and Markdown read `\\<img` as a backslash and a
    // live tag: a zero-width space then stands between them, which no backslash escapes, and which reading takes
    // out again. Notes written before read back as they did: the rule for every other run is unchanged.
    .replace(/(\\*)<(?=[A-Za-z!/])/gu, (_match, slashes: string) => `${slashes}${slashes.length % 2 === 1 ? ZERO_WIDTH_SPACE : ""}\\<`)
    .replaceAll("![", "!\\[");

// ponytail: text that already held such a run escaped (`\#\#`, \`\`\`, `\~\~\~`), or `<\%` or `!\[`, reads back
// without that backslash, as Markdown shows it anyway; escape the backslash too if text like that ever has to survive.
const HEADING = /^#[ \t]+(.+)$/gmu;

/**
 * The note's title line: the `# ` heading nearest above the app's first marked section (`starts`, as the parsers
 * look for them), or the first in the note when none stands above one. Taken as the first in the note, a heading
 * the reader put above the app's part (a title of their own for the page) was read as the title, and the next save
 * wrote the app's title over it, the app's own then standing twice. Given the line `wanted`, a heading above the
 * section that already reads as it is the title wherever it stands: with a heading of the reader's between the
 * app's title and its first section, the nearest was theirs, and a save that changed no title wrote the app's over
 * it. Which heading is the app's cannot be told from the body alone once the title does change.
 */
export const titleHeading = (body: string, starts: readonly string[], wanted?: string): { index: number; line: string; text: string } | null => {
  const { headings, above } = headingsAbove(body, starts);
  const match = (wanted === undefined ? undefined : above.find((heading) => unescapeNoteText(heading[0]) === unescapeNoteText(wanted)))
    ?? above.at(-1) ?? headings[0];
  return match === undefined ? null : { index: match.index, line: match[0], text: match[1]! };
};

const headingsAbove = (body: string, starts: readonly string[]) => {
  const first = starts.map((start) => body.indexOf(start)).filter((at) => at >= 0).reduce((at, other) => Math.min(at, other), body.length);
  const headings = [...body.matchAll(HEADING)];
  return { headings, above: headings.filter((heading) => heading.index < first) };
};

/**
 * The title line the note's own `title` property names: the heading above the app's part that reads as it,
 * wherever it stands among headings of the reader's; null without the property (a note written before the app kept
 * it) or when no heading reads as it (renamed in Obsidian: the visible heading is the title, by titleHeading's rule).
 */
export const namedTitleHeading = (body: string, starts: readonly string[], property: unknown): { index: number; line: string; text: string } | null => {
  if (typeof property !== "string" || property.trim().length === 0) return null;
  // Kept as the heading shows it, escaped (no `$=` or `<%` for Dataview or Templater in the note's properties either).
  const named = unescapeNoteText(property).trim();
  // Named by one line only: the reader's copy of the title at the top of the page read as the app's (the first one),
  // and a retitle wrote over theirs, leaving the app's old title standing. Named by more, it is told as before.
  const matches = headingsAbove(body, starts).above.filter((heading) => unescapeNoteText(heading[1]!).trim() === named);
  const match = matches.length === 1 ? matches[0] : undefined;
  return match === undefined ? null : { index: match.index, line: match[0], text: match[1]! };
};

/** The note's title line: the one its `title` property names, else the heading by titleHeading's rule. */
export const ownTitleHeading = (body: string, starts: readonly string[], property: unknown): { index: number; line: string; text: string } | null =>
  namedTitleHeading(body, starts, property) ?? titleHeading(body, starts);

/** Refused rather than guessed: which of two headings above the app's part is its title cannot be told from the body. */
export const titleAmbiguous = (text: string): string =>
  `这篇笔记的标题和 App 的第一个分节之间有一行一级标题「${text}」，App 分不清哪一行才是标题，这次没有写入；请在 Obsidian 里把它改成二级标题，或移到标题上方。`;

export const unescapeNoteText = (value: string): string =>
  value
    .replaceAll("!\\[", "![")
    // Its own backslash taken off, and the zero-width space an odd run of the text's backslashes was given.
    .replace(new RegExp(`(\\\\*)${ZERO_WIDTH_SPACE}?\\\\<(?=[A-Za-z!/])`, "gu"), (_match, slashes: string) => `${slashes}<`)
    .replaceAll("<\\%", "<%")
    .replace(/(?:\\#){2,}|(?:\\`){3,}|(?:\\~){3,}/gu, (run) => run.replaceAll("\\", ""))
    // As inline code was escaped before: its backtick, not its `$=`. Only such text still has a bare `$=` here.
    .replace(/\\`(?= *\$=)/gu, "`")
    .replace(/\$\\(\\*)=/gu, (_match, slashes: string) => `$${slashes}=`)
    .replaceAll(ESCAPED_MARKER_PREFIX, MARKER_PREFIX)
    // As markers were escaped before.
    .replaceAll(`\\${MARKER_PREFIX}`, MARKER_PREFIX);

/**
 * A note's properties as YAML with no Templater command tag in the file: a value holding `<%` is written
 * double-quoted, its `%` as `\x25`, which every YAML reader (Obsidian's properties among them) reads back as `<%`.
 * Written as it was, Templater, set to run on new files, ran the JavaScript an agent's text put in a property.
 */
export const templaterSafeYaml = (document: Document, options: ToStringOptions = {}): string => {
  visit(document, {
    Scalar: (_key, node) => {
      if (typeof node.value === "string" && node.value.includes("<%")) node.type = Scalar.QUOTE_DOUBLE;
    },
  });
  return document.toString(options).replaceAll("<%", "<\\x25");
};

/** As yaml's stringify, by way of templaterSafeYaml. */
export const notePropertiesYaml = (value: unknown, options: ToStringOptions = {}): string =>
  templaterSafeYaml(new Document(value), options);
