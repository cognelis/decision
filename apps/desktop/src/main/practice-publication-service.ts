import type {
  PracticeAssetRecord,
  PracticePublicationReceipt,
  PracticePublicationState,
  PracticePublicationStatus,
  PracticePublicationTarget,
} from "@cognelis/decision-core";
import { serializePracticeAsset } from "@cognelis/decision-storage";
import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  rename,
  rmdir,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";

interface PracticeAssetSource {
  find(id: string): Promise<PracticeAssetRecord | null>;
}

interface PublicationVersion {
  version: number;
  publishedAt: string;
  sourceHash: string;
  publishedHash: string;
  previousExisted: boolean;
}

interface PublicationHistory {
  assetId: string;
  target: PracticePublicationTarget;
  versions: PublicationVersion[];
}

interface PublicationManifest {
  version: 1;
  publications: Record<string, PublicationHistory>;
}

interface TargetInspection {
  state: "missing" | "file" | "unsafe";
  path: string;
  content: Buffer | null;
  reason: string | null;
}

interface PublicationSnapshot {
  asset: PracticeAssetRecord;
  sourceHash: string;
  history: PublicationHistory | null;
  latest: PublicationVersion | null;
  inspection: TargetInspection;
  status: PracticePublicationStatus;
}

export interface PracticePublicationServiceOptions {
  assets: PracticeAssetSource;
  stateRoot: string;
  targetRoots?: Partial<Record<PracticePublicationTarget, string>>;
  now?: () => Date;
  validateBeforePublish?: (asset: PracticeAssetRecord) => Promise<void>;
}

const TARGET_LABELS: Record<PracticePublicationTarget, string> = {
  codex: "Codex",
  "claude-code": "Claude Code",
};

const defaultTargetRoots = (): Record<PracticePublicationTarget, string> => ({
  codex: join(homedir(), ".codex", "skills"),
  "claude-code": join(homedir(), ".claude", "skills"),
});

const emptyManifest = (): PublicationManifest => ({
  version: 1,
  publications: {},
});

const hash = (content: string | Buffer): string =>
  createHash("sha256").update(content).digest("hex");

const historyKey = (
  assetId: string,
  target: PracticePublicationTarget,
): string => `${target}:${assetId}`;

const backupStem = (key: string): string => hash(key).slice(0, 24);

const isMissing = (error: unknown): boolean =>
  error instanceof Error && "code" in error && error.code === "ENOENT";

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const parseVersion = (value: unknown): PublicationVersion => {
  if (!isObject(value)) throw new Error("发布历史损坏：版本记录无效");
  const { version, publishedAt, sourceHash, publishedHash, previousExisted } =
    value;
  if (
    !Number.isSafeInteger(version) ||
    (version as number) < 1 ||
    typeof publishedAt !== "string" ||
    Number.isNaN(Date.parse(publishedAt)) ||
    typeof sourceHash !== "string" ||
    !/^[a-f0-9]{64}$/u.test(sourceHash) ||
    typeof publishedHash !== "string" ||
    !/^[a-f0-9]{64}$/u.test(publishedHash) ||
    typeof previousExisted !== "boolean"
  ) {
    throw new Error("发布历史损坏：版本字段无效");
  }
  return {
    version: version as number,
    publishedAt,
    sourceHash,
    publishedHash,
    previousExisted,
  };
};

const parseManifest = (value: unknown): PublicationManifest => {
  if (!isObject(value) || value.version !== 1 || !isObject(value.publications)) {
    throw new Error("发布历史损坏，已停止写入以保护现有客户端内容");
  }
  const publications: Record<string, PublicationHistory> = {};
  for (const [key, rawHistory] of Object.entries(value.publications)) {
    if (!isObject(rawHistory)) {
      throw new Error("发布历史损坏：资产记录无效");
    }
    const target = rawHistory.target;
    const assetId = rawHistory.assetId;
    if (
      (target !== "codex" && target !== "claude-code") ||
      typeof assetId !== "string" ||
      assetId.length === 0 ||
      !Array.isArray(rawHistory.versions)
    ) {
      throw new Error("发布历史损坏：资产字段无效");
    }
    const versions = rawHistory.versions.map(parseVersion);
    if (
      key !== historyKey(assetId, target) ||
      versions.some((version, index) => version.version !== index + 1)
    ) {
      throw new Error("发布历史损坏：版本顺序无效");
    }
    publications[key] = { assetId, target, versions };
  }
  return { version: 1, publications };
};

