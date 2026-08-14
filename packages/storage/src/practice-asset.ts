import type {
  PracticeAssetKind,
  PracticeAssetRecord,
  PracticeAssetStatus,
} from "@cognelis/decision-core";
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

const DEFAULT_FOLDER = "Decision Journal";
const TRIGGER_START = "<!-- decision:practice-trigger-start -->";
const TRIGGER_END = "<!-- decision:practice-trigger-end -->";
const STEPS_START = "<!-- decision:practice-steps-start -->";
const STEPS_END = "<!-- decision:practice-steps-end -->";
const CHECKS_START = "<!-- decision:practice-checks-start -->";
const CHECKS_END = "<!-- decision:practice-checks-end -->";
const FALLBACK_START = "<!-- decision:practice-fallback-start -->";
const FALLBACK_END = "<!-- decision:practice-fallback-end -->";

const KINDS: readonly PracticeAssetKind[] = ["skill", "workflow"];
const STATUSES: readonly PracticeAssetStatus[] = [
  "candidate",
  "accepted",
  "dismissed",
];

interface PracticeAssetRepositoryOptions {
  folder?: string;
  rename?: typeof rename;
}

export interface SerializePracticeAssetOptions {
  includeSourceSnapshots?: boolean;
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

const optionalDate = (value: unknown, label: string): string | null =>
  value === null || value === undefined || value === ""
    ? null
    : requireDate(value, label);

const safeIdentifier = (value: string): string =>
  value
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9_-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 48) || "practice";

const fileStem = (id: string): string => {
  const digest = createHash("sha256")
    .update(id, "utf8")
    .digest("hex")
    .slice(0, 12);
  return `${safeIdentifier(id)}-${digest}`;
};

const section = (
  markdown: string,
  start: string,
  end: string,
  label: string,
  maximum: number,
): string => {
  const startIndex = markdown.indexOf(start);
  const endIndex = markdown.indexOf(end);
  if (startIndex < 0 || endIndex <= startIndex) {
    throw new Error(`Practice asset is missing ${label}`);
  }
  return requireText(
    markdown.slice(startIndex + start.length, endIndex),
    label,
    maximum,
  );
};

const listSection = (
  markdown: string,
  start: string,
  end: string,
  label: string,
  minimumItems: number,
  maximumItems: number,
): string[] => {
  const raw = section(markdown, start, end, label, 8_000);
  const values = raw
    .split("\n")
    .map((line) => line.replace(/^\s*(?:\d+\.|[-*])\s+/u, "").trim())
    .filter((line) => line.length > 0)
    .map((line) => requireText(line, label, 500));
  if (values.length < minimumItems || values.length > maximumItems) {
    throw new Error(
      `${label} must contain ${minimumItems}-${maximumItems} items`,
    );
  }
  return values;
};

const parseFrontmatter = (
  markdown: string,
): { properties: Record<string, unknown>; body: string } => {
  if (!markdown.startsWith("---\n")) {
    throw new Error("Practice asset must begin with YAML frontmatter");
  }
  const boundary = markdown.indexOf("\n---\n", 4);
  if (boundary < 0) {
    throw new Error("Practice asset has unterminated YAML frontmatter");
  }
  const parsed = parseYaml(markdown.slice(4, boundary));
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Practice asset frontmatter must be an object");
  }
  return {
    properties: parsed as Record<string, unknown>,
    body: markdown.slice(boundary + 5),
  };
};

const titleFromBody = (body: string): string => {
  const match = /^#\s+(.+)$/mu.exec(body);
  return requireText(match?.[1], "title", 120);
};

