import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { selectWinstallerSevenZip } from "../setup-build-runtime.mjs";

const temporaryDirectories: string[] = [];

const temporaryVendor = (): string => {
  const directory = mkdtempSync(join(tmpdir(), "decision-winstaller-"));
  temporaryDirectories.push(directory);
  return directory;
};

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("build runtime setup", () => {
  it.each(["x64", "arm64"])(
    "selects the pinned electron-winstaller 7-Zip payload for %s",
    async (architecture) => {
      const vendorDirectory = temporaryVendor();
      const executable = Buffer.from(`${architecture}-executable`);
      const library = Buffer.from(`${architecture}-library`);
      writeFileSync(join(vendorDirectory, `7z-${architecture}.exe`), executable);
      writeFileSync(join(vendorDirectory, `7z-${architecture}.dll`), library);

      await selectWinstallerSevenZip({ architecture, vendorDirectory });

      expect(readFileSync(join(vendorDirectory, "7z.exe"))).toEqual(
        executable,
      );
      expect(readFileSync(join(vendorDirectory, "7z.dll"))).toEqual(library);
    },
  );

  it("rejects a host architecture without a pinned 7-Zip payload", async () => {
    await expect(
      selectWinstallerSevenZip({
        architecture: "ia32",
        vendorDirectory: temporaryVendor(),
      }),
    ).rejects.toThrow("Unsupported electron-winstaller host architecture: ia32");
  });
});
