import {
  capturedDecisionEventSchema,
  type CapturedDecisionEvent,
} from "@cognelis/decision-protocol";
import type { RationaleSubmission } from "@cognelis/decision-core";
import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  link,
  mkdir,
  readFile,
  readdir,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";

const sha256 = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex");

const isSha256 = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);

const parseAppliedPrincipleIds = (value: unknown): string[] | undefined => {
  if (value === undefined) return undefined;
  if (
    !Array.isArray(value) ||
    value.length > 5 ||
    !value.every(
      (id) =>
        typeof id === "string" &&
        id.trim().length > 0 &&
        id === id.trim() &&
        id.length <= 200,
    ) ||
    new Set(value).size !== value.length
  ) {
    throw new Error("Capture disposition applied principles are invalid");
  }
  return [...value];
};

const parseDisposition = (
  value: unknown,
): RationaleSubmission => {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    !("status" in value) ||
    typeof value.status !== "string"
  ) {
    throw new Error("Capture disposition is invalid");
  }
  if (
    value.status === "deferred" ||
    value.status === "skipped"
  ) {
    const appliedPrincipleIds = parseAppliedPrincipleIds(
      "appliedPrincipleIds" in value ? value.appliedPrincipleIds : undefined,
    );
    return {
      status: value.status,
      ...(appliedPrincipleIds === undefined ? {} : { appliedPrincipleIds }),
    };
  }
  if (value.status === "not_recorded") {
    return { status: value.status };
  }
  if (value.status !== "captured") {
    throw new Error("Capture disposition status is invalid");
  }
  const rationale =
    "rationale" in value ? value.rationale : undefined;
  const reasonFactors =
    "reasonFactors" in value ? value.reasonFactors : undefined;
  const appliedPrincipleIds = parseAppliedPrincipleIds(
    "appliedPrincipleIds" in value ? value.appliedPrincipleIds : undefined,
  );
  if (
    (rationale !== undefined &&
      (typeof rationale !== "string" ||
        rationale.trim().length === 0 ||
        rationale.length > 8_000)) ||
    (reasonFactors !== undefined &&
      (!Array.isArray(reasonFactors) ||
        reasonFactors.length > 8 ||
        !reasonFactors.every(
          (factor) =>
            typeof factor === "string" &&
            factor.length > 0 &&
            factor.length <= 64,
        ))) ||
    (rationale === undefined &&
      (!Array.isArray(reasonFactors) || reasonFactors.length === 0) &&
      (appliedPrincipleIds?.length ?? 0) === 0)
  ) {
    throw new Error("Captured rationale disposition is invalid");
  }
  return {
    status: "captured",
    ...(rationale === undefined
      ? {}
      : { rationale: rationale as string }),
    ...(reasonFactors === undefined
      ? {}
      : { reasonFactors: [...reasonFactors] as string[] }),
    ...(appliedPrincipleIds === undefined ? {} : { appliedPrincipleIds }),
  };
};

interface SemanticOccurrenceReceipt {
  occurrenceId: string;
  semanticKey: string;
  captureMode: CapturedDecisionEvent["captureMode"];
  capturedAt: string;
}

const parseSemanticOccurrence = (
  value: unknown,
): SemanticOccurrenceReceipt => {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    !("occurrenceId" in value) ||
    !isSha256(value.occurrenceId) ||
    !("semanticKey" in value) ||
    !isSha256(value.semanticKey) ||
    !("captureMode" in value) ||
    (value.captureMode !== "structured_tool" &&
      value.captureMode !== "transcript") ||
    !("capturedAt" in value) ||
    typeof value.capturedAt !== "string" ||
    !Number.isFinite(Date.parse(value.capturedAt))
  ) {
    throw new Error("Semantic occurrence receipt is invalid");
  }
  return {
    occurrenceId: value.occurrenceId,
    semanticKey: value.semanticKey,
    captureMode: value.captureMode,
    capturedAt: value.capturedAt,
  };
};