const validatedRecord = (input: PracticeAssetRecord): PracticeAssetRecord => {
  if (!KINDS.includes(input.kind)) {
    throw new Error("Practice asset kind is invalid");
  }
  if (!STATUSES.includes(input.status)) {
    throw new Error("Practice asset status is invalid");
  }
  const slug = requireText(input.slug, "slug", 64);
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(slug)) {
    throw new Error("Practice asset slug is invalid");
  }
  const sourcePrincipleIds = [
    ...new Set(
      input.sourcePrincipleIds.map((id) =>
        requireText(id, "source principle id", 200),
      ),
    ),
  ];
  if (sourcePrincipleIds.length === 0 || sourcePrincipleIds.length > 5) {
    throw new Error("Practice asset requires 1-5 source principles");
  }
  const steps = input.steps.map((step) =>
    requireText(step.replace(/\s+/gu, " "), "step", 500),
  );
  const checks = input.checks.map((check) =>
    requireText(check.replace(/\s+/gu, " "), "check", 500),
  );
  if (steps.length < 2 || steps.length > 12) {
    throw new Error("Practice asset requires 2-12 steps");
  }
  if (checks.length === 0 || checks.length > 8) {
    throw new Error("Practice asset requires 1-8 checks");
  }
  const acceptedAt = optionalDate(input.acceptedAt, "acceptedAt");
  if (input.status === "accepted" && acceptedAt === null) {
    throw new Error("Accepted practice asset requires acceptedAt");
  }
  const id = requireText(input.id, "practice asset id", 200);
  const sourceSnapshots = input.sourceSnapshots?.map((snapshot) => {
    const snapshotId = requireText(snapshot.id, "source snapshot id", 200);
    if (!sourcePrincipleIds.includes(snapshotId)) {
      throw new Error("Practice asset source snapshot does not belong to the asset");
    }
    if (!(["low", "medium", "high"] as const).includes(snapshot.confidence)) {
      throw new Error("Practice asset source snapshot confidence is invalid");
    }
    return {
      id: snapshotId,
      updatedAt: requireDate(snapshot.updatedAt, "source snapshot updatedAt"),
      title: requireText(snapshot.title, "source snapshot title", 120),
      principle: requireText(snapshot.principle, "source snapshot principle", 2_000),
      appliesWhen: requireText(
        snapshot.appliesWhen,
        "source snapshot appliesWhen",
        2_000,
      ),
      caution: requireText(snapshot.caution, "source snapshot caution", 2_000),
      confidence: snapshot.confidence,
    };
  });
  if (
    sourceSnapshots !== undefined &&
    new Set(sourceSnapshots.map((snapshot) => snapshot.id)).size !==
      sourceSnapshots.length
  ) {
    throw new Error("Practice asset source snapshots cannot contain duplicates");
  }
  const supersedesId =
    input.supersedesId === undefined || input.supersedesId === null
      ? null
      : requireText(input.supersedesId, "superseded asset id", 200);
  if (supersedesId === id) {
    throw new Error("Practice asset cannot supersede itself");
  }
  const migrationSourcePrincipleIds = [
    ...new Set(
      (input.migrationSourcePrincipleIds ?? []).map((sourceId) =>
        requireText(sourceId, "migration source principle id", 200),
      ),
    ),
  ];
  if (
    migrationSourcePrincipleIds.length > 5 ||
    (migrationSourcePrincipleIds.length > 0 &&
      (supersedesId === null ||
        input.status === "accepted" ||
        [...migrationSourcePrincipleIds].sort().join("\n") ===
          [...sourcePrincipleIds].sort().join("\n")))
  ) {
    throw new Error(
      "Source migration requires a replacement candidate with different previous sources",
    );
  }
  return {
    id,
    slug,
    kind: input.kind,
    status: input.status,
    createdAt: requireDate(input.createdAt, "createdAt"),
    updatedAt: requireDate(input.updatedAt, "updatedAt"),
    acceptedAt,
    title: requireText(input.title, "title", 120),
    summary: requireText(input.summary, "summary", 800),
    trigger: requireText(input.trigger, "trigger", 1_500),
    steps,
    checks,
    fallback: requireText(input.fallback, "fallback", 1_500),
    sourcePrincipleIds,
    ...(sourceSnapshots === undefined ? {} : { sourceSnapshots }),
    ...(supersedesId === null ? {} : { supersedesId }),
    ...(migrationSourcePrincipleIds.length === 0
      ? {}
      : { migrationSourcePrincipleIds }),
    generation: {
      requestId: requireText(input.generation.requestId, "request id", 200),
      profileId: requireText(input.generation.profileId, "profile id", 200),
      provider: requireText(input.generation.provider, "provider", 100),
      model: requireText(input.generation.model, "model", 200),
    },
  };
};

