/*
 * Every primary surface, at both window sizes the app supports, measured for
 * content it cuts off.
 *
 * The per-page layout checks each know one page deeply; this one knows every
 * page shallowly and asks a single question: is anything drawn where nobody
 * can read or reach it? Three separate bugs hid from the deep checks because
 * they measured the stage, and the clipping was happening inside a card.
 *
 * One process measures every size it is given: starting a second Electron and
 * a second Vite server for the second size made this the slowest check in the
 * suite and, under a cold transform, the one that timed out.
 *
 *   npm run check:overflow -- [theme] [widthxheight ...]
 */
const { app, BrowserWindow } = require("electron");
const { join, resolve } = require("node:path");

const repositoryRoot = resolve(__dirname, "..");
const [theme = "light", ...sizeArguments] = process.argv.slice(2);
const sizes = (sizeArguments.length > 0 ? sizeArguments : ["1160x760"]).map(
  (argument) => {
    const [width, height] = argument.split("x").map(Number);
    if (!Number.isFinite(width) || !Number.isFinite(height)) {
      throw new Error(`Unsupported window size: ${argument}`);
    }
    return { width, height, key: `${width}x${height}` };
  },
);

if (theme !== "light" && theme !== "dark") {
  throw new Error(`Unsupported theme: ${theme}`);
}

const SURFACES = process.env.PARASELF_LOCAL_REVIEW_WORKFLOW === "1" ? ["local-review"] : process.env.DECISION_ASSISTANT_WORKFLOW === "1" ? ["assistant"] : [
  "dashboard",
  "decisions",
  "assistant",
  "pr-review",
  "local-review",
  "todos",
  "methodology",
  "prompts",
  "clients",
  "connections",
  "models",
  "activity",
  "settings",
];

/**
 * Deliberate truncation is not a finding: `text-overflow: ellipsis` and
 * `-webkit-line-clamp` both cut on purpose and draw the ellipsis that says so,
 * and a scrollable box can be scrolled. What is left is text cut mid-character
 * with nothing to say so, and boxes whose own overflow never reaches a
 * scrollbar.
 */
const PROBE = `
  (() => {
    const clipped = [];
    const cutOff = [];
    for (const element of document.querySelectorAll("*")) {
      // Geometry first, styles second. Resolving computed style for every
      // node on the page made this the slowest check in the suite, slow
      // enough to time out on a busy machine. Overflow is already known from
      // layout and only a handful of nodes have any, so the expensive
      // question is only put to those.
      // (No backticks in here: this whole block is a template literal.)
      const wide = element.scrollWidth - element.clientWidth;
      const tall = element.scrollHeight - element.clientHeight;
      if (wide <= 1 && tall <= 1) continue;
      // A 1x1 clipped box is the visually-hidden label pattern: it is meant to
      // overflow, and only a screen reader ever reads it.
      if (element.clientWidth <= 1 || element.clientHeight <= 1) continue;
      const styles = getComputedStyle(element);
      if (styles.display === "none" || styles.visibility === "hidden") continue;
      if (element.getClientRects().length === 0) continue;
      const scrollsX = styles.overflowX === "auto" || styles.overflowX === "scroll";
      const scrollsY = styles.overflowY === "auto" || styles.overflowY === "scroll";
      const describe = (overflowBy) => ({
        tag: element.tagName.toLowerCase(),
        cls: String(element.className).slice(0, 60),
        overflowBy,
        text: (element.textContent ?? "").trim().slice(0, 40),
      });
      if (
        wide > 1 &&
        !scrollsX &&
        styles.textOverflow !== "ellipsis" &&
        (styles.overflowX === "hidden" ||
          styles.whiteSpace === "nowrap" ||
          styles.whiteSpace === "pre")
      ) {
        clipped.push(describe(wide));
      }
      // A line clamp draws its own ellipsis, so it says it was cut.
      const clamped = styles.webkitLineClamp !== "none" && styles.webkitLineClamp !== "";
      if (
        tall > 1 &&
        !scrollsY &&
        !clamped &&
        styles.overflowY === "hidden"
      ) {
        cutOff.push(describe(tall));
      }
    }
    const stage = document.querySelector(".desktop-stage");
    return {
      documentOverflowX:
        document.documentElement.scrollWidth - document.documentElement.clientWidth,
      stageOverflowX: stage === null ? null : stage.scrollWidth - stage.clientWidth,
      clipped: clipped.slice(0, 10),
      clippedCount: clipped.length,
      cutOff: cutOff.slice(0, 10),
      cutOffCount: cutOff.length,
    };
  })()
`;

let server;
let window;

