import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

import { PROMPT_EXAMPLES } from "../src/shared/prompt-examples.js";
import { runElectronCheck } from "./support/run-electron-check.js";

const require = createRequire(import.meta.url);
const titles = PROMPT_EXAMPLES.map((example) => example.title);

interface PageState { dialogTitle: string | null; dialogButtons: string[]; titleValue: string | null; listTitles: string[] }
interface Steps { askedToDiscard: PageState; keptEditing: PageState; afterDiscard: PageState }

describe.skipIf(process.platform !== "darwin")("提示词 editor in Chromium", () => {
  it("keeps editing on 继续编辑 and never saves, creating or editing", async () => {
    const { stdout } = await runElectronCheck(require("electron") as string, [new URL("../../../scripts/check-prompt-editor.cjs", import.meta.url).pathname], {
      cwd: new URL("../../../", import.meta.url).pathname, timeout: 120_000,
    });
    const report = JSON.parse(stdout.trim()) as { initial: PageState; create: Steps; edit: Steps };
    expect(report.initial.listTitles).toEqual(titles);
    for (const [mode, steps, dialogTitle, typedTitle] of [
      ["create", report.create, "新建提示词", "不应自动保存"],
      ["edit", report.edit, "编辑提示词", `${titles[0]}不应自动保存`],
    ] as const) {
      expect({ mode, asked: steps.askedToDiscard.dialogButtons }).toEqual({ mode, asked: expect.arrayContaining(["继续编辑", "放弃"]) });
      // Still the form, back at 取消 and 保存, with what was typed; the list as it was.
      expect({ mode, ...steps.keptEditing }).toEqual({ mode, dialogTitle, dialogButtons: expect.arrayContaining(["取消", "保存"]), titleValue: typedTitle, listTitles: titles });
      expect({ mode, ...steps.afterDiscard }).toEqual({ mode, dialogTitle: null, dialogButtons: [], titleValue: null, listTitles: titles });
    }
  }, 150_000);
});