const assertSafeSlug = (slug: string): void => {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(slug) || slug.length > 64) {
    throw new Error("资产标识不安全，无法发布到客户端");
  }
};

const assertInside = (root: string, path: string): void => {
  const normalizedRoot = resolve(root);
  const normalizedPath = resolve(path);
  if (
    normalizedPath !== normalizedRoot &&
    !normalizedPath.startsWith(`${normalizedRoot}${sep}`)
  ) {
    throw new Error("发布目标超出客户端技能目录");
  }
};

const renderPublishedAsset = (
  asset: PracticeAssetRecord,
  target: PracticePublicationTarget,
  version: number,
): string => {
  const serialized = serializePracticeAsset(asset, {
    includeSourceSnapshots: false,
  });
  const marker = "metadata:\n  decision:\n";
  if (!serialized.includes(marker)) {
    throw new Error("技能内容无法生成发布元数据");
  }
  return serialized.replace(
    marker,
    `${marker}    publication_target: ${target}\n    publication_version: ${version}\n`,
  );
};

const atomicWrite = async (path: string, content: string | Buffer): Promise<void> => {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, { mode: 0o600 });
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
};

const statusFor = (
  target: PracticePublicationTarget,
  state: PracticePublicationState,
  latest: PublicationVersion | null,
  message: string,
): PracticePublicationStatus => ({
  target,
  targetLabel: TARGET_LABELS[target],
  state,
  version: latest?.version ?? null,
  publishedAt: latest?.publishedAt ?? null,
  canPublish: state !== "up_to_date" && state !== "unsafe_target",
  canRollback:
    latest !== null &&
    (state === "up_to_date" || state === "update_available"),
  requiresOverwriteConfirmation:
    state === "occupied" || state === "target_modified",
  message,
});