const parseSemanticClaim = (
  value: unknown,
): SemanticClaim => {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    !("occurrenceId" in value) ||
    !isSha256(value.occurrenceId) ||
    !("aliasMode" in value) ||
    (value.aliasMode !== "structured_tool" &&
      value.aliasMode !== "transcript") ||
    !("aliasCandidateKey" in value) ||
    !isSha256(value.aliasCandidateKey)
  ) {
    throw new Error("Semantic alias claim is invalid");
  }
  return {
    occurrenceId: value.occurrenceId,
    aliasMode: value.aliasMode,
    aliasCandidateKey: value.aliasCandidateKey,
  };
};

interface SemanticAliasBinding {
  occurrenceId: string;
  aliasMode: CapturedDecisionEvent["captureMode"];
}

interface SemanticClaim extends SemanticAliasBinding {
  aliasCandidateKey: string;
}

const parseSemanticAliasBinding = (
  value: unknown,
): SemanticAliasBinding => {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    !("occurrenceId" in value) ||
    !isSha256(value.occurrenceId) ||
    !("aliasMode" in value) ||
    (value.aliasMode !== "structured_tool" &&
      value.aliasMode !== "transcript")
  ) {
    throw new Error("Semantic alias binding is invalid");
  }
  return {
    occurrenceId: value.occurrenceId,
    aliasMode: value.aliasMode,
  };
};

export class CaptureDispositionCorruptError extends Error {
  constructor(path: string, cause: unknown) {
    super(`Capture disposition is corrupt: ${path}`, { cause });
    this.name = "CaptureDispositionCorruptError";
  }
}

export class CaptureDispositionQuarantineError extends Error {
  constructor(path: string, cause: unknown) {
    super(`Capture disposition could not be quarantined: ${path}`, {
      cause,
    });
    this.name = "CaptureDispositionQuarantineError";
  }
}

export const captureEventKey = (
  event: CapturedDecisionEvent,
): string =>
  sha256(
    JSON.stringify([
      event.eventVersion,
      event.sourceClient,
      event.sessionId,
      event.sourceEventId ?? null,
      event.toolUseId ?? null,
      event.batchId,
    ]),
  );

export const captureQuestionKey = (
  event: CapturedDecisionEvent,
  questionIndex: number,
): string => sha256(`${captureEventKey(event)}:${questionIndex}`);

export class CaptureSpool {
  readonly path: string;
  readonly #eventsPath: string;
  readonly #receiptsPath: string;
  readonly #dispositionsPath: string;
  readonly #semanticReceiptsPath: string;
  readonly #semanticClaimsPath: string;
  readonly #semanticAliasesPath: string;
  #semanticClaimTail: Promise<void> = Promise.resolve();
  #recoveryIssue: string | null = null;

