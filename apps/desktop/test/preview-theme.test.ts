import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("preview theme", () => {
  it("can force dark colors even when the host system is light", async () => {
    const css = await readFile(
      new URL("../src/renderer/styles.css", import.meta.url),
      "utf8",
    );

    expect(css).toContain('html[data-preview-theme="dark"]');
  });
});