export const serializePracticeAsset = (
  input: PracticeAssetRecord,
  options: SerializePracticeAssetOptions = {},
): string => {
  const record = validatedRecord(input);
  const frontmatter = stringifyYaml(
    {
      name: record.slug,
      description: record.summary,
      metadata: {
        decision: {
          type: record.kind,
          version: 1,
          id: record.id,
          created: record.createdAt,
          updated: record.updatedAt,
          status: record.status,
          accepted_at: record.acceptedAt,
          source_principles: record.sourcePrincipleIds,
          ...(options.includeSourceSnapshots === false
            ? {}
            : { source_snapshots: record.sourceSnapshots ?? null }),
          supersedes_id: record.supersedesId ?? null,
          ...(record.migrationSourcePrincipleIds === undefined
            ? {}
            : {
                migration_source_principles:
                  record.migrationSourcePrincipleIds,
              }),
          generation_request: record.generation.requestId,
          generation_profile: record.generation.profileId,
          generation_provider: record.generation.provider,
          generation_model: record.generation.model,
        },
      },
    },
    { lineWidth: 0 },
  ).trimEnd();
  const steps = record.steps
    .map((step, index) => `${index + 1}. ${step}`)
    .join("\n");
  const checks = record.checks.map((check) => `- ${check}`).join("\n");
  return `---
${frontmatter}
---

# ${record.title}

## 使用条件

${TRIGGER_START}
${record.trigger}
${TRIGGER_END}

## 操作步骤

${STEPS_START}
${steps}
${STEPS_END}

## 验收检查

${CHECKS_START}
${checks}
${CHECKS_END}

## 失败处理

${FALLBACK_START}
${record.fallback}
${FALLBACK_END}
`;
};

export const parsePracticeAsset = (markdown: string): PracticeAssetRecord => {
  const { properties, body } = parseFrontmatter(markdown);
  const metadata = properties.metadata;
  if (metadata === null || typeof metadata !== "object" || Array.isArray(metadata)) {
    throw new Error("Practice asset metadata is missing");
  }
  const decision = (metadata as Record<string, unknown>).decision;
  if (decision === null || typeof decision !== "object" || Array.isArray(decision)) {
    throw new Error("Decision practice metadata is missing");
  }
  const values = decision as Record<string, unknown>;
  if (values.version !== 1) {
    throw new Error("Practice asset version is unsupported");
  }
  const kind = values.type;
  const status = values.status;
  if (typeof kind !== "string" || !KINDS.includes(kind as PracticeAssetKind)) {
    throw new Error("Practice asset kind is invalid");
  }
  if (
    typeof status !== "string" ||
    !STATUSES.includes(status as PracticeAssetStatus)
  ) {
    throw new Error("Practice asset status is invalid");
  }
  const sources = values.source_principles;
  if (!Array.isArray(sources)) {
    throw new Error("Practice asset sources are invalid");
  }
  return validatedRecord({
    id: requireText(values.id, "practice asset id", 200),
    slug: requireText(properties.name, "slug", 64),
    kind: kind as PracticeAssetKind,
    status: status as PracticeAssetStatus,
    createdAt: requireDate(values.created, "createdAt"),
    updatedAt: requireDate(values.updated, "updatedAt"),
    acceptedAt: optionalDate(values.accepted_at, "acceptedAt"),
    title: titleFromBody(body),
    summary: requireText(properties.description, "summary", 800),
    trigger: section(body, TRIGGER_START, TRIGGER_END, "trigger", 1_500),
    steps: listSection(body, STEPS_START, STEPS_END, "steps", 2, 12),
    checks: listSection(body, CHECKS_START, CHECKS_END, "checks", 1, 8),
    fallback: section(body, FALLBACK_START, FALLBACK_END, "fallback", 1_500),
    sourcePrincipleIds: sources.map((source) =>
      requireText(source, "source principle id", 200),
    ),
    ...(values.source_snapshots === null || values.source_snapshots === undefined
      ? {}
      : {
          sourceSnapshots: (() => {
            if (!Array.isArray(values.source_snapshots)) {
              throw new Error("Practice asset source snapshots are invalid");
            }
            return values.source_snapshots.map((snapshot) => {
              if (
                snapshot === null ||
                typeof snapshot !== "object" ||
                Array.isArray(snapshot)
              ) {
                throw new Error("Practice asset source snapshot is invalid");
              }
              const item = snapshot as Record<string, unknown>;
              return {
                id: requireText(item.id, "source snapshot id", 200),
                updatedAt: requireDate(
                  item.updatedAt,
                  "source snapshot updatedAt",
                ),
                title: requireText(item.title, "source snapshot title", 120),
                principle: requireText(
                  item.principle,
                  "source snapshot principle",
                  2_000,
                ),
                appliesWhen: requireText(
                  item.appliesWhen,
                  "source snapshot appliesWhen",
                  2_000,
                ),
                caution: requireText(
                  item.caution,
                  "source snapshot caution",
                  2_000,
                ),
                confidence: requireText(
                  item.confidence,
                  "source snapshot confidence",
                  20,
                ) as "low" | "medium" | "high",
              };
            });
          })(),
        }),
    ...(values.supersedes_id === null || values.supersedes_id === undefined
      ? {}
      : {
          supersedesId: requireText(
            values.supersedes_id,
            "superseded asset id",
            200,
          ),
        }),
    ...(values.migration_source_principles === null ||
    values.migration_source_principles === undefined
      ? {}
      : {
          migrationSourcePrincipleIds: (() => {
            if (!Array.isArray(values.migration_source_principles)) {
              throw new Error("Practice asset migration sources are invalid");
            }
            return values.migration_source_principles.map((source) =>
              requireText(source, "migration source principle id", 200),
            );
          })(),
        }),
    generation: {
      requestId: requireText(values.generation_request, "request id", 200),
      profileId: requireText(values.generation_profile, "profile id", 200),
      provider: requireText(values.generation_provider, "provider", 100),
      model: requireText(values.generation_model, "model", 200),
    },
  });
};

