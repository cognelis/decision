import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const inside = (root, path) => { const rel = relative(root, path); return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`)); };

export const convertMarkers = (content, prefix) => {
  if (!/^[a-z][a-z0-9-]{0,63}$/u.test(prefix) || prefix === "decision") throw new Error("Provide a previous marker prefix");
  const previous = `<!-- ${prefix}:`;
  return content.replace(new RegExp(`(?<!\\\\)<!-- ${prefix}:`, "gu"), "<!-- decision:")
    .replaceAll(`\\${previous}`, previous);
};

export const planMarkerMigration = async (vaultPath, prefix) => {
  convertMarkers("", prefix);
  const root = await realpath(vaultPath);
  const changes = [];
  let bytes = 0;
  const visit = async (directory) => {
    if ((await lstat(directory)).isSymbolicLink() || !inside(root, await realpath(directory))) throw new Error("Unsafe migration directory");
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error("Migration does not follow symlinks");
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && entry.name.endsWith(".md")) {
        const stat = await lstat(path);
        if (stat.size > 5 * 1024 * 1024 || (bytes += stat.size) > 64 * 1024 * 1024) throw new Error("Migration size limit exceeded");
        const original = await readFile(path);
        const content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(original);
        const converted = Buffer.from(convertMarkers(content, prefix));
        if (!original.equals(converted)) changes.push({ path, relativePath: relative(root, path), original, converted, mode: stat.mode & 0o777 });
      }
    }
  };
  for (const folder of ["decisions", "principles", "principle-relations"]) {
    const directory = join(root, "Decision Journal", folder);
    try { await lstat(directory); }
    catch (error) { if (error.code === "ENOENT") continue; throw error; }
    const journal = await lstat(join(root, "Decision Journal"));
    if (journal.isSymbolicLink()) throw new Error("Unsafe journal directory");
    await visit(directory);
  }
  return { root, changes };
};

export const applyMarkerMigration = async (plan, backupRoot) => {
  if (inside(plan.root, resolve(backupRoot))) throw new Error("Backup must be outside the Vault");
  await mkdir(backupRoot, { recursive: true, mode: 0o700 });
  const backupParent = await realpath(backupRoot);
  if (inside(plan.root, backupParent)) throw new Error("Backup must be outside the Vault");
  // Validate every source before creating the backup or replacing any file.
  for (const change of plan.changes) {
    if ((await lstat(change.path)).isSymbolicLink() || !inside(plan.root, await realpath(change.path)) || !(await readFile(change.path)).equals(change.original)) throw new Error("Source changed since preview");
  }
  const backup = await mkdtemp(join(backupParent, "decision-format-"));
  const manifest = [];
  for (const [index, change] of plan.changes.entries()) {
    await writeFile(join(backup, `${index}.backup`), change.original, { flag: "wx", mode: 0o600 });
    manifest.push({ path: change.relativePath, backup: `${index}.backup`, before: hash(change.original), after: hash(change.converted) });
  }
  await writeFile(join(backup, "manifest.json"), JSON.stringify(manifest, null, 2), { flag: "wx", mode: 0o600 });
  let migrated = 0;
  for (const change of plan.changes) {
    if (!(await readFile(change.path)).equals(change.original)) throw new Error(`Source changed; ${migrated} completed files are backed up at ${backup}`);
    const staging = await mkdtemp(join(dirname(change.path), ".decision-format-"));
    const temporary = join(staging, "note");
    try {
      await writeFile(temporary, change.converted, { flag: "wx", mode: change.mode });
      if ((await lstat(change.path)).isSymbolicLink() || !inside(plan.root, await realpath(change.path)) || !(await readFile(change.path)).equals(change.original)) throw new Error("Source changed while writing");
      await rename(temporary, change.path);
      migrated += 1;
    } finally {
      await unlink(temporary).catch(() => undefined);
      await import("node:fs/promises").then(({ rmdir }) => rmdir(staging));
    }
  }
  return { migrated, backup };
};

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const args = process.argv.slice(2);
  const value = (flag) => { const index = args.indexOf(flag); return index < 0 ? undefined : args[index + 1]; };
  try {
    const vault = value("--vault");
    const prefix = value("--prefix");
    if (!vault || !prefix) throw new Error("Usage: node scripts/migrate-markdown-markers.mjs --vault PATH --prefix PREFIX [--apply --backup OUTSIDE_VAULT_DIRECTORY]");
    const plan = await planMarkerMigration(resolve(vault), prefix);
    if (args.includes("--apply")) {
      const backup = value("--backup");
      if (!backup) throw new Error("--apply requires --backup outside the Vault");
      process.stdout.write(`${JSON.stringify(await applyMarkerMigration(plan, resolve(backup)))}\n`);
    } else process.stdout.write(`${JSON.stringify({ mode: "preview", files: plan.changes.length })}\n`);
  } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
