import { Fragment, type ReactNode } from "react";

/**
 * A deliberately small Markdown subset for model answers.
 *
 * Two constraints shape it. The renderer has no `dangerouslySetInnerHTML`
 * anywhere and the app ships two runtime dependencies, so this returns React
 * elements rather than HTML and pulls in no parser. And the input is model
 * output — untrusted text — so nothing here can produce a navigable URL or an
 * attribute an answer could steer: citation buttons only use supplied indexes;
 * links render as their label, and every
 * value reaches the DOM as a text child.
 *
 * Tables are in because the PR overview asks for one; their cells are inline text
 * like any paragraph.
 *
 * Unsupported on purpose: images, footnotes, nested lists, inline HTML.
 * Anything unrecognised survives as the literal text the model wrote, which is
 * what the old plain-text rendering did for everything.
 */

// Emphasis as CommonMark reads it: `*` hugs its text (so `*.md 和 *.ts` stays two globs), and `_` never opens or closes
// inside a word (so `batch_id` and `created_at` stay identifiers).
const INLINE =
  /(\*\*[^*]+\*\*|`[^`]+`|\*(?!\s)[^*\n]+(?<!\s)\*|(?<![\p{L}\p{N}_])_[^_\n]+_(?![\p{L}\p{N}_])|\[[^\]]+\]\([^)\s]+\)|\\\[\d+\]|\[\d+\])/u;

const LINK = /^\[([^\]]+)\]\([^)\s]+\)$/u;

type CitationLinks = { indexes: readonly number[]; onSelect(index: number): void };

const inline = (text: string, keyPrefix: string, citations?: CitationLinks): ReactNode[] =>
  text
    .split(INLINE)
    .filter((part) => part.length > 0)
    .map((part, index) => {
      const key = `${keyPrefix}:${index}`;
      if (part.startsWith("**") && part.endsWith("**")) {
        return <strong key={key}>{inline(part.slice(2, -2), key, citations)}</strong>;
      }
      if (part.startsWith("`") && part.endsWith("`")) {
        return <code key={key}>{part.slice(1, -1)}</code>;
      }
      if (
        (part.startsWith("*") && part.endsWith("*")) ||
        (part.startsWith("_") && part.endsWith("_"))
      ) {
        return <em key={key}>{inline(part.slice(1, -1), key, citations)}</em>;
      }
      // Keep a link's label, drop its target: an answer must not hand the user
      // a link whose destination the model chose.
      const link = LINK.exec(part);
      if (link !== null) return <Fragment key={key}>{link[1]}</Fragment>;
      const marker = /^\[(\d+)\]$/u.exec(part);
      const citationIndex = marker === null ? -1 : Number(marker[1]);
      if (citations?.indexes.includes(citationIndex)) {
        return <button key={key} type="button" className="assistant-inline-citation" aria-label={`查看引用 ${citationIndex}`} onClick={() => citations.onSelect(citationIndex)}>{part}</button>;
      }
      if (/^\\\[\d+\]$/u.test(part)) return <Fragment key={key}>{part.slice(1)}</Fragment>;
      return <Fragment key={key}>{part}</Fragment>;
    });

const LIST_ITEM = /^\s*[-*+]\s+(.*)$/u;
const ORDERED_ITEM = /^\s*(\d+)[.)]\s+(.*)$/u;
const HEADING = /^(#{1,6})\s+(.*)$/u;
const QUOTE = /^>\s?(.*)$/u;
export const FENCE = /^```\s*\S*\s*$/u;
const RULE = /^\s*([-*_])(?:\s*\1){2,}\s*$/u;
const DELIMITER_ROW = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/u;

/** A row's cells between unescaped pipes; `\|` stays a literal pipe. */
const cells = (line: string): string[] =>
  line.trim().replace(/^\|/u, "").replace(/(?<!\\)\|$/u, "")
    .split(/(?<!\\)\|/u).map((cell) => cell.trim().replaceAll("\\|", "|"));

/** GFM: a row with pipes right above a delimiter row of as many cells. */
const tableAt = (lines: readonly string[], index: number): boolean => {
  const header = lines[index];
  const delimiter = lines[index + 1];
  return header !== undefined && delimiter !== undefined && header.includes("|") && delimiter.includes("|") &&
    DELIMITER_ROW.test(delimiter) && cells(header).length === cells(delimiter).length;
};

