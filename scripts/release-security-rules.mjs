import { basename } from "node:path";

const FORBIDDEN_BASENAMES = new Set([
  ".netrc",
  ".npmrc",
  ".pypirc",
  "credentials.json",
  "credentials.yaml",
  "credentials.yml",
  "id_ed25519",
  "id_rsa",
  "secret.txt",
  "secrets.json",
  "secrets.yaml",
  "secrets.yml",
]);

const FORBIDDEN_EXTENSIONS = new Set([
  ".blockmap",
  ".db",
  ".gguf",
  ".key",
  ".keychain",
  ".keychain-db",
  ".map",
  ".nupkg",
  ".p8",
  ".p12",
  ".pem",
  ".pfx",
  ".sqlite",
  ".sqlite3",
]);

const UPDATE_METADATA = new Set([
  "app-update.yaml",
  "app-update.yml",
  "dev-app-update.yaml",
  "dev-app-update.yml",
  "latest-mac.yaml",
  "latest-mac.yml",
  "latest.json",
  "latest.yaml",
  "latest.yml",
  "releases",
  "releases.json",
]);

const extensionOf = (file) => {
  const dot = file.lastIndexOf(".");
  return dot < 0 ? "" : file.slice(dot);
};

export const findForbiddenReleasePath = (paths) =>
  paths.find((path) => {
    const normalized = String(path).replaceAll("\\", "/").toLowerCase();
    const components = normalized.split("/").filter(Boolean);
    const file = basename(normalized);
    return (
      file === ".env" ||
      file.startsWith(".env.") ||
      FORBIDDEN_BASENAMES.has(file) ||
      FORBIDDEN_EXTENSIONS.has(extensionOf(file)) ||
      UPDATE_METADATA.has(file) ||
      components.some(
        (component) => component === "fixture" || component === "fixtures",
      ) ||
      normalized.includes("duckdb")
    );
  });

const SENSITIVE_TEXT = Object.freeze([
  {
    label: "private key",
    pattern: /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/u,
  },
  { label: "AWS access key", pattern: /AKIA[0-9A-Z]{16}/u },
  {
    label: "GitHub token",
    pattern:
      /(?:gh(?:p|o|u|s|r)_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})/u,
  },
  {
    label: "service token",
    pattern:
      /(?:xox(?:b|a|p|r|s)-[A-Za-z0-9-]{10,}|sk_(?:live|test)_[A-Za-z0-9]{16,}|sk-(?:proj-)?[A-Za-z0-9_-]{20,}|sk-ant-[A-Za-z0-9_-]{20,}|npm_[A-Za-z0-9]{36,}|glpat-[A-Za-z0-9_-]{20,})/u,
  },
  {
    label: "password URL",
    pattern: /https?:\/\/[^/:\s]+:[^/@\s]+@/u,
  },
  {
    label: "user-home path",
    pattern:
      /(?:\/(?:Users|home)\/[^/\s"']+|[A-Za-z]:\\Users\\[^\\\s"']+)/u,
  },
]);

export const findSensitiveReleaseText = (text) =>
  SENSITIVE_TEXT.find(({ pattern }) => pattern.test(text))?.label;
