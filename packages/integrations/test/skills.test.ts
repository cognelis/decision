import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

// What another program does to a skill folder just as it is moved aside: run once, before that rename.
const meanwhile = vi.hoisted(() => ({ before: undefined as ((from: string) => Promise<void>) | undefined }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rename: async (from: string, to: string) => {
      const hook = meanwhile.before;
      if (hook !== undefined && to.includes(".paraself-old-")) {
        meanwhile.before = undefined;
        await hook(from);
      }
      return actual.rename(from, to);
    },
  };
});

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const OLD_REVIEW = "---\nname: paraself-review\ndescription: an older release\n---\nold\n";
const LEGACY = "---\nname: decision-context\ndescription: shipped copy\n---\nold\n";

// A release before this one of paraself-review, and a shipped decision-context: written by Paraself, so to be replaced.
vi.mock("../src/skill-fingerprints.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/skill-fingerprints.js")>();
  return {
    ...actual,
    SKILL_FINGERPRINTS: {
      ...actual.SKILL_FINGERPRINTS,
      "paraself-review": [{ "SKILL.md": sha(OLD_REVIEW) }, ...actual.SKILL_FINGERPRINTS["paraself-review"]!],
      "decision-context": [{ "SKILL.md": sha(LEGACY) }, ...actual.SKILL_FINGERPRINTS["decision-context"]!],
    },
  };
});

const { clientsBehindOnSkills, installIntegrations, syncBundledSkills } = await import("../src/index.js");

const SOURCE = fileURLToPath(new URL("../../../skills", import.meta.url));

/** Every entry under a folder, with each file's content and mtime: what a run that writes nothing leaves as it was. */
const tree = async (root: string): Promise<Record<string, string>> => {
  const found: Record<string, string> = {};
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const key = relative(root, path);
      if (entry.isDirectory()) {
        found[key] = "dir";
        await walk(path);
      } else if (entry.isSymbolicLink()) found[key] = "link";
      else found[key] = `${sha(await readFile(path, "utf8"))}@${(await stat(path)).mtimeMs}`;
    }
  };
  await walk(root).catch(() => undefined);
  return found;
};

const home = () => mkdtemp(join(tmpdir(), "paraself-skills-"));
const sync = (root: string, mode: "dry-run" | "apply" = "apply", environment: NodeJS.ProcessEnv = {}) =>
  syncBundledSkills({ source: SOURCE, clients: ["codex", "claude-code"], mode, environment, home: root });
const statuses = (reports: Awaited<ReturnType<typeof sync>>) => reports.map(({ client, skill, status }) => `${client}:${skill}:${status}`);

