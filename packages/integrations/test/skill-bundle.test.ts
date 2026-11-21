import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { LEGACY_SKILL, SKILL_FINGERPRINTS, bundledSkillFingerprints } from "../src/index.js";

const SOURCE = fileURLToPath(new URL("../../../skills", import.meta.url));

describe("the bundled skills", () => {
  it("are each a version listed in the fingerprints, or an install would take the next release's copy for the reader's", async () => {
    const bundle = await bundledSkillFingerprints(SOURCE);
    expect(Object.keys(bundle).sort()).toEqual(["paraself-memory", "paraself-review"]);
    for (const [name, files] of Object.entries(bundle)) {
      // On failure: append this to SKILL_FINGERPRINTS[name] in skill-fingerprints.ts.
      expect(SKILL_FINGERPRINTS[name], `${name}: ${JSON.stringify(files)}`).toContainEqual(files);
    }
    // The old name is no longer shipped, and every copy of it that was is still recognized.
    expect(bundle[LEGACY_SKILL.from]).toBeUndefined();
    expect(SKILL_FINGERPRINTS[LEGACY_SKILL.from]).toHaveLength(8);
  });

  it("are packaged as the app's Resources/skills", async () => {
    expect(await readFile(fileURLToPath(new URL("../../../forge.config.ts", import.meta.url)), "utf8")).toMatch(/extraResource: \[[^\]]*"skills"/u);
  });
});
