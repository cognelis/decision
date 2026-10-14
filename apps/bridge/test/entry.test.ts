import { mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";

import { startedAsProgram } from "../src/cli.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it("knows it was started as the program when the path it was given goes through a link to it", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "decision-bridge-entry-")));
  roots.push(root);
  const installed = join(root, "installed");
  await symlink(root, installed, "dir");
  const bridge = join(root, "decision-bridge.mjs");
  await writeFile(bridge, "");
  // Node runs the module from its real path: AppData moved with mklink /J, the hooks named the junction's,
  // and compared as given every hook exited having done nothing.
  const moduleUrl = pathToFileURL(bridge).href;

  expect(startedAsProgram(moduleUrl, join(installed, "decision-bridge.mjs"))).toBe(true);
  expect(startedAsProgram(moduleUrl, bridge)).toBe(true);
  expect(startedAsProgram(moduleUrl, join(root, "other.mjs"))).toBe(false);
  expect(startedAsProgram(moduleUrl, undefined)).toBe(false);
});
