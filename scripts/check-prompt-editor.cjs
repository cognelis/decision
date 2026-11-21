/*
 * The 提示词 editor driven the way a person drives it, in Chromium: real mouse clicks (sendInputEvent) on the preview
 * page, so a button's default action runs as it does in the App. jsdom ran no such action, and so let through a
 * 继续编辑 that, clicked, submitted the form it had become the save button of.
 *
 *   electron scripts/check-prompt-editor.cjs
 *
 * Prints one JSON line: what the page showed after each step.
 */
const { app, BrowserWindow } = require("electron");
const { mkdtempSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");

const repositoryRoot = resolve(__dirname, "..");
const root = mkdtempSync(join(tmpdir(), "paraself-prompt-editor-"));
app.setPath("userData", join(root, "user-data"));
app.setPath("sessionData", join(root, "session-data"));
process.on("exit", () => rmSync(root, { recursive: true, force: true }));

let server;
let window;
const close = require("./electron-check-lifecycle.cjs").createElectronCheckLifecycle({
  app, getWindow: () => window, getServer: () => server,
});

const run = (script) => window.webContents.executeJavaScript(script);
const pause = (ms) => new Promise((done) => setTimeout(done, ms));

/** Waits for a selector expression (evaluated in the page) to be truthy. */
const waitFor = async (expression, label, timeoutMs = 15_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await run(`Boolean(${expression})`)) return;
    await pause(50);
  }
  throw new Error(`Timed out waiting for ${label}`);
};

/** The button with this exact text inside `scope`, as a page expression. */
const button = (scope, text) =>
  `[...document.querySelectorAll(${JSON.stringify(`${scope} button`)})].find((b) => b.textContent.trim() === ${JSON.stringify(text)})`;

/**
 * A real click at the middle of the element, mouse down and up through Chromium's input pipeline, then a wait for what
 * the click is meant to lead to (`until`, a page expression): no fixed sleep stands in for it.
 */
const click = async (expression, label, until, untilLabel) => {
  await waitFor(expression, label);
  const box = await run(`(() => { const r = (${expression}).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  const at = { x: Math.round(box.x), y: Math.round(box.y) };
  window.webContents.sendInputEvent({ type: "mouseMove", ...at });
  window.webContents.sendInputEvent({ type: "mouseDown", ...at, button: "left", clickCount: 1 });
  window.webContents.sendInputEvent({ type: "mouseUp", ...at, button: "left", clickCount: 1 });
  await waitFor(until, untilLabel);
};

/** Typed into the field, and waited for until the field holds it. */
const typeInto = async (selector, text) => {
  const field = `document.querySelector(${JSON.stringify(selector)})`;
  await waitFor(field, selector);
  const before = await run(`${field}.value`);
  await run(`${field}.focus()`);
  window.webContents.insertText(text);
  await waitFor(`${field}.value === ${JSON.stringify(before + text)}`, `${selector} to hold what was typed`);
};

const DIALOG = `document.querySelector(".modal-dialog")`;
const NO_DIALOG = `${DIALOG} === null`;
const ASKING = button(".modal-dialog", "继续编辑");
/**
 * After 继续编辑: the question gone, and either the form back at an enabled 保存 or no dialog at all. A submit the
 * click set off shows 正在保存… and then closes the dialog, which this also waits out, so the state read next is final.
 */
const SETTLED = `(!(${ASKING}) && (${NO_DIALOG} || ((${button(".modal-dialog", "保存")}) && !(${button(".modal-dialog", "保存")}).disabled)))`;

const state = () => run(`(() => {
  const dialog = document.querySelector(".modal-dialog");
  return {
    dialogTitle: dialog === null ? null : (dialog.querySelector("h2")?.textContent ?? "").trim(),
    dialogButtons: dialog === null ? [] : [...dialog.querySelectorAll("button")].map((b) => b.textContent.trim()).filter(Boolean),
    titleValue: dialog?.querySelector("input")?.value ?? null,
    listTitles: [...document.querySelectorAll(".prompt-row strong")].map((s) => s.textContent),
  };
})()`);

const scenario = async (mode) => {
  const steps = {};
  const opened = `${DIALOG} !== null && ${DIALOG}.querySelector("input") !== null`;
  if (mode === "create") await click(button(".prompt-header-actions", "新建"), "新建", opened, "the new prompt form");
  else await click(button(".prompt-detail-actions", "编辑"), "编辑", opened, "the edit form");
  await typeInto(".modal-dialog input", "不应自动保存");
  if (mode === "create") await typeInto(".modal-dialog textarea", "正文");
  await click(button(".modal-dialog", "取消"), "取消", ASKING, "the discard question");
  steps.askedToDiscard = await state();
  await click(ASKING, "继续编辑", SETTLED, "继续编辑 to settle");
  steps.keptEditing = await state();
  // Whatever happened, leave without saving for the next scenario.
  if (steps.keptEditing.dialogTitle !== null) {
    await click(button(".modal-dialog", "取消"), "取消", ASKING, "the discard question");
    await click(button(".modal-dialog", "放弃"), "放弃", NO_DIALOG, "the form to close");
  }
  steps.afterDiscard = await state();
  return steps;
};

app.whenReady().then(async () => {
  try {
    const { createServer } = await import("vite");
    server = await createServer({
      configFile: join(repositoryRoot, "apps", "desktop", "vite.renderer.config.ts"),
      logLevel: "silent",
      server: { host: "127.0.0.1", port: 0, strictPort: false },
    });
    await server.listen();
    const address = server.httpServer?.address();
    if (address === null || address === undefined || typeof address === "string") throw new Error("Preview server did not start");
    window = new BrowserWindow({
      width: 1160, height: 760, show: false, frame: false, enableLargerThanScreen: true,
      webPreferences: { partition: `prompt-editor-${process.pid}`, backgroundThrottling: false, offscreen: true },
    });
    await window.loadURL(`http://127.0.0.1:${address.port}/?preview=prompts&theme=light`);
    await waitFor(`document.querySelector(".prompt-row")`, "prompt list", 30_000);
    const initial = await state();
    const create = await scenario("create");
    const edit = await scenario("edit");
    process.stdout.write(`${JSON.stringify({ initial, create, edit })}\n`);
    await close(0);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    await close(1);
  }
});
