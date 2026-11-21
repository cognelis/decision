import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { runElectronCheck } from "./support/run-electron-check.js";
const require = createRequire(import.meta.url);
describe.skipIf(process.platform !== "darwin")("local review layout", () => {
  it.each([["light", "1440x900"], ["dark", "1440x900"], ["light", "1160x760"], ["dark", "1160x760"], ["light", "860x620"], ["dark", "860x620"]])("shows inline editing, split widgets, tasks and bound risk authorization in %s at %s", async (theme, size) => {
    const output = await runElectronCheck(require("electron") as string, [new URL("../../../scripts/check-local-review-layout.cjs", import.meta.url).pathname, theme!, size!], { cwd: new URL("../../../", import.meta.url).pathname, timeout: 90_000, maxBuffer: 1024 * 1024 });
    const report = JSON.parse(output.stdout).sizes[size!]!["local-review"];
    expect(report.documentOverflowX).toBe(0); expect(report.stageOverflowX).toBe(0);
    expect(report.clipped).toEqual([]); expect(report.cutOff).toEqual([]);
  });
});