describe("syncBundledSkills", () => {
  it("installs both skills where Codex and Claude Code read them, then leaves them alone", async () => {
    const root = await home();
    expect(statuses(await sync(root))).toEqual([
      "codex:paraself-memory:installed",
      "codex:paraself-review:installed",
      "claude-code:paraself-memory:installed",
      "claude-code:paraself-review:installed",
    ]);
    for (const folder of [join(root, ".agents", "skills"), join(root, ".claude", "skills")]) {
      expect(await readFile(join(folder, "paraself-memory", "references", "recording.md"), "utf8")).toBe(await readFile(join(SOURCE, "paraself-memory", "references", "recording.md"), "utf8"));
      expect(await readFile(join(folder, "paraself-review", "SKILL.md"), "utf8")).toContain("name: paraself-review");
      // Nothing of the swap left behind.
      expect((await readdir(folder)).sort()).toEqual(["paraself-memory", "paraself-review"]);
    }
    const before = await tree(root);
    expect(statuses(await sync(root)).every((line) => line.endsWith(":unchanged"))).toBe(true);
    expect(await tree(root)).toEqual(before);
  });

  it("follows CLAUDE_CONFIG_DIR for Claude Code, and never writes in a dry run", async () => {
    const root = await home();
    const claude = join(root, "elsewhere");
    const before = await tree(root);
    expect(statuses(await sync(root, "dry-run", { CLAUDE_CONFIG_DIR: claude }))).toContain("claude-code:paraself-memory:installed");
    expect(await tree(root)).toEqual(before);
    await sync(root, "apply", { CLAUDE_CONFIG_DIR: claude });
    expect((await lstat(join(claude, "skills", "paraself-review", "SKILL.md"))).isFile()).toBe(true);
    await expect(lstat(join(root, ".claude"))).rejects.toThrow();
  });

  it("replaces an earlier Paraself release, and keeps what the reader changed or another tool put there", async () => {
    const root = await home();
    const codex = join(root, ".agents", "skills");
    const claude = join(root, ".claude", "skills");
    await mkdir(join(codex, "paraself-review"), { recursive: true });
    await writeFile(join(codex, "paraself-review", "SKILL.md"), OLD_REVIEW);
    // Changed by one byte from the old release: the reader's now.
    await mkdir(join(claude, "paraself-review"), { recursive: true });
    await writeFile(join(claude, "paraself-review", "SKILL.md"), `${OLD_REVIEW} `);
    // The old release with a file of the reader's beside it.
    await mkdir(join(claude, "paraself-memory"), { recursive: true });
    await writeFile(join(claude, "paraself-memory", "SKILL.md"), await readFile(join(SOURCE, "paraself-memory", "SKILL.md")));
    await writeFile(join(claude, "paraself-memory", "mine.md"), "mine");
    const dryRun = await tree(root);
    expect(statuses(await sync(root, "dry-run"))).toEqual(statuses(await sync(root, "dry-run")));
    expect(await tree(root)).toEqual(dryRun);

    const reports = await sync(root);
    expect(statuses(reports)).toEqual([
      "codex:paraself-memory:installed",
      "codex:paraself-review:updated",
      "claude-code:paraself-memory:kept",
      "claude-code:paraself-review:kept",
    ]);
    expect(await readFile(join(codex, "paraself-review", "SKILL.md"), "utf8")).toBe(await readFile(join(SOURCE, "paraself-review", "SKILL.md"), "utf8"));
    expect(await readFile(join(claude, "paraself-review", "SKILL.md"), "utf8")).toBe(`${OLD_REVIEW} `);
    expect(await readFile(join(claude, "paraself-memory", "mine.md"), "utf8")).toBe("mine");
    expect(reports.find((report) => report.client === "claude-code" && report.skill === "paraself-review")?.detail).toMatch(/不同.*没有改动/u);
    expect((await readdir(codex)).sort()).toEqual(["paraself-memory", "paraself-review"]);
  });

  it("does not follow a link where a skill would go, nor write through it", async () => {
    const root = await home();
    const outside = await home();
    await mkdir(join(root, ".agents", "skills"), { recursive: true });
    await symlink(outside, join(root, ".agents", "skills", "paraself-memory"));
    await mkdir(join(root, ".claude", "skills", "paraself-review"), { recursive: true });
    await writeFile(join(outside, "SKILL.md"), OLD_REVIEW);
    await symlink(join(outside, "SKILL.md"), join(root, ".claude", "skills", "paraself-review", "SKILL.md"));

    const reports = await sync(root);

    expect(statuses(reports)).toContain("codex:paraself-memory:kept");
    expect(statuses(reports)).toContain("claude-code:paraself-review:kept");
    expect(await readdir(outside)).toEqual(["SKILL.md"]);
    expect(await readFile(join(outside, "SKILL.md"), "utf8")).toBe(OLD_REVIEW);
  });

  it("follows the reader's own link for the skills folder itself, writing where it leads", async () => {
    const root = await home();
    const dotfiles = await home();
    await mkdir(join(root, ".agents"), { recursive: true });
    await symlink(dotfiles, join(root, ".agents", "skills"));
    await syncBundledSkills({ source: SOURCE, clients: ["codex"], mode: "apply", environment: {}, home: root });
    expect((await readdir(dotfiles)).sort()).toEqual(["paraself-memory", "paraself-review"]);
    expect((await lstat(join(root, ".agents", "skills"))).isSymbolicLink()).toBe(true);
  });

  it("fails only the client whose skills folder cannot be resolved, and still syncs the next, in a dry run too", async () => {
    const root = await home();
    // Codex's folder a link to itself (ELOOP); Claude Code's with an earlier release and a skill the reader changed.
    await mkdir(join(root, ".agents"), { recursive: true });
    await symlink("skills", join(root, ".agents", "skills"));
    await mkdir(join(root, ".claude", "skills", "paraself-review"), { recursive: true });
    await writeFile(join(root, ".claude", "skills", "paraself-review", "SKILL.md"), OLD_REVIEW);
    await mkdir(join(root, ".claude", "skills", "paraself-memory"), { recursive: true });
    await writeFile(join(root, ".claude", "skills", "paraself-memory", "SKILL.md"), "the reader's own\n");
    const expected = [
      "codex:paraself-memory:failed",
      "codex:paraself-review:failed",
      "claude-code:paraself-memory:kept",
      "claude-code:paraself-review:updated",
    ];

    const before = await tree(root);
    expect(statuses(await sync(root, "dry-run"))).toEqual(expected);
    expect(await tree(root)).toEqual(before);

    // Thrown, the app's sync at start left Claude Code without its skills too.
    const reports = await sync(root);
    expect(statuses(reports)).toEqual(expected);
    expect(reports[0]!.detail).toMatch(/ELOOP|symbolic links/u);
    expect(await readFile(join(root, ".claude", "skills", "paraself-review", "SKILL.md"), "utf8")).not.toBe(OLD_REVIEW);
    expect(await readFile(join(root, ".claude", "skills", "paraself-memory", "SKILL.md"), "utf8")).toBe("the reader's own\n");
  });

  it("takes away a decision-context Paraself shipped, wherever Codex kept it, once paraself-memory is in", async () => {
    const root = await home();
    const places = [join(root, ".agents", "skills", "decision-context"), join(root, ".codex", "skills", "decision-context"), join(root, ".claude", "skills", "decision-context")];
    for (const place of places) {
      await mkdir(place, { recursive: true });
      await writeFile(join(place, "SKILL.md"), LEGACY);
    }
    const dryRun = await tree(root);
    expect(statuses(await sync(root, "dry-run")).filter((line) => line.includes("decision-context"))).toEqual([
      "codex:decision-context:migrated", "codex:decision-context:migrated", "claude-code:decision-context:migrated",
    ]);
    expect(await tree(root)).toEqual(dryRun);

    await sync(root);

    for (const place of places) await expect(lstat(place)).rejects.toThrow();
    // Only the folder it was in goes, nothing beside it.
    expect(await readdir(join(root, ".codex", "skills"))).toEqual([]);
  });

  it("leaves a decision-context it cannot tell is Paraself's, and one whose successor could not go in", async () => {
    const root = await home();
    const changed = join(root, ".codex", "skills", "decision-context");
    await mkdir(changed, { recursive: true });
    await writeFile(join(changed, "SKILL.md"), `${LEGACY}my notes\n`);
    // Shipped, but the reader has a paraself-memory of their own: the old one stays rather than leave neither.
    const claude = join(root, ".claude", "skills");
    await mkdir(join(claude, "decision-context"), { recursive: true });
    await writeFile(join(claude, "decision-context", "SKILL.md"), LEGACY);
    await mkdir(join(claude, "paraself-memory"), { recursive: true });
    await writeFile(join(claude, "paraself-memory", "SKILL.md"), "mine");

    const reports = await sync(root);

    const legacy = reports.filter((report) => report.skill === "decision-context");
    expect(legacy.map(({ client, status }) => `${client}:${status}`)).toEqual(["codex:legacy-kept", "claude-code:legacy-kept"]);
    expect(legacy[0]!.detail).toMatch(/核对不出.*保留未动/u);
    expect(legacy[0]!.path).toBe("~/.codex/skills/decision-context");
    expect(legacy[1]!.detail).toMatch(/paraself-memory 没有装上/u);
    expect(await readFile(join(changed, "SKILL.md"), "utf8")).toBe(`${LEGACY}my notes\n`);
    expect(await readFile(join(claude, "decision-context", "SKILL.md"), "utf8")).toBe(LEGACY);
  });
});

