import type {
  MethodologyConfidence,
  MethodologyOrigin,
  MethodologyRecord,
  MethodologyStatus,
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

import { normalizeLegacyDecisionMarkers } from "./legacy-markers.js";

const DEFAULT_FOLDER = "Decision Journal";
const PRINCIPLE_START = "<!-- decision:methodology-principle-start -->";
const PRINCIPLE_END = "<!-- decision:methodology-principle-end -->";
const APPLIES_START = "<!-- decision:methodology-applies-start -->";
const APPLIES_END = "<!-- decision:methodology-applies-end -->";
const CAUTION_START = "<!-- decision:methodology-caution-start -->";
const CAUTION_END = "<!-- decision:methodology-caution-end -->";
const EVIDENCE_START = "<!-- decision:methodology-evidence-start -->";
const EVIDENCE_END = "<!-- decision:methodology-evidence-end -->";

const STATUSES: readonly MethodologyStatus[] = [
  "candidate",
  "accepted",
  "retired",
  "dismissed",
];
const CONFIDENCES: readonly MethodologyConfidence[] = ["low", "medium", "high"];
const ORIGINS: readonly MethodologyOrigin[] = [
  "decision_evidence",
  "markdown_import",
  "manual_entry",
  "principle_merge",
  "principle_revision",
];

interface MethodologyRepositoryOptions {
  folder?: string;
  rename?: typeof rename;
}

const requireText = (
  value: unknown,
  label: string,
  maximum: number,
): string => {
  if (typeof value !== "string") {
    throw new Error(`${label} must be text`);
  }
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > maximum) {
    throw new Error(`${label} must contain 1-${maximum} characters`);
  }
  return normalized;
};

const optionalDate = (value: unknown, label: string): string | null => {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const date = requireText(value, label, 100);
  if (!Number.isFinite(Date.parse(date))) {
    throw new Error(`${label} must be an ISO date`);
  }
  return date;
};

const requireDate = (value: unknown, label: string): string => {
  const date = optionalDate(value, label);
  if (date === null) {
    throw new Error(`${label} is required`);
  }
  return date;
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
    throw new Error(`Methodology note is missing ${label}`);
  }
  return requireText(
    markdown.slice(startIndex + start.length, endIndex),
    label,
    maximum,
  );
};

const safeIdentifier = (value: string): string =>
  value
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9_-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 48) || "methodology";

const fileNameFor = (id: string): string => {
  const digest = createHash("sha256")
    .update(id, "utf8")
    .digest("hex")
    .slice(0, 12);
  return `${safeIdentifier(id)}-${digest}.md`;
};

const parseFrontmatter = (
  markdown: string,
): { properties: Record<string, unknown>; body: string } => {
  if (!markdown.startsWith("---\n")) {
    throw new Error("Methodology note must begin with YAML frontmatter");
  }
  const boundary = markdown.indexOf("\n---\n", 4);
  if (boundary < 0) {
    throw new Error("Methodology note has unterminated YAML frontmatter");
  }
  const parsed = parseYaml(markdown.slice(4, boundary));
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Methodology note frontmatter must be an object");
  }
  return {
    properties: parsed as Record<string, unknown>,
    body: markdown.slice(boundary + 5),
  };
};