export class PracticePublicationService {
  readonly #assets: PracticeAssetSource;
  readonly #stateRoot: string;
  readonly #targetRoots: Record<PracticePublicationTarget, string>;
  readonly #now: () => Date;
  readonly #validateBeforePublish: (
    asset: PracticeAssetRecord,
  ) => Promise<void>;
  #mutationTail: Promise<void> = Promise.resolve();

  constructor(options: PracticePublicationServiceOptions) {
    this.#assets = options.assets;
    this.#stateRoot = resolve(options.stateRoot);
    this.#targetRoots = {
      ...defaultTargetRoots(),
      ...options.targetRoots,
    };
    this.#now = options.now ?? (() => new Date());
    this.#validateBeforePublish =
      options.validateBeforePublish ?? (async () => undefined);
  }

  async listStatuses(assetId: string): Promise<PracticePublicationStatus[]> {
    return Promise.all(
      (["codex", "claude-code"] as const).map(async (target) =>
        (await this.#snapshot(assetId, target)).status,
      ),
    );
  }

  async publish(
    assetId: string,
    target: PracticePublicationTarget,
    options: { confirmOverwrite?: boolean } = {},
  ): Promise<PracticePublicationReceipt> {
    return this.#exclusive(() => this.#publish(assetId, target, options));
  }

  async #publish(
    assetId: string,
    target: PracticePublicationTarget,
    options: { confirmOverwrite?: boolean },
  ): Promise<PracticePublicationReceipt> {
    const snapshot = await this.#snapshot(assetId, target);
    if (snapshot.status.state === "up_to_date") {
      return {
        target,
        action: "unchanged",
        version: snapshot.latest?.version ?? null,
        publishedAt: snapshot.latest?.publishedAt ?? null,
        restoredPreviousContent: false,
      };
    }
    await this.#validateBeforePublish(snapshot.asset);
    if (!snapshot.status.canPublish) {
      throw new Error(snapshot.status.message);
    }
    if (
      snapshot.status.requiresOverwriteConfirmation &&
      options.confirmOverwrite !== true
    ) {
      throw new Error("目标已有内容，请确认覆盖；原内容会保存为可回滚版本");
    }

    const manifest = await this.#loadManifest();
    const key = historyKey(assetId, target);
    const existing = manifest.publications[key];
    const version = (existing?.versions.at(-1)?.version ?? 0) + 1;
    const publishedAt = this.#now().toISOString();
    const publishedContent = renderPublishedAsset(
      snapshot.asset,
      target,
      version,
    );
    const previousContent = snapshot.inspection.content;
    const backupPath = this.#backupPath(key, version);
    if (previousContent !== null) await atomicWrite(backupPath, previousContent);

    await this.#ensureTargetDirectory(snapshot.asset, target);
    try {
      await atomicWrite(snapshot.inspection.path, publishedContent);
    } catch (error) {
      await unlink(backupPath).catch(() => undefined);
      throw error;
    }

    const nextHistory: PublicationHistory = existing ?? {
      assetId,
      target,
      versions: [],
    };
    nextHistory.versions.push({
      version,
      publishedAt,
      sourceHash: snapshot.sourceHash,
      publishedHash: hash(publishedContent),
      previousExisted: previousContent !== null,
    });
    manifest.publications[key] = nextHistory;
    try {
      await this.#saveManifest(manifest);
    } catch (error) {
      if (previousContent === null) {
        await unlink(snapshot.inspection.path).catch(() => undefined);
      } else {
        await atomicWrite(snapshot.inspection.path, previousContent);
      }
      await unlink(backupPath).catch(() => undefined);
      throw error;
    }

    return {
      target,
      action: "published",
      version,
      publishedAt,
      restoredPreviousContent: false,
    };
  }

  async rollback(
    assetId: string,
    target: PracticePublicationTarget,
  ): Promise<PracticePublicationReceipt> {
    return this.#exclusive(() => this.#rollback(assetId, target));
  }

  async #rollback(
    assetId: string,
    target: PracticePublicationTarget,
  ): Promise<PracticePublicationReceipt> {
    const snapshot = await this.#snapshot(assetId, target);
    const latest = snapshot.latest;
    if (
      latest === null ||
      snapshot.inspection.content === null ||
      hash(snapshot.inspection.content) !== latest.publishedHash
    ) {
      throw new Error("当前目标已被修改或没有可回滚版本，为保护现有内容已停止回滚");
    }
    const manifest = await this.#loadManifest();
    const key = historyKey(assetId, target);
    const history = manifest.publications[key];
    const manifestLatest = history?.versions.at(-1);
    if (history === undefined || manifestLatest?.version !== latest.version) {
      throw new Error("发布历史已变化，请刷新后重试");
    }

    const publishedContent = snapshot.inspection.content;
    const backupPath = this.#backupPath(key, latest.version);
    const previousContent = latest.previousExisted
      ? await readFile(backupPath).catch((error: unknown) => {
          if (isMissing(error)) {
            throw new Error("回滚备份缺失，为保护当前内容已停止回滚");
          }
          throw error;
        })
      : null;

    if (previousContent === null) {
      await unlink(snapshot.inspection.path);
    } else {
      await atomicWrite(snapshot.inspection.path, previousContent);
    }
    history.versions.pop();
    if (history.versions.length === 0) delete manifest.publications[key];
    try {
      await this.#saveManifest(manifest);
    } catch (error) {
      await atomicWrite(snapshot.inspection.path, publishedContent);
      throw error;
    }

    await unlink(backupPath).catch(() => undefined);
    if (previousContent === null) {
      await rmdir(dirname(snapshot.inspection.path)).catch(() => undefined);
    }
    const nextLatest = history.versions.at(-1) ?? null;
    return {
      target,
      action: "rolled_back",
      version: nextLatest?.version ?? null,
      publishedAt: nextLatest?.publishedAt ?? null,
      restoredPreviousContent: previousContent !== null,
    };
  }

  async #snapshot(
    assetId: string,
    target: PracticePublicationTarget,
  ): Promise<PublicationSnapshot> {
    const asset = await this.#requireAcceptedAsset(assetId);
    const manifest = await this.#loadManifest();
    const history = manifest.publications[historyKey(assetId, target)] ?? null;
    const latest = history?.versions.at(-1) ?? null;
    const sourceHash = hash(
      serializePracticeAsset(asset, { includeSourceSnapshots: false }),
    );
    const inspection = await this.#inspectTarget(asset, target);
    let status: PracticePublicationStatus;

    if (inspection.state === "unsafe") {
      status = statusFor(
        target,
        "unsafe_target",
        latest,
        inspection.reason ?? "目标路径不安全，无法发布",
      );
    } else if (latest === null) {
      status =
        inspection.state === "file"
          ? statusFor(
              target,
              "occupied",
              null,
              "存在非 Decision 管理的同名技能，覆盖前需要确认",
            )
          : statusFor(target, "not_published", null, "尚未发布到此客户端");
    } else if (inspection.state === "missing") {
      status = statusFor(
        target,
        "missing_target",
        latest,
        "已发布文件不存在，可以重新发布",
      );
    } else if (hash(inspection.content ?? "") !== latest.publishedHash) {
      status = statusFor(
        target,
        "target_modified",
        latest,
        "客户端内容已被外部修改，覆盖前需要确认",
      );
    } else if (sourceHash === latest.sourceHash) {
      status = statusFor(target, "up_to_date", latest, "已是最新版本");
    } else {
      status = statusFor(
        target,
        "update_available",
        latest,
        "Obsidian 中的内容已有更新",
      );
    }
    return { asset, sourceHash, history, latest, inspection, status };
  }

  async #requireAcceptedAsset(assetId: string): Promise<PracticeAssetRecord> {
    const asset = await this.#assets.find(assetId);
    if (asset === null) throw new Error("技能或工作流不存在");
    if (asset.status !== "accepted" || asset.acceptedAt === null) {
      throw new Error("只有已采纳的技能或工作流可以发布");
    }
    assertSafeSlug(asset.slug);
    return asset;
  }

  async #inspectTarget(
    asset: PracticeAssetRecord,
    target: PracticePublicationTarget,
  ): Promise<TargetInspection> {
    const root = resolve(this.#targetRoots[target]);
    const directory = join(root, asset.slug);
    const path = join(directory, "SKILL.md");
    assertInside(root, path);
    for (const [candidate, label] of [
      [root, "客户端技能目录"],
      [directory, "同名技能目录"],
    ] as const) {
      try {
        const stats = await lstat(candidate);
        if (stats.isSymbolicLink() || !stats.isDirectory()) {
          return {
            state: "unsafe",
            path,
            content: null,
            reason: `${label}不是安全的普通目录`,
          };
        }
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
    }
    try {
      const stats = await lstat(path);
      if (stats.isSymbolicLink() || !stats.isFile()) {
        return {
          state: "unsafe",
          path,
          content: null,
          reason: "同名目标不是安全的普通文件",
        };
      }
      return { state: "file", path, content: await readFile(path), reason: null };
    } catch (error) {
      if (!isMissing(error)) throw error;
      return { state: "missing", path, content: null, reason: null };
    }
  }

  async #ensureTargetDirectory(
    asset: PracticeAssetRecord,
    target: PracticePublicationTarget,
  ): Promise<void> {
    const root = resolve(this.#targetRoots[target]);
    await mkdir(root, { recursive: true, mode: 0o700 });
    const rootStats = await lstat(root);
    if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
      throw new Error("客户端技能目录不是安全的普通目录");
    }
    const directory = join(root, asset.slug);
    await mkdir(directory, { mode: 0o700 }).catch((error: unknown) => {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) {
        throw error;
      }
    });
    const stats = await lstat(directory);
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new Error("同名技能目录不是安全的普通目录");
    }
  }

  async #loadManifest(): Promise<PublicationManifest> {
    const path = join(this.#stateRoot, "manifest.json");
    try {
      return parseManifest(JSON.parse(await readFile(path, "utf8")) as unknown);
    } catch (error) {
      if (isMissing(error)) return emptyManifest();
      if (error instanceof SyntaxError) {
        throw new Error("发布历史损坏，已停止写入以保护现有客户端内容");
      }
      throw error;
    }
  }

  async #saveManifest(manifest: PublicationManifest): Promise<void> {
    await atomicWrite(
      join(this.#stateRoot, "manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
  }

  #backupPath(key: string, version: number): string {
    const path = join(
      this.#stateRoot,
      "backups",
      backupStem(key),
      `v${version}.md`,
    );
    assertInside(this.#stateRoot, path);
    return path;
  }

  async #exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.#mutationTail;
    let release = (): void => undefined;
    this.#mutationTail = new Promise<void>((resolveMutation) => {
      release = resolveMutation;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}