const startsBlock = (line: string): boolean =>
  line.trim().length === 0 ||
  FENCE.test(line) ||
  HEADING.test(line) ||
  QUOTE.test(line) ||
  RULE.test(line) ||
  LIST_ITEM.test(line) ||
  ORDERED_ITEM.test(line);

export const renderMarkdown = (source: string, citations?: CitationLinks): ReactNode[] => {
  const lines = source.split("\n");
  const blocks: ReactNode[] = [];
  let cursor = 0;
  let key = 0;

  while (cursor < lines.length) {
    const line = lines[cursor]!;

    if (line.trim().length === 0) {
      cursor += 1;
      continue;
    }

    if (FENCE.test(line)) {
      const body: string[] = [];
      cursor += 1;
      while (cursor < lines.length && !FENCE.test(lines[cursor]!)) {
        body.push(lines[cursor]!);
        cursor += 1;
      }
      // An unterminated fence still renders: the model ran out of tokens, and
      // the user should still see what it wrote.
      cursor += 1;
      blocks.push(
        <pre key={key++}>
          <code>{body.join("\n")}</code>
        </pre>,
      );
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading !== null) {
      blocks.push(<h4 key={key++}>{inline(heading[2]!, `h${key}`, citations)}</h4>);
      cursor += 1;
      continue;
    }

    if (QUOTE.test(line)) {
      const quoted: string[] = [];
      while (cursor < lines.length) {
        const match = QUOTE.exec(lines[cursor]!);
        if (match === null) break;
        quoted.push(match[1]!);
        cursor += 1;
      }
      blocks.push(
        <blockquote key={key++}>
          {inline(quoted.join(" ").trim(), `q${key}`, citations)}
        </blockquote>,
      );
      continue;
    }

    if (tableAt(lines, cursor)) {
      const header = cells(line);
      const rows: string[][] = [];
      cursor += 2;
      while (cursor < lines.length && lines[cursor]!.includes("|") && !startsBlock(lines[cursor]!)) {
        rows.push(cells(lines[cursor]!));
        cursor += 1;
      }
      const tableKey = key++;
      // Every row gets the header's cells: extra ones are dropped and missing ones left empty, as GFM does.
      blocks.push(
        <div key={tableKey} className="assistant-table">
          <table>
            <thead>
              <tr>{header.map((cell, index) => <th key={index} scope="col">{inline(cell, `th${tableKey}:${index}`, citations)}</th>)}</tr>
            </thead>
            <tbody>
              {rows.map((row, rowIndex) => (
                <tr key={rowIndex}>{header.map((_, index) => <td key={index}>{inline(row[index] ?? "", `td${tableKey}:${rowIndex}:${index}`, citations)}</td>)}</tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }

    if (RULE.test(line)) {
      blocks.push(<hr key={key++} />);
      cursor += 1;
      continue;
    }

    if (LIST_ITEM.test(line)) {
      const items: string[] = [];
      while (cursor < lines.length) {
        const match = LIST_ITEM.exec(lines[cursor]!);
        if (match === null) break;
        items.push(match[1]!);
        cursor += 1;
      }
      const listKey = key++;
      blocks.push(
        <ul key={listKey}>
          {items.map((item, index) => (
            <li key={index}>{inline(item, `ul${listKey}:${index}`, citations)}</li>
          ))}
        </ul>,
      );
      continue;
    }

    const ordered = ORDERED_ITEM.exec(line);
    if (ordered !== null) {
      const items: string[] = [];
      const start = Number.parseInt(ordered[1]!, 10);
      while (cursor < lines.length) {
        const match = ORDERED_ITEM.exec(lines[cursor]!);
        if (match === null) break;
        items.push(match[2]!);
        cursor += 1;
      }
      const listKey = key++;
      blocks.push(
        <ol key={listKey} start={start}>
          {items.map((item, index) => (
            <li key={index}>{inline(item, `ol${listKey}:${index}`, citations)}</li>
          ))}
        </ol>,
      );
      continue;
    }

    // A paragraph runs until a blank line or the start of another block.
    const paragraphLines: string[] = [];
    while (cursor < lines.length && !startsBlock(lines[cursor]!) && !tableAt(lines, cursor)) {
      paragraphLines.push(lines[cursor]!);
      cursor += 1;
    }
    const paragraphKey = key++;
    blocks.push(
      <p key={paragraphKey}>
        {inline(paragraphLines.join("\n"), `p${paragraphKey}`, citations)}
      </p>,
    );
  }

  return blocks;
};