const validatedRecord = (input: MethodologyRecord): MethodologyRecord => {
  const id = requireText(input.id, "methodology id", 200);
  const createdAt = requireDate(input.createdAt, "createdAt");
  const updatedAt = requireDate(input.updatedAt, "updatedAt");
  if (!STATUSES.includes(input.status)) {
    throw new Error("Methodology status is invalid");
  }
  if (!CONFIDENCES.includes(input.confidence)) {
    throw new Error("Methodology confidence is invalid");
  }
  if (!ORIGINS.includes(input.origin)) {
    throw new Error("Methodology origin is invalid");
  }
  const sourceDecisionIds = [
    ...new Set(
      input.sourceDecisionIds.map((value) =>
        requireText(value, "source decision id", 200),
      ),
    ),
  ];
  const sourcePrincipleIds = [
    ...new Set(
      (input.sourcePrincipleIds ?? []).map((value) =>
        requireText(value, "source principle id", 200),
      ),
    ),
  ];
  const importSource =
    input.importSource === undefined
      ? null
      : {
          fileName: requireText(
            input.importSource.fileName,
            "import source file name",
            240,
          ),
          contentSha256: requireText(
            input.importSource.contentSha256,
            "import source content sha256",
            64,
          ).toLocaleLowerCase("en-US"),
        };
  if (
    importSource !== null &&
    !/^[a-f0-9]{64}$/u.test(importSource.contentSha256)
  ) {
    throw new Error("Import source content sha256 is invalid");
  }
  if (
    (input.origin !== "markdown_import" && importSource !== null) ||
    (input.origin === "markdown_import" &&
      input.importSource !== undefined &&
      importSource === null)
  ) {
    throw new Error("Only imported methodology can retain an import source");
  }
  const requiresEvidence =
    input.origin === "decision_evidence" ||
    input.origin === "principle_merge" ||
    input.origin === "principle_revision";
  if (
    sourceDecisionIds.length > 5 ||
    (requiresEvidence && sourceDecisionIds.length === 0)
  ) {
    throw new Error(
      requiresEvidence
        ? "Evidence-based, merged, and revised methodology requires 1-5 source decisions"
        : "Imported and manually entered methodology supports at most 5 source decisions",
    );
  }
  if (
    (input.origin === "principle_merge" &&
      (sourcePrincipleIds.length < 2 || sourcePrincipleIds.length > 5)) ||
    (input.origin === "principle_revision" &&
      sourcePrincipleIds.length !== 1) ||
    (input.origin !== "principle_merge" &&
      input.origin !== "principle_revision" &&
      sourcePrincipleIds.length > 0)
  ) {
    throw new Error(
      "Merged methodology requires 2-5 source principles and revised methodology requires exactly 1",
    );
  }
  if (sourcePrincipleIds.includes(id)) {
    throw new Error("Methodology cannot use itself as a source principle");
  }
  const appliedAt = optionalDate(input.appliedAt, "appliedAt");
  const appliedToId =
    input.appliedToId === undefined
      ? null
      : requireText(input.appliedToId, "applied methodology id", 200);
  if (
    (appliedAt === null) !== (appliedToId === null) ||
    (appliedAt !== null &&
      (input.origin !== "principle_revision" || input.status !== "dismissed"))
  ) {
    throw new Error(
      "Applied revision requires appliedAt and appliedToId on a dismissed revision candidate",
    );
  }
  if (appliedToId === id) {
    throw new Error("Methodology revision cannot apply to itself");
  }
  const confirmedAt = optionalDate(input.confirmedAt, "confirmedAt");
  if (
    (input.status === "accepted" || input.status === "retired") &&
    confirmedAt === null
  ) {
    throw new Error("Accepted and retired methodology requires confirmedAt");
  }
  const retiredAt = optionalDate(input.retiredAt, "retiredAt");
  const supersededById =
    input.supersededById === undefined
      ? null
      : requireText(input.supersededById, "superseding methodology id", 200);
  if (
    (input.status === "retired" &&
      (retiredAt === null || supersededById === null)) ||
    (input.status !== "retired" &&
      (retiredAt !== null || supersededById !== null))
  ) {
    throw new Error(
      "Retired methodology requires retiredAt and supersededById",
    );
  }
  if (supersededById === id) {
    throw new Error("Methodology cannot supersede itself");
  }
  const usageValidation =
    input.usageValidation === undefined
      ? null
      : {
          reviewedAt: requireDate(
            input.usageValidation.reviewedAt,
            "usage validation reviewedAt",
          ),
          decisionId: requireText(
            input.usageValidation.decisionId,
            "usage validation decision id",
            200,
          ),
          validatedAt: requireDate(
            input.usageValidation.validatedAt,
            "usage validation validatedAt",
          ),
        };
  return {
    id,
    createdAt,
    updatedAt,
    origin: input.origin,
    status: input.status,
    confirmedAt,
    title: requireText(input.title, "title", 120),
    principle: requireText(input.principle, "principle", 2_000),
    appliesWhen: requireText(input.appliesWhen, "appliesWhen", 2_000),
    caution: requireText(input.caution, "caution", 2_000),
    evidenceSummary: requireText(
      input.evidenceSummary,
      "evidenceSummary",
      3_000,
    ),
    sourceDecisionIds,
    ...(sourcePrincipleIds.length === 0 ? {} : { sourcePrincipleIds }),
    ...(importSource === null ? {} : { importSource }),
    ...(appliedAt === null ? {} : { appliedAt }),
    ...(appliedToId === null ? {} : { appliedToId }),
    ...(retiredAt === null ? {} : { retiredAt }),
    ...(supersededById === null ? {} : { supersededById }),
    ...(usageValidation === null ? {} : { usageValidation }),
    confidence: input.confidence,
    generation: {
      requestId: requireText(
        input.generation.requestId,
        "generation request id",
        200,
      ),
      profileId: requireText(
        input.generation.profileId,
        "generation profile id",
        200,
      ),
      provider: requireText(
        input.generation.provider,
        "generation provider",
        100,
      ),
      model: requireText(input.generation.model, "generation model", 200),
    },
  };
};