const close = require("./electron-check-lifecycle.cjs").createElectronCheckLifecycle({
  app, getWindow: () => window, getServer: () => server,
});

const measure = async () => {
  process.stderr.write("Surface overflow: starting preview server\n");
  const { createServer } = await import("vite");
  server = await createServer({
    configFile: join(repositoryRoot, "apps", "desktop", "vite.renderer.config.ts"),
    logLevel: "silent",
    server: { host: "127.0.0.1", port: 0, strictPort: false },
  });
  await server.listen();
  const address = server.httpServer?.address();
  if (address === null || address === undefined || typeof address === "string") {
    throw new Error("Surface overflow server did not start");
  }

  // One window, one size, one process. The alternatives both fail: `setSize`
  // on an offscreen window never settles and the next `loadURL` never
  // resolves, and a second window — even after destroying the first — cannot
  // reach the dev server any more.
  const measured = {};
  for (const size of sizes) {
    window = new BrowserWindow({
      width: size.width,
      height: size.height,
      // Off screen, it renders all the same: shown, it made Electron the app in front (IMP-133).
      show: false,
      frame: false,
      // Kept at this size on a smaller display (GitHub's macOS runner is 1024x768), which clamps a window otherwise.
      enableLargerThanScreen: true,
      transparent: true,
      backgroundColor: "#00000000",
      webPreferences: { partition: `preview-${process.pid}`, backgroundThrottling: false, offscreen: true },
    });
    const surfaces = {};
    for (const surface of SURFACES) {
      const url = `http://127.0.0.1:${address.port}/?preview=${surface}&theme=${theme}`;
      process.stderr.write(`Surface overflow: ${size.key}/${surface} loading\n`);
      // Every Electron-driven suite runs its own browser and its own dev
      // server, and under that load Chromium's network service has been seen
      // to crash and restart mid-run: the load in flight fails with
      // ERR_FAILED through no fault of the page. One retry covers the restart;
      // a second failure is a real one and is left to throw.
      try {
        await window.loadURL(url);
      } catch (error) {
        process.stderr.write(`retrying ${surface} after: ${String(error)}\n`);
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 1_000));
        await window.loadURL(url);
      }
      process.stderr.write(`Surface overflow: ${size.key}/${surface} waiting for layout\n`);
      await window.webContents.executeJavaScript(`new Promise((resolve) => {
        const deadline = Date.now() + 15000;
        const check = () => {
          const stage = document.querySelector(".desktop-stage");
          if ((stage && stage.textContent.trim().length > 0) || Date.now() > deadline) {
            // Geometry reads flush layout; offscreen animation callbacks can
            // stop arriving after navigation and must not hold the probe open.
            resolve();
          } else {
            setTimeout(check, 50);
          }
        };
        check();
      })`);
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
      process.stderr.write(`Surface overflow: ${size.key}/${surface} measuring\n`);

      if (surface === "assistant" && process.env.DECISION_ASSISTANT_WORKFLOW === "1") {
        await window.webContents.executeJavaScript(`(async () => {
          document.querySelector(".assistant-inline-citation").click();
          [...document.querySelectorAll("button")].find(button => button.textContent === "核对当前来源").click();
          document.querySelector('[aria-label="材料范围"]').click();
          await new Promise(resolve => setTimeout(resolve, 50));
          document.querySelector('[aria-label="仅根据指定材料回答"]').click();
        })()`);
        await new Promise(resolve => setTimeout(resolve, 100));
        await window.webContents.executeJavaScript(`
          const field = document.querySelector('[aria-label="搜索指定材料"]');
          Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(field, "配置");
          field.dispatchEvent(new Event("input", { bubbles: true }));
          true;
        `);
        await new Promise(resolve => setTimeout(resolve, 50));
        await window.webContents.executeJavaScript(`document.querySelector('[aria-label="搜索指定材料"]').closest("form").requestSubmit(); true;`);
        await new Promise(resolve => setTimeout(resolve, 100));
        await window.webContents.executeJavaScript(`
          const result = document.querySelector('[aria-label="材料搜索结果"] input');
          if (!result) throw new Error("No source selection result");
          result.click();
          true;
        `);
        await new Promise(resolve => setTimeout(resolve, 100));
        await window.webContents.executeJavaScript(`
          if (!document.querySelector('[aria-label="已指定的材料"] li')) throw new Error("Source selection missing");
          if (!document.querySelector(".assistant-source-comparison pre")) throw new Error("Source comparison missing");
          const composer = document.querySelector(".assistant-composer").getBoundingClientRect();
          if (composer.bottom > innerHeight + 1 || composer.height < 30) throw new Error("Composer clipped");
          true;
        `);
        if (process.env.PARASELF_ASSISTANT_SCREENSHOT) {
          require("node:fs").writeFileSync(process.env.PARASELF_ASSISTANT_SCREENSHOT, (await window.webContents.capturePage()).toPNG());
        }
      }
      const localScenarios = {};
      if (surface === "local-review" && process.env.PARASELF_LOCAL_REVIEW_WORKFLOW === "1") {
        const waitLocal = expression => window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
          const deadline = Date.now() + 15000;
          const check = () => { if (${expression}) resolve(); else if (Date.now() > deadline) reject(new Error('Local review state did not appear: ' + ${JSON.stringify(expression)})); else setTimeout(check, 25); }; check();
        })`);
        const captureLocal = async name => {
          localScenarios[name] = await window.webContents.executeJavaScript(PROBE);
          if (process.env.PARASELF_LOCAL_REVIEW_SCREENSHOT_DIR) {
            const fs = require("node:fs"); fs.mkdirSync(process.env.PARASELF_LOCAL_REVIEW_SCREENSHOT_DIR, { recursive: true });
            fs.writeFileSync(join(process.env.PARASELF_LOCAL_REVIEW_SCREENSHOT_DIR, `${name}-${theme}-${size.key}.png`), (await window.webContents.capturePage()).toPNG());
          }
        };
        await waitLocal("document.querySelector('.local-review-code-line') && document.querySelector('.local-review-tabs [role=tab]')");
        await waitLocal("document.querySelector('[role=separator][aria-label=\"调整文件栏宽度\"]')");
        await window.webContents.executeJavaScript(`(() => {
          const handle = document.querySelector('[role=separator][aria-label="调整文件栏宽度"]');
          for (const label of ['收起文件树', '收起意见栏']) {
            const button = document.querySelector('[aria-label="' + label + '"]');
            if (button && (button.textContent.trim() || !button.querySelector('svg'))) throw new Error('Panel toggle is not icon-only');
          }
          handle.dispatchEvent(new KeyboardEvent('keydown', {key:'End', bubbles:true}));
        })()`);
        await waitLocal("Number(document.querySelector('[aria-label=\"调整文件栏宽度\"]').getAttribute('aria-valuenow')) === Number(document.querySelector('[aria-label=\"调整文件栏宽度\"]').getAttribute('aria-valuemax'))");
        const assertColumnWidths = () => window.webContents.executeJavaScript(`(() => {
          const files = document.querySelector('.local-review-directory').getBoundingClientRect(), code = document.querySelector('.local-review-workspace > .pr-diff-content').getBoundingClientRect();
          if (files.width < 179 || files.width > 561 || code.width < 419) throw new Error('File/code width bounds violated: ' + files.width + '/' + code.width);
        })()`);
        await assertColumnWidths();
        if (size.width >= 1160 && await window.webContents.executeJavaScript(`!!document.querySelector('[aria-label="展开意见栏"]')`)) {
          await window.webContents.executeJavaScript(`document.querySelector('[aria-label="展开意见栏"]').click()`);
          await waitLocal("document.querySelector('.local-review-workspace').getAttribute('data-notes-collapsed') === 'false'");
          await assertColumnWidths();
          await window.webContents.executeJavaScript(`document.querySelector('[aria-label="收起意见栏"]').click()`);
          await waitLocal("document.querySelector('.local-review-workspace').getAttribute('data-notes-collapsed') === 'true'");
        }
        await window.webContents.executeJavaScript(`document.querySelector('[aria-label="调整文件栏宽度"]').dispatchEvent(new MouseEvent('dblclick', {bubbles:true}))`);
        await waitLocal("Number(document.querySelector('[aria-label=\"调整文件栏宽度\"]').getAttribute('aria-valuenow')) === Math.min(300, Number(document.querySelector('[aria-label=\"调整文件栏宽度\"]').getAttribute('aria-valuemax')))");
        await window.webContents.executeJavaScript(`document.querySelector('[aria-label="收起文件树"]').click()`);
        await waitLocal("!document.querySelector('[role=separator][aria-label=\"调整文件栏宽度\"]')");
        await window.webContents.executeJavaScript(`document.querySelector('[aria-label="展开文件树"]').click()`);
        await waitLocal("document.querySelector('[role=separator][aria-label=\"调整文件栏宽度\"]')");
        await window.webContents.executeJavaScript(`document.querySelector('.local-review-code-line').click()`);
        await waitLocal("document.querySelector('.local-review-inline-editor textarea')");
        await window.webContents.executeJavaScript(`(() => {
          const area = document.querySelector('.local-review-inline-editor textarea');
          const box = document.querySelector('.local-review-code').getBoundingClientRect();
          if (box.height < 240) throw new Error('Local review code area is too short');
          if (document.querySelector('.local-review-panel').scrollHeight > document.querySelector('.local-review-panel').clientHeight + 1) throw new Error('Local review page scrolls instead of its panes');
          if (innerWidth <= 1350 && document.querySelector('[aria-label="展开意见栏"]')?.getAttribute('aria-expanded') !== 'false') throw new Error('Minimum window opinions rail should start folded');
          if (document.activeElement !== area) throw new Error('Inline editor was not focused');
        })()`);
        await captureLocal("file-inline");
        await window.webContents.executeJavaScript(`document.querySelector('.local-review-inline-editor button[type=button]').click(); [...document.querySelectorAll('.local-review-panel .pr-diff-modes button')].find(button => button.textContent === '变更').click()`);
        await waitLocal("document.querySelector('.local-review-diff.diff-split .diff-widget')");
        await window.webContents.executeJavaScript(`(() => {
          const widget = document.querySelector('.local-review-diff [data-note-side="new"]');
          if (!widget) throw new Error('Saved annotation is missing from diff widget');
          const table = widget.closest('table').getBoundingClientRect(), card = widget.getBoundingClientRect();
          if (card.left < table.left + table.width / 2 - 2 || card.right > table.right + 2) throw new Error('Split widget crosses into the other side');
        })()`);
        await captureLocal("diff-split");
        await window.webContents.executeJavaScript(`document.querySelector('#local-review-tasks-tab').click()`);
        await waitLocal("!document.querySelector('#local-review-background').hidden && document.querySelector('.local-review-task-detail')");
        await captureLocal("background-tasks");
        await window.webContents.executeJavaScript(`[...document.querySelectorAll('.local-review-panel button')].find(button => button.textContent === '审阅风险改动').click()`);
        await waitLocal("document.querySelector('[role=dialog]')");
        await window.webContents.executeJavaScript(`(() => {
          const dialog = document.querySelector('[role=dialog]');
          if (!dialog.textContent.includes('固定提交：') || !dialog.textContent.includes('仍然推送')) throw new Error('Risk authorization content missing');
          const box = dialog.getBoundingClientRect();
          if (box.x < -1 || box.right > innerWidth + 1 || box.y < -1 || box.bottom > innerHeight + 1) throw new Error('Risk dialog outside viewport');
        })()`);
        await captureLocal("risk-dialog");
        if (process.env.PARASELF_LOCAL_REVIEW_SCREENSHOT) require("node:fs").writeFileSync(process.env.PARASELF_LOCAL_REVIEW_SCREENSHOT, (await window.webContents.capturePage()).toPNG());
        await window.webContents.executeJavaScript(`document.querySelector('[aria-label="关闭高风险改动"]').click()`);
        await waitLocal("!document.querySelector('[role=dialog]')");
        await window.webContents.executeJavaScript(`[...document.querySelectorAll('.local-review-panel button')].find(button=>button.textContent==='工程设置').click()`);
        await waitLocal("document.querySelector('[aria-label=依赖安装]')");
        await captureLocal("dependency-settings-auto");
        await window.webContents.executeJavaScript(`(()=>{const field=document.querySelector('[aria-label=依赖安装]');field.value='custom';field.dispatchEvent(new Event('change',{bubbles:true}));})()`);
        await waitLocal("document.querySelector('.local-review-settings textarea')");
        await captureLocal("dependency-settings-custom");
        await window.webContents.executeJavaScript(`document.querySelector('[aria-label="关闭工程设置"]').click()`);

      }
      surfaces[surface] = await window.webContents.executeJavaScript(PROBE);
      if (Object.keys(localScenarios).length) {
        const scenarios = Object.values(localScenarios), current = surfaces[surface];
        surfaces[surface] = { ...current, scenarios: localScenarios, documentOverflowX: Math.max(current.documentOverflowX, ...scenarios.map(value => value.documentOverflowX)), stageOverflowX: Math.max(current.stageOverflowX, ...scenarios.map(value => value.stageOverflowX)), clipped: scenarios.flatMap(value => value.clipped), cutOff: scenarios.flatMap(value => value.cutOff) };
      }
    }
    measured[size.key] = surfaces;
  }
  return { theme, sizes: measured };
};

app.whenReady().then(async () => {
  try {
    process.stdout.write(`${JSON.stringify(await measure())}\n`);
    await close(0);
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.stack : String(error)}\n`,
    );
    await close(1);
  }
});
