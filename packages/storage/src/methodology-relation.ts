import type {
  MethodologyRelationDisposition,
  MethodologyRelationRecord,
} from "@cognelis/decision-core";
import { canonicalMethodologyPair } from "@cognelis/decision-core";
import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import { normalizeLegacyDecisionMarkers } from "./legacy-markers.js";

const DEFAULT_FOLDER = "Decision Journal";
const NOTE_START = "<!-- decision:methodology-relation-note-start -->";
const NOTE_END = "<!-- decision:methodology-relation-note-end -->";
const DISPOSITIONS: readonly MethodologyRelationDisposition[] = [
  "duplicate",
  "conflict",
  "unrelated",
];

interface MethodologyRelationRepositoryOptions {
  folder?: string;
  rename?: typeof rename;
}

const requireText = (
  value: unknown,
  label: string,
  maximum: number,
): string => {
  if (typeof value !== "string") throw new Error(`${label} must be text`);
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > maximum) {
    throw new Error(`${label} must contain 1-${maximum} characters`);
  }
  return normalized;
};

const requireDate = (value: unknown, label: string): string => {
  const date = requireText(value, label, 100);
  if (!Number.isFinite(Date.parse(date))) {
    throw new Error(`${label} must be an ISO date`);
  }
  return date;
};

const optionalNote = (value: unknown): string | null => {
  if (value === null || value === undefined || value === "") return null;
  return requireText(value, "relation note", 500);
};

const validatedRecord = (
  input: MethodologyRelationRecord,
): MethodologyRelationRecord => {
  if (!DISPOSITIONS.includes(input.disposition)) {
    throw new Error("Methodology relation disposition is invalid");
  }
  if (input.principleIds.length !== 2 || input.principleTitles.length !== 2) {
    throw new Error("Methodology relation requires exactly two principles");
  }
  const rawIds: [string, string] = [
    requireText(input.principleIds[0], "principle id", 200),
    requireText(input.principleIds[1], "principle id", 200),
  ];
  if (rawIds[0] === rawIds[1]) {
    throw new Error("Methodology relation principles must differ");
  }
  const canonicalIds = canonicalMethodologyPair(...rawIds);
  const titlesById = new Map([
    [rawIds[0], requireText(input.principleTitles[0], "principle title", 120)],
    [rawIds[1], requireText(input.principleTitles[1], "principle title", 120)],
  ]);
  return {
    id: requireText(input.id, "methodology relation id", 200),
    createdAt: requireDate(input.createdAt, "createdAt"),
    updatedAt: requireDate(input.updatedAt, "updatedAt"),
    principleIds: canonicalIds,
    principleTitles: [
      titlesById.get(canonicalIds[0])!,
      titlesById.get(canonicalIds[1])!,
    ],
    disposition: input.disposition,
    note: optionalNote(input.note),
  };
};

const fileNameFor = (id: string): string => {
  const digest = createHash("sha256").update(id, "utf8").digest("hex").slice(0, 16);
  return `relation-${digest}.md`;
};

const parseFrontmatter = (
  markdown: string,
): { properties: Record<string, unknown>; body: string } => {
  if (!markdown.startsWith("---\n")) {
    throw new Error("Methodology relation must begin with YAML frontmatter");
  }
  const boundary = markdown.indexOf("\n---\n", 4);
  if (boundary < 0) {
    throw new Error("Methodology relation has unterminated YAML frontmatter");
  }
  const parsed = parseYaml(markdown.slice(4, boundary));
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Methodology relation frontmatter must be an object");
  }
  return {
    properties: parsed as Record<string, unknown>,
    body: markdown.slice(boundary + 5),
  };
};

const noteFromBody = (body: string): string | null => {
  const start = body.indexOf(NOTE_START);
  const end = body.indexOf(NOTE_END);
  if (start < 0 || end <= start) {
    throw new Error("Methodology relation is missing its review note");
  }
  return optionalNote(body.slice(start + NOTE_START.length, end).trim());
};