export const serializeMethodology = (input: MethodologyRecord): string => {
  const record = validatedRecord(input);
  const frontmatter = stringifyYaml(
    {
      type: "decision-methodology",
      version: 1,
      id: record.id,
      origin: record.origin,
      created: record.createdAt,
      updated: record.updatedAt,
      status: record.status,
      confirmed_at: record.confirmedAt,
      confidence: record.confidence,
      source_decisions: record.sourceDecisionIds,
      ...(record.sourcePrincipleIds === undefined
        ? {}
        : { source_principles: record.sourcePrincipleIds }),
      ...(record.importSource === undefined
        ? {}
        : {
            import_source_file: record.importSource.fileName,
            import_source_sha256: record.importSource.contentSha256,
          }),
      ...(record.appliedAt === undefined
        ? {}
        : { applied_at: record.appliedAt, applied_to: record.appliedToId }),
      ...(record.retiredAt === undefined
        ? {}
        : { retired_at: record.retiredAt }),
      ...(record.supersededById === undefined
        ? {}
        : { superseded_by: record.supersededById }),
      ...(record.usageValidation === undefined
        ? {}
        : {
            usage_validation_reviewed_at: record.usageValidation.reviewedAt,
            usage_validation_decision: record.usageValidation.decisionId,
            usage_validated_at: record.usageValidation.validatedAt,
          }),
      generation_request: record.generation.requestId,
      generation_profile: record.generation.profileId,
      generation_provider: record.generation.provider,
      generation_model: record.generation.model,
    },
    { lineWidth: 0 },
  ).trimEnd();
  return `---
${frontmatter}
---

# ${record.title}

## 原则

${PRINCIPLE_START}
${record.principle}
${PRINCIPLE_END}

## 适用条件

${APPLIES_START}
${record.appliesWhen}
${APPLIES_END}

## 注意事项

${CAUTION_START}
${record.caution}
${CAUTION_END}

## 证据摘要

${EVIDENCE_START}
${record.evidenceSummary}
${EVIDENCE_END}
`;
};