  constructor(path: string) {
    this.path = path;
    this.#eventsPath = join(path, "events");
    this.#receiptsPath = join(path, "receipts");
    this.#dispositionsPath = join(path, "dispositions");
    this.#semanticReceiptsPath = join(
      path,
      "semantic-receipts",
    );
    this.#semanticClaimsPath = join(path, "semantic-claims");
    this.#semanticAliasesPath = join(path, "semantic-aliases");
  }

  async append(input: CapturedDecisionEvent): Promise<void> {
    const event = capturedDecisionEventSchema.parse(input);
    await this.#secureDirectories();
    const pending = await this.#withoutAcknowledged(event);
    if (pending.questions.length === 0) {
      return;
    }
    await this.#writeJsonAtomically(
      this.#eventPath(event),
      pending,
      false,
    );
  }

  async list(): Promise<CapturedDecisionEvent[]> {
    await this.#secureDirectories();
    this.#recoveryIssue = null;
    await this.#sweepAcknowledgedDispositions();
    const events: CapturedDecisionEvent[] = [];
    for (const name of await readdir(this.#eventsPath)) {
      if (!name.endsWith(".json")) {
        continue;
      }
      const path = join(this.#eventsPath, name);
      let content: string;
      try {
        content = await readFile(path, "utf8");
      } catch {
        this.#recoveryIssue =
          "捕获事件暂时无法读取，事件已保留，请检查本地存储。";
        continue;
      }
      let event: CapturedDecisionEvent;
      try {
        event = capturedDecisionEventSchema.parse(
          JSON.parse(content),
        );
      } catch {
        await this.#quarantineFile(
          path,
          "捕获事件损坏，已隔离；其它事件仍会继续恢复。",
          "捕获事件损坏且无法隔离，请检查本地存储权限。",
        );
        continue;
      }
      const pending = await this.#withoutAcknowledged(event);
      if (pending.questions.length === 0) {
        await unlink(path).catch(() => undefined);
      } else {
        events.push(pending);
      }
    }
    return events.sort(
      (left, right) =>
        left.capturedAt.localeCompare(right.capturedAt) ||
        left.batchId.localeCompare(right.batchId),
    );
  }

  async acknowledge(
    input: CapturedDecisionEvent,
    questionIndex: number,
  ): Promise<void> {
    const event = capturedDecisionEventSchema.parse(input);
    if (
      !event.questions.some(
        (question) => question.questionIndex === questionIndex,
      )
    ) {
      throw new Error(
        `Capture event does not contain question ${questionIndex}`,
      );
    }
    await this.#secureDirectories();
    await writeFile(this.#receiptPath(event, questionIndex), "", {
      mode: 0o600,
      flag: "wx",
    }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") {
        throw error;
      }
    });
    await unlink(
      this.#dispositionPath(event, questionIndex),
    ).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") {
        throw error;
      }
    });

    const remaining = await this.#withoutAcknowledged(event);
    if (remaining.questions.length === 0) {
      await unlink(this.#eventPath(event)).catch(() => undefined);
    } else {
      await this.#writeJsonAtomically(
        this.#eventPath(event),
        remaining,
        true,
      );
    }
  }

  async isAcknowledged(
    event: CapturedDecisionEvent,
    questionIndex: number,
  ): Promise<boolean> {
    await this.#secureDirectories();
    try {
      await readFile(this.#receiptPath(event, questionIndex));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return false;
      }
      throw error;
    }
  }

  async saveDisposition(
    input: CapturedDecisionEvent,
    questionIndex: number,
    submission: RationaleSubmission,
  ): Promise<void> {
    const event = capturedDecisionEventSchema.parse(input);
    if (
      !event.questions.some(
        (question) => question.questionIndex === questionIndex,
      )
    ) {
      throw new Error(
        `Capture event does not contain question ${questionIndex}`,
      );
    }
    const disposition = parseDisposition(submission);
    await this.#secureDirectories();
    await this.#writeJsonAtomically(
      this.#dispositionPath(event, questionIndex),
      disposition,
      false,
    );
  }

  async replaceDisposition(
    input: CapturedDecisionEvent,
    questionIndex: number,
    submission: RationaleSubmission,
  ): Promise<void> {
    const event = capturedDecisionEventSchema.parse(input);
    if (
      !event.questions.some(
        (question) => question.questionIndex === questionIndex,
      )
    ) {
      throw new Error(
        `Capture event does not contain question ${questionIndex}`,
      );
    }
    const disposition = parseDisposition(submission);
    await this.#secureDirectories();
    await this.#writeJsonAtomically(
      this.#dispositionPath(event, questionIndex),
      disposition,
      true,
    );
  }

  async rememberSemanticOccurrence(
    occurrenceId: string,
    semanticKey: string,
    captureMode: CapturedDecisionEvent["captureMode"],
    capturedAt: string,
  ): Promise<void> {
    const receipt = parseSemanticOccurrence({
      occurrenceId,
      semanticKey,
      captureMode,
      capturedAt,
    });
    await this.#secureDirectories();
    await this.#writeJsonAtomically(
      this.#semanticReceiptPath(occurrenceId),
      receipt,
      false,
    );
  }

  async claimCrossModeSemantic(
    semanticKey: string,
    aliasMode: CapturedDecisionEvent["captureMode"],
    capturedAt: string,
    maximumAgeMs: number,
    aliasCandidateKey: string,
  ): Promise<boolean> {
    return this.#withSemanticClaimLock(async () => {
      await this.#secureDirectories();
      const existingBinding =
        await this.#readSemanticAliasBinding(aliasCandidateKey);
      if (existingBinding !== null) {
        if (existingBinding.aliasMode !== aliasMode) {
          return false;
        }
        return this.#claimKnownSemanticOccurrenceUnlocked(
          existingBinding.occurrenceId,
          aliasMode,
          aliasCandidateKey,
        );
      }

      const capturedTime = Date.parse(capturedAt);
      const occurrences: SemanticOccurrenceReceipt[] = [];
      for (const name of await readdir(
        this.#semanticReceiptsPath,
      )) {
        if (!name.endsWith(".json")) {
          continue;
        }
        const path = join(this.#semanticReceiptsPath, name);
        let content: string;
        try {
          content = await readFile(path, "utf8");
        } catch {
          this.#recoveryIssue =
            "部分语义去重状态暂时无法读取；其它有效状态仍会继续使用。";
          continue;
        }
        let receipt: SemanticOccurrenceReceipt;
        try {
          receipt = parseSemanticOccurrence(
            JSON.parse(content),
          );
        } catch {
          await this.#quarantineSemanticFile(path);
          continue;
        }
        if (
          receipt.semanticKey === semanticKey &&
          receipt.captureMode !== aliasMode &&
          Math.abs(
            Date.parse(receipt.capturedAt) - capturedTime,
          ) <= maximumAgeMs
        ) {
          occurrences.push(receipt);
        }
      }
      occurrences.sort(
        (left, right) =>
          Math.abs(Date.parse(left.capturedAt) - capturedTime) -
          Math.abs(Date.parse(right.capturedAt) - capturedTime),
      );
      for (const occurrence of occurrences) {
        if (
          await this.#claimKnownSemanticOccurrenceUnlocked(
            occurrence.occurrenceId,
            aliasMode,
            aliasCandidateKey,
          )
        ) {
          return true;
        }
      }
      return false;
    });
  }

  async claimKnownSemanticOccurrence(
    occurrenceId: string,
    aliasMode: CapturedDecisionEvent["captureMode"],
    aliasCandidateKey: string,
  ): Promise<boolean> {
    return this.#withSemanticClaimLock(async () => {
      await this.#secureDirectories();
      return this.#claimKnownSemanticOccurrenceUnlocked(
        occurrenceId,
        aliasMode,
        aliasCandidateKey,
      );
    });
  }

  async #claimKnownSemanticOccurrenceUnlocked(
    occurrenceId: string,
    aliasMode: CapturedDecisionEvent["captureMode"],
    aliasCandidateKey: string,
  ): Promise<boolean> {
    const existingBinding =
      await this.#readSemanticAliasBinding(aliasCandidateKey);
    if (
      existingBinding !== null &&
      (existingBinding.occurrenceId !== occurrenceId ||
        existingBinding.aliasMode !== aliasMode)
    ) {
      return false;
    }

    const claimPath = this.#semanticClaimPath(
      occurrenceId,
      aliasMode,
    );
    let claim = await this.#readSemanticClaim(
      claimPath,
      occurrenceId,
      aliasMode,
    );
    if (claim === null) {
      await this.#writeJsonAtomically(
        claimPath,
        { occurrenceId, aliasMode, aliasCandidateKey },
        false,
      );
      claim = await this.#readSemanticClaim(
        claimPath,
        occurrenceId,
        aliasMode,
      );
    }
    if (
      claim === null ||
      claim.aliasCandidateKey !== aliasCandidateKey
    ) {
      return false;
    }

    const aliasPath = this.#semanticAliasPath(
      aliasCandidateKey,
    );
    if (existingBinding === null) {
      await this.#writeJsonAtomically(
        aliasPath,
        { occurrenceId, aliasMode },
        false,
      );
    }
    const binding =
      await this.#readSemanticAliasBinding(aliasCandidateKey);
    return (
      binding?.occurrenceId === occurrenceId &&
      binding.aliasMode === aliasMode
    );
  }

  recoveryIssue(): string | null {
    return this.#recoveryIssue;
  }

  async loadDisposition(
    input: CapturedDecisionEvent,
    questionIndex: number,
  ): Promise<RationaleSubmission | null> {
    const event = capturedDecisionEventSchema.parse(input);
    await this.#secureDirectories();
    const path = this.#dispositionPath(event, questionIndex);
    let content: string;
    try {
      content = await readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw error;
    }
    try {
      return parseDisposition(JSON.parse(content));
    } catch (error) {
      const quarantined = `${path}.corrupt-${randomUUID()}`;
      try {
        await rename(path, quarantined);
        await chmod(quarantined, 0o600);
      } catch (quarantineError) {
        throw new CaptureDispositionQuarantineError(
          path,
          quarantineError,
        );
      }
      throw new CaptureDispositionCorruptError(path, error);
    }
  }

  #eventPath(event: CapturedDecisionEvent): string {
    return join(this.#eventsPath, `${captureEventKey(event)}.json`);
  }

  #receiptPath(
    event: CapturedDecisionEvent,
    questionIndex: number,
  ): string {
    return join(
      this.#receiptsPath,
      `${captureQuestionKey(event, questionIndex)}.ack`,
    );
  }

  #dispositionPath(
    event: CapturedDecisionEvent,
    questionIndex: number,
  ): string {
    return join(
      this.#dispositionsPath,
      `${captureQuestionKey(event, questionIndex)}.json`,
    );
  }

  #semanticReceiptPath(occurrenceId: string): string {
    return join(
      this.#semanticReceiptsPath,
      `${sha256(occurrenceId)}.json`,
    );
  }

  #semanticClaimPath(
    occurrenceId: string,
    aliasMode: CapturedDecisionEvent["captureMode"],
  ): string {
    return join(
      this.#semanticClaimsPath,
      `${sha256(`${occurrenceId}:${aliasMode}`)}.json`,
    );
  }

  #semanticAliasPath(aliasCandidateKey: string): string {
    return join(
      this.#semanticAliasesPath,
      `${sha256(aliasCandidateKey)}.json`,
    );
  }

  async #withoutAcknowledged(
    event: CapturedDecisionEvent,
  ): Promise<CapturedDecisionEvent> {
    const pending = [];
    for (const question of event.questions) {
      try {
        if (
          await this.isAcknowledged(
            event,
            question.questionIndex,
          )
        ) {
          continue;
        }
      } catch {
        this.#recoveryIssue =
          "捕获确认回执暂时无法读取；状态未知的问题已保留在待处理队列。";
      }
      pending.push(question);
    }
    return {
      ...event,
      questions: pending,
    };
  }

  async #secureDirectories(): Promise<void> {
    for (const path of [
      this.path,
      this.#eventsPath,
      this.#receiptsPath,
      this.#dispositionsPath,
      this.#semanticReceiptsPath,
      this.#semanticClaimsPath,
      this.#semanticAliasesPath,
    ]) {
      await mkdir(path, { recursive: true, mode: 0o700 });
      await chmod(path, 0o700);
    }
  }

  async #sweepAcknowledgedDispositions(): Promise<void> {
    for (const name of await readdir(this.#dispositionsPath)) {
      if (!name.endsWith(".json")) {
        continue;
      }
      const questionKey = name.slice(0, -".json".length);
      try {
        await readFile(
          join(this.#receiptsPath, `${questionKey}.ack`),
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          continue;
        }
        this.#recoveryIssue =
          "已确认的理由正文暂时无法清理，请检查本地存储权限。";
        continue;
      }
      try {
        await unlink(join(this.#dispositionsPath, name));
      } catch {
        this.#recoveryIssue =
          "已确认的理由正文暂时无法清理，请检查本地存储权限。";
      }
    }
  }

  async #readSemanticAliasBinding(
    aliasCandidateKey: string,
  ): Promise<SemanticAliasBinding | null> {
    const path = this.#semanticAliasPath(aliasCandidateKey);
    const binding =
      await this.#readSemanticAliasBindingFile(path);
    if (binding !== null) {
      return binding;
    }
    return this.#recoverSemanticAliasBinding(aliasCandidateKey);
  }

  async #readSemanticAliasBindingFile(
    path: string,
  ): Promise<SemanticAliasBinding | null> {
    let content: string;
    try {
      content = await readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      this.#recoveryIssue =
        "语义别名映射暂时无法读取，请检查本地存储权限。";
      throw error;
    }
    try {
      return parseSemanticAliasBinding(JSON.parse(content));
    } catch {
      await this.#quarantineSemanticFile(path);
      return null;
    }
  }

  async #readSemanticClaim(
    path: string,
    occurrenceId: string,
    aliasMode: CapturedDecisionEvent["captureMode"],
  ): Promise<SemanticClaim | null> {
    let content: string;
    try {
      content = await readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      this.#recoveryIssue =
        "语义配对状态暂时无法读取，请检查本地存储权限。";
      throw error;
    }
    try {
      const claim = parseSemanticClaim(JSON.parse(content));
      if (
        claim.occurrenceId !== occurrenceId ||
        claim.aliasMode !== aliasMode
      ) {
        throw new Error("Semantic claim identity is invalid");
      }
      return claim;
    } catch {
      await this.#quarantineSemanticFile(path);
      return null;
    }
  }

  async #recoverSemanticAliasBinding(
    aliasCandidateKey: string,
  ): Promise<SemanticAliasBinding | null> {
    for (const name of await readdir(this.#semanticClaimsPath)) {
      if (!name.endsWith(".json")) {
        continue;
      }
      const path = join(this.#semanticClaimsPath, name);
      let content: string;
      try {
        content = await readFile(path, "utf8");
      } catch {
        this.#recoveryIssue =
          "部分语义配对状态暂时无法读取；其它有效状态仍会继续使用。";
        continue;
      }
      let claim: SemanticClaim;
      try {
        claim = parseSemanticClaim(JSON.parse(content));
      } catch {
        await this.#quarantineSemanticFile(path);
        continue;
      }
      if (claim.aliasCandidateKey !== aliasCandidateKey) {
        continue;
      }

      const aliasPath = this.#semanticAliasPath(
        aliasCandidateKey,
      );
      await this.#writeJsonAtomically(
        aliasPath,
        {
          occurrenceId: claim.occurrenceId,
          aliasMode: claim.aliasMode,
        },
        false,
      );
      return this.#readSemanticAliasBindingFile(aliasPath);
    }
    return null;
  }

  async #quarantineSemanticFile(path: string): Promise<void> {
    await this.#quarantineFile(
      path,
      "语义去重状态损坏，已隔离；其它有效状态仍会继续使用。",
      "语义去重状态损坏且无法隔离，请检查本地存储权限。",
    );
  }

  async #quarantineFile(
    path: string,
    successMessage: string,
    failureMessage: string,
  ): Promise<void> {
    const quarantined = `${path}.corrupt-${randomUUID()}`;
    try {
      await rename(path, quarantined);
      await chmod(quarantined, 0o600);
      this.#recoveryIssue = successMessage;
    } catch {
      this.#recoveryIssue = failureMessage;
    }
  }

  async #withSemanticClaimLock<T>(
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.#semanticClaimTail;
    let release: () => void = () => undefined;
    this.#semanticClaimTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  async #writeJsonAtomically(
    path: string,
    value: unknown,
    replace: boolean,
  ): Promise<void> {
    const temporaryPath = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporaryPath, JSON.stringify(value), {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      if (replace) {
        await rename(temporaryPath, path);
      } else {
        await link(temporaryPath, path).catch(
          (error: NodeJS.ErrnoException) => {
            if (error.code !== "EEXIST") {
              throw error;
            }
          },
        );
      }
      await chmod(path, 0o600);
    } finally {
      await unlink(temporaryPath).catch(() => undefined);
    }
  }
}
