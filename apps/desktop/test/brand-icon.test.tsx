import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const asset = (name: string) =>
  readFile(join(process.cwd(), "apps/desktop/assets", name), "utf8");

describe("app icon source", () => {
  it("uses a full unoutlined canvas so macOS can apply its own mask", async () => {
    const source = await asset("paraself-mark.svg");

    expect(source).toContain(
      '<rect data-app-background="true" width="1024" height="1024"',
    );
    expect(source).not.toMatch(/data-app-background="true"[^>]+stroke=/u);
    expect(source).not.toMatch(/\brx=/u);
    expect(source).not.toContain("feDropShadow");
    expect(source.match(/<g transform="rotate\(/gu)).toHaveLength(5);
  });

  it("builds the menu bar template from its own monochrome source", async () => {
    const [tray, buildScript] = await Promise.all([
      asset("paraself-tray.svg"),
      readFile(join(process.cwd(), "scripts/build-icons.sh"), "utf8"),
    ]);

    expect(new Set(tray.match(/#[0-9A-Fa-f]{6}/gu))).toEqual(new Set(["#000000"]));
    expect(tray.match(/<path /gu)).toHaveLength(5);
    expect(buildScript).toContain('tray_svg="$project_root/apps/desktop/assets/paraself-tray.svg"');
  });
});