export const parseMethodology = (markdown: string): MethodologyRecord => {
  markdown = normalizeLegacyDecisionMarkers(markdown);
  const { properties, body } = parseFrontmatter(markdown);
  if (properties.type !== "decision-methodology" || properties.version !== 1) {
    throw new Error("Methodology note type or version is invalid");
  }
  const status = properties.status;
  const confidence = properties.confidence;
  const origin = properties.origin ?? "decision_evidence";
  if (
    typeof status !== "string" ||
    !STATUSES.includes(status as MethodologyStatus)
  ) {
    throw new Error("Methodology note status is invalid");
  }
  if (
    typeof confidence !== "string" ||
    !CONFIDENCES.includes(confidence as MethodologyConfidence)
  ) {
    throw new Error("Methodology note confidence is invalid");
  }
  if (
    typeof origin !== "string" ||
    !ORIGINS.includes(origin as MethodologyOrigin)
  ) {
    throw new Error("Methodology note origin is invalid");
  }
  if (!Array.isArray(properties.source_decisions)) {
    throw new Error("Methodology note source decisions are invalid");
  }
  if (
    properties.source_principles !== undefined &&
    !Array.isArray(properties.source_principles)
  ) {
    throw new Error("Methodology note source principles are invalid");
  }
  const titleMatch = body.match(/^#\s+([^\n]+)$/mu);
  if (titleMatch?.[1] === undefined) {
    throw new Error("Methodology note is missing its title");
  }
  return validatedRecord({
    id: requireText(properties.id, "methodology id", 200),
    createdAt: requireDate(properties.created, "createdAt"),
    updatedAt: requireDate(properties.updated, "updatedAt"),
    origin: origin as MethodologyOrigin,
    status: status as MethodologyStatus,
    confirmedAt: optionalDate(properties.confirmed_at, "confirmedAt"),
    title: titleMatch[1],
    principle: section(
      body,
      PRINCIPLE_START,
      PRINCIPLE_END,
      "principle",
      2_000,
    ),
    appliesWhen: section(
      body,
      APPLIES_START,
      APPLIES_END,
      "appliesWhen",
      2_000,
    ),
    caution: section(body, CAUTION_START, CAUTION_END, "caution", 2_000),
    evidenceSummary: section(
      body,
      EVIDENCE_START,
      EVIDENCE_END,
      "evidenceSummary",
      3_000,
    ),
    sourceDecisionIds: properties.source_decisions as string[],
    ...(properties.source_principles === undefined
      ? {}
      : { sourcePrincipleIds: properties.source_principles as string[] }),
    ...(properties.import_source_file === undefined &&
    properties.import_source_sha256 === undefined
      ? {}
      : {
          importSource: {
            fileName: requireText(
              properties.import_source_file,
              "import source file name",
              240,
            ),
            contentSha256: requireText(
              properties.import_source_sha256,
              "import source content sha256",
              64,
            ),
          },
        }),
    ...(properties.applied_at === undefined &&
    properties.applied_to === undefined
      ? {}
      : {
          appliedAt: requireDate(properties.applied_at, "appliedAt"),
          appliedToId: requireText(
            properties.applied_to,
            "applied methodology id",
            200,
          ),
        }),
    ...(properties.retired_at === undefined
      ? {}
      : { retiredAt: requireDate(properties.retired_at, "retiredAt") }),
    ...(properties.superseded_by === undefined
      ? {}
      : {
          supersededById: requireText(
            properties.superseded_by,
            "superseding methodology id",
            200,
          ),
        }),
    ...(properties.usage_validation_reviewed_at === undefined &&
    properties.usage_validation_decision === undefined &&
    properties.usage_validated_at === undefined
      ? {}
      : {
          usageValidation: {
            reviewedAt: requireDate(
              properties.usage_validation_reviewed_at,
              "usage validation reviewedAt",
            ),
            decisionId: requireText(
              properties.usage_validation_decision,
              "usage validation decision id",
              200,
            ),
            validatedAt: requireDate(
              properties.usage_validated_at,
              "usage validation validatedAt",
            ),
          },
        }),
    confidence: confidence as MethodologyConfidence,
    generation: {
      requestId: requireText(
        properties.generation_request,
        "generation request id",
        200,
      ),
      profileId: requireText(
        properties.generation_profile,
        "generation profile id",
        200,
      ),
      provider: requireText(
        properties.generation_provider,
        "generation provider",
        100,
      ),
      model: requireText(properties.generation_model, "generation model", 200),
    },
  });
};

export class MethodologyRepository {
  readonly #directory: string;
  readonly #rename: typeof rename;

  constructor(vaultPath: string, options: MethodologyRepositoryOptions = {}) {
    this.#directory = join(
      vaultPath,
      options.folder ?? DEFAULT_FOLDER,
      "principles",
    );
    this.#rename = options.rename ?? rename;
  }

  async save(record: MethodologyRecord): Promise<void> {
    const content = serializeMethodology(record);
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

  async find(id: string): Promise<MethodologyRecord | null> {
    try {
      return parseMethodology(await readFile(this.#pathFor(id), "utf8"));
    } catch (error) {
      if (
        error !== null &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return null;
      }
      throw error;
    }
  }

  async list(): Promise<MethodologyRecord[]> {
    let entries;
    try {
      entries = await readdir(this.#directory, {
        withFileTypes: true,
      });
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
    const records: MethodologyRecord[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".md")) {
        continue;
      }
      try {
        records.push(
          parseMethodology(
            await readFile(join(this.#directory, entry.name), "utf8"),
          ),
        );
      } catch {
        // External invalid notes remain untouched and are omitted from the UI.
      }
    }
    return records.sort(
      (left, right) =>
        right.updatedAt.localeCompare(left.updatedAt) ||
        right.id.localeCompare(left.id),
    );
  }

  #pathFor(id: string): string {
    return join(this.#directory, fileNameFor(id));
  }
}
