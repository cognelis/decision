import { createReadStream } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { StringDecoder } from "node:string_decoder";

import { extractFile, listPackage, statFile } from "@electron/asar";
import {
  findForbiddenReleasePath,
  findSensitiveReleaseText,
} from "./release-security-rules.mjs";

export {
  findForbiddenReleasePath,
  findSensitiveReleaseText,
} from "./release-security-rules.mjs";

const looksTextual = (buffer) => {
  const sample = buffer.subarray(0, Math.min(buffer.length, 8 * 1024));
  return !sample.includes(0);
};

const assertSafeText = (text, displayPath) => {
  const sensitive = findSensitiveReleaseText(text);
  if (sensitive !== undefined) {
    throw new Error(
      `Sensitive ${sensitive} found in release payload: ${displayPath}`,
    );
  }
};

const scanTextFile = async (path, displayPath) => {
  const handle = await open(path, "r");
  const sample = Buffer.alloc(8 * 1024);
  let bytesRead;
  try {
    ({ bytesRead } = await handle.read(sample, 0, sample.length, 0));
  } finally {
    await handle.close();
  }
  if (!looksTextual(sample.subarray(0, bytesRead))) {
    return false;
  }

  const decoder = new StringDecoder("utf8");
  let overlap = "";
  for await (const chunk of createReadStream(path)) {
    const text = overlap + decoder.write(chunk);
    assertSafeText(text, displayPath);
    overlap = text.slice(-512);
  }
  assertSafeText(overlap + decoder.end(), displayPath);
  return true;
};

export const normalizeAsarEntry = (entry) =>
  String(entry).replaceAll("\\", "/").replace(/^\/+/u, "");

export const toAsarLookupPath = (entry, separator = sep) =>
  normalizeAsarEntry(entry).replaceAll("/", separator);

const scanAsar = (path) => {
  const entries = listPackage(path);
  const forbidden = findForbiddenReleasePath(entries);
  if (forbidden !== undefined) {
    throw new Error(`Forbidden release payload path: app.asar:${forbidden}`);
  }

  let textFilesScanned = 0;
  for (const entry of entries) {
    const displayPath = normalizeAsarEntry(entry);
    const lookupPath = toAsarLookupPath(entry);
    const info = statFile(path, lookupPath);
    if (info.files !== undefined) {
      continue;
    }
    const buffer = extractFile(path, lookupPath);
    if (!looksTextual(buffer)) {
      continue;
    }
    textFilesScanned += 1;
    assertSafeText(buffer.toString("utf8"), `app.asar:${displayPath}`);
  }
  return { filesScanned: entries.length, textFilesScanned };
};

export const scanReleasePayload = async (root) => {
  const files = [];
  const visit = async (directory) => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(path);
      } else if (entry.isFile()) {
        files.push(path);
      } else if (entry.isSymbolicLink()) {
        continue;
      }
    }
  };
  await visit(root);

  const relativePaths = files.map((path) => relative(root, path));
  const forbidden = findForbiddenReleasePath(relativePaths);
  if (forbidden !== undefined) {
    throw new Error(`Forbidden release payload path: ${forbidden}`);
  }

  let textFilesScanned = 0;
  let asarFilesScanned = 0;
  for (let index = 0; index < files.length; index += 1) {
    const file = files[index];
    if (file.toLowerCase().endsWith(".asar")) {
      const asar = scanAsar(file);
      asarFilesScanned += asar.filesScanned;
      textFilesScanned += asar.textFilesScanned;
      continue;
    }
    if (await scanTextFile(file, relativePaths[index])) {
      textFilesScanned += 1;
    }
  }

  return {
    filesScanned: files.length + asarFilesScanned,
    textFilesScanned,
  };
};