describe("a client left without this version's skills", () => {
  it("is said, for a skill Finder only browsed (.DS_Store) as for one the reader edited, and not for one up to date", async () => {
    const root = await home();
    await sync(root);
    // Browsed in Finder after it was installed: the next version is not written over it, and that is shown.
    await writeFile(join(root, ".claude", "skills", "paraself-review", ".DS_Store"), "finder");
    const reports = await sync(root);
    expect(statuses(reports)).toContain("claude-code:paraself-review:kept");
    expect([...clientsBehindOnSkills(reports)]).toEqual(["claude-code"]);
    expect(await readFile(join(root, ".claude", "skills", "paraself-review", ".DS_Store"), "utf8")).toBe("finder");
    expect(clientsBehindOnSkills(reports.filter((report) => report.client === "codex")).size).toBe(0);
  });
});

describe("a skill folder changed while it is being replaced", () => {
  it("keeps what was written to it after it was checked, and installs nothing over it", async () => {
    const root = await home();
    const folder = join(root, ".agents", "skills", "paraself-review");
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, "SKILL.md"), OLD_REVIEW);
    meanwhile.before = async (from) => writeFile(join(from, "SKILL.md"), `${OLD_REVIEW}edited just now\n`);

    const reports = await syncBundledSkills({ source: SOURCE, clients: ["codex"], mode: "apply", environment: {}, home: root });

    expect(reports.find((report) => report.skill === "paraself-review")).toMatchObject({ status: "kept", detail: expect.stringMatching(/内容原样保留/u) });
    expect(await readFile(join(folder, "SKILL.md"), "utf8")).toBe(`${OLD_REVIEW}edited just now\n`);
    // Nothing left aside: neither the new copy nor the checked one.
    expect((await readdir(join(root, ".agents", "skills"))).sort()).toEqual(["paraself-memory", "paraself-review"]);
  });

  it("keeps an old decision-context whose file changed as it was being taken away", async () => {
    const root = await home();
    const folder = join(root, ".claude", "skills", "decision-context");
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, "SKILL.md"), LEGACY);
    meanwhile.before = async (from) => {
      if (from === folder) await writeFile(join(from, "notes.md"), "mine");
    };
    // The successor goes in first; its own folder is new, so the first move aside is the legacy one.
    const reports = await syncBundledSkills({ source: SOURCE, clients: ["claude-code"], mode: "apply", environment: {}, home: root });

    expect(reports.find((report) => report.skill === "decision-context")).toMatchObject({ status: "legacy-kept", detail: expect.stringMatching(/内容原样保留/u) });
    expect(await readFile(join(folder, "SKILL.md"), "utf8")).toBe(LEGACY);
    expect(await readFile(join(folder, "notes.md"), "utf8")).toBe("mine");
  });
});

