import { lstat, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";

// A manifest at the repository's root and the languages its code may be in. Generous where a manifest does not say
// which of a family: a language left out drops every preference kept for it, where one too many costs a line the
// agent weighs. A Groovy build or a Maven pom holds Kotlin as often as Java; CMake builds C as well as C++; and a
// package.json at the root of a TypeScript monorepo often names typescript only in its packages.
const MANIFESTS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ["go.mod", ["go"]],
  ["Cargo.toml", ["rust"]],
  ["pyproject.toml", ["python"]],
  ["requirements.txt", ["python"]],
  ["setup.py", ["python"]],
  ["pom.xml", ["java", "kotlin"]],
  ["build.gradle", ["java", "kotlin"]],
  ["build.gradle.kts", ["java", "kotlin"]],
  ["Gemfile", ["ruby"]],
  ["composer.json", ["php"]],
  ["Package.swift", ["swift"]],
  ["pubspec.yaml", ["dart"]],
  ["CMakeLists.txt", ["cpp", "c"]],
  ["package.json", ["javascript", "typescript"]],
];

// A manifest on a stalled network mount or one iCloud keeps in the cloud is not waited for past this: the
// consultation is not held up by the languages, which are then not known.
const DETECTION_TIMEOUT_MS = 1_000;

/** The nearest directory at or above this one holding `.git` (a checkout or a linked worktree), else this one. */
const repositoryRoot = async (directory: string): Promise<string> => {
  let at = directory;
  for (let depth = 0; depth < 32; depth += 1) {
    if (await lstat(join(at, ".git")).then(() => true, () => false)) return at;
    const parent = dirname(at);
    if (parent === at) break;
    at = parent;
  }
  return directory;
};

const detect = async (directory: string): Promise<string[]> => {
  const root = await repositoryRoot(directory);
  const names = new Set(await readdir(root));
  const found = new Set<string>();
  for (const [file, languages] of MANIFESTS) {
    if (names.has(file)) for (const language of languages) found.add(language);
  }
  if ([...names].some((name) => name.endsWith(".csproj") || name.endsWith(".sln"))) found.add("csharp");
  return [...found].slice(0, 8);
};

/**
 * The languages the repository this directory is in may be written in, by the manifests at its root (only their
 * names: none is read); none when they cannot be listed in time or there are none (not known: the App then recalls
 * every preference, as before languages were kept). ponytail: the root's manifests only — a monorepo's packages each
 * with their own are not looked into.
 */
export const repositoryLanguages = (directory: string, timeoutMs = DETECTION_TIMEOUT_MS): Promise<string[]> =>
  new Promise((resolve) => {
    const timer = setTimeout(() => resolve([]), timeoutMs);
    timer.unref?.();
    detect(directory).then(resolve, () => resolve([])).finally(() => clearTimeout(timer));
  });