const dispositionLabels: Record<MethodologyRelationDisposition, string> = {
  duplicate: "重复",
  conflict: "冲突",
  unrelated: "无关",
};

export const serializeMethodologyRelation = (
  input: MethodologyRelationRecord,
): string => {
  const record = validatedRecord(input);
  const frontmatter = stringifyYaml(
    {
      type: "decision-methodology-relation",
      version: 1,
      id: record.id,
      created: record.createdAt,
      updated: record.updatedAt,
      principles: record.principleIds,
      principle_titles: record.principleTitles,
      disposition: record.disposition,
    },
    { lineWidth: 0 },
  ).trimEnd();
  return `---
${frontmatter}
---

# 方法论关系核对

- ${record.principleTitles[0]}（${record.principleIds[0]}）
- ${record.principleTitles[1]}（${record.principleIds[1]}）

## 人工结论

${dispositionLabels[record.disposition]}

## 核对说明

${NOTE_START}
${record.note ?? ""}
${NOTE_END}
`;
};

export const parseMethodologyRelation = (
  markdown: string,
): MethodologyRelationRecord => {
  markdown = normalizeLegacyDecisionMarkers(markdown);
  const { properties, body } = parseFrontmatter(markdown);
  if (
    properties.type !== "decision-methodology-relation" ||
    properties.version !== 1
  ) {
    throw new Error("Methodology relation type or version is invalid");
  }
  if (
    !Array.isArray(properties.principles) ||
    properties.principles.length !== 2 ||
    !Array.isArray(properties.principle_titles) ||
    properties.principle_titles.length !== 2 ||
    typeof properties.disposition !== "string" ||
    !DISPOSITIONS.includes(
      properties.disposition as MethodologyRelationDisposition,
    )
  ) {
    throw new Error("Methodology relation metadata is invalid");
  }
  return validatedRecord({
    id: requireText(properties.id, "methodology relation id", 200),
    createdAt: requireDate(properties.created, "createdAt"),
    updatedAt: requireDate(properties.updated, "updatedAt"),
    principleIds: properties.principles as [string, string],
    principleTitles: properties.principle_titles as [string, string],
    disposition: properties.disposition as MethodologyRelationDisposition,
    note: noteFromBody(body),
  });
};

export class MethodologyRelationRepository {
  readonly #directory: string;
  readonly #rename: typeof rename;

  constructor(
    vaultPath: string,
    options: MethodologyRelationRepositoryOptions = {},
  ) {
    this.#directory = join(
      vaultPath,
      options.folder ?? DEFAULT_FOLDER,
      "principle-relations",
    );
    this.#rename = options.rename ?? rename;
  }

  async save(record: MethodologyRelationRecord): Promise<void> {
    const content = serializeMethodologyRelation(record);
    const path = this.#pathFor(record.id);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, content, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      await this.#rename(temporary, path);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  }

  async remove(id: string): Promise<void> {
    try {
      await unlink(this.#pathFor(requireText(id, "methodology relation id", 200)));
    } catch (error) {
      if (
        error !== null &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return;
      }
      throw error;
    }
  }

  async list(): Promise<MethodologyRelationRecord[]> {
    let entries;
    try {
      entries = await readdir(this.#directory, { withFileTypes: true });
    } catch (error) {
      if (
        error !== null &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return [];
      }
      throw error;
    }
    const records: MethodologyRelationRecord[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      try {
        records.push(
          parseMethodologyRelation(
            await readFile(join(this.#directory, entry.name), "utf8"),
          ),
        );
      } catch {
        // Invalid external notes remain untouched and are omitted from the UI.
      }
    }
    return records.sort(
      (left, right) =>
        right.updatedAt.localeCompare(left.updatedAt) ||
        left.id.localeCompare(right.id),
    );
  }

  #pathFor(id: string): string {
    return join(this.#directory, fileNameFor(id));
  }
}
