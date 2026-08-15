import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("Windows app icon", () => {
  it("is a multi-resolution ICO with a 256 pixel image", async () => {
    const icon = await readFile(
      new URL("../assets/app-icon.ico", import.meta.url),
    );

    expect([...icon.subarray(0, 4)]).toEqual([0, 0, 1, 0]);
    expect([...icon.subarray(0, 8)]).not.toEqual([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);
    const count = icon.readUInt16LE(4);
    expect(count).toBeGreaterThanOrEqual(6);
    const widths = Array.from({ length: count }, (_, index) =>
      icon.readUInt8(6 + index * 16),
    );
    expect(widths).toContain(0);
  });
});