describe("installIntegrations with bundled skills", () => {
  const bridgePath = "/Applications/Paraself.app/Contents/Resources/bridge/paraself-bridge";
  const setup = async () => {
    const root = await home();
    await mkdir(join(root, ".claude"), { recursive: true });
    await mkdir(join(root, ".codex"), { recursive: true });
    return { root, claudeSettingsPath: join(root, ".claude", "settings.json"), codexHooksPath: join(root, ".codex", "hooks.json") };
  };

  it("gives skills only to a client it connected, says what it did in that client's line, and changes nothing in a dry run", async () => {
    const paths = await setup();
    const base = { bridgePath, claudeSettingsPath: paths.claudeSettingsPath, codexHooksPath: paths.codexHooksPath, home: paths.root, environment: {}, skillsSource: SOURCE };
    const before = await tree(paths.root);
    const dry = await installIntegrations({ ...base, mode: "dry-run" });
    expect(await tree(paths.root)).toEqual(before);
    expect(dry.skills?.filter((skill) => skill.status === "installed")).toHaveLength(4);
    expect(dry.targets.every((target) => target.changed && /技能 paraself-memory 将安装/u.test(target.detail ?? ""))).toBe(true);

    const report = await installIntegrations({
      ...base,
      mode: "apply",
      runner: async (command) => {
        if (command === "codex") throw Object.assign(new Error("spawn codex ENOENT"), { code: "ENOENT" });
        return { exitCode: 0 };
      },
    });

    expect(report.targets.map(({ client, status }) => `${client}:${status}`)).toEqual(["claude-code:installed", "codex:skipped"]);
    expect(report.skills?.map(({ client, skill, status }) => `${client}:${skill}:${status}`)).toEqual([
      "claude-code:paraself-memory:installed",
      "claude-code:paraself-review:installed",
    ]);
    expect(report.targets[0]!.detail).toMatch(/技能 paraself-memory 已安装/u);
    await expect(lstat(join(paths.root, ".agents"))).rejects.toThrow();

    const again = await installIntegrations({ ...base, mode: "apply", runner: async () => ({ exitCode: 0 }) });
    expect(again.targets.find((target) => target.client === "claude-code")?.detail ?? "").not.toMatch(/技能/u);
  });

  it("leaves skills alone when not given the bundle, as before", async () => {
    const paths = await setup();
    const report = await installIntegrations({ mode: "apply", bridgePath, claudeSettingsPath: paths.claudeSettingsPath, codexHooksPath: paths.codexHooksPath, home: paths.root, runner: async () => ({ exitCode: 0 }) });
    expect(report.skills).toBeUndefined();
    await expect(lstat(join(paths.root, ".claude", "skills"))).rejects.toThrow();
  });

  it("reports a bundle it cannot read as a failed skill, the client still connected", async () => {
    const paths = await setup();
    const report = await installIntegrations({ mode: "apply", bridgePath, claudeSettingsPath: paths.claudeSettingsPath, codexHooksPath: paths.codexHooksPath, home: paths.root, environment: {}, skillsSource: join(paths.root, "missing"), runner: async () => ({ exitCode: 0 }) });
    expect(report.targets.every((target) => target.status === "installed")).toBe(true);
    expect(report.skills?.every((skill) => skill.status === "failed")).toBe(true);
    expect(report.targets[0]!.detail).toMatch(/没有写入/u);
  });
});