export class PracticeAssetRepository {
  readonly #vaultPath: string;
  readonly #folder: string;
  readonly #rename: typeof rename;

  constructor(vaultPath: string, options: PracticeAssetRepositoryOptions = {}) {
    this.#vaultPath = vaultPath;
    this.#folder = options.folder ?? DEFAULT_FOLDER;
    this.#rename = options.rename ?? rename;
  }

  async save(record: PracticeAssetRecord): Promise<void> {
    const validated = validatedRecord(record);
    const path = this.#pathFor(validated);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, serializePracticeAsset(validated), {
        encoding: "utf8",
        mode: 0o600,
      });
      await this.#rename(temporary, path);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  }

  async list(): Promise<PracticeAssetRecord[]> {
    const paths = [
      ...(await this.#listSkillPaths()),
      ...(await this.#listWorkflowPaths()),
    ];
    const records: PracticeAssetRecord[] = [];
    for (const path of paths) {
      try {
        records.push(parsePracticeAsset(await readFile(path, "utf8")));
      } catch {
        // External Markdown remains untouched; invalid notes are omitted.
      }
    }
    return records.sort(
      (left, right) =>
        right.updatedAt.localeCompare(left.updatedAt) ||
        left.id.localeCompare(right.id),
    );
  }

  async find(id: string): Promise<PracticeAssetRecord | null> {
    return (await this.list()).find((record) => record.id === id) ?? null;
  }

  #pathFor(record: PracticeAssetRecord): string {
    const stem = fileStem(record.id);
    return record.kind === "skill"
      ? join(this.#vaultPath, this.#folder, "skills", stem, "SKILL.md")
      : join(this.#vaultPath, this.#folder, "workflows", `${stem}.md`);
  }

  async #listSkillPaths(): Promise<string[]> {
    const root = join(this.#vaultPath, this.#folder, "skills");
    try {
      const entries = await readdir(root, { withFileTypes: true });
      return entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => join(root, entry.name, "SKILL.md"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  async #listWorkflowPaths(): Promise<string[]> {
    const root = join(this.#vaultPath, this.#folder, "workflows");
    try {
      const entries = await readdir(root, { withFileTypes: true });
      return entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
        .map((entry) => join(root, entry.name));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }
}
