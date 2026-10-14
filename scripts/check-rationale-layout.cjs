const { app, BrowserWindow } = require("electron");
const { writeFileSync } = require("node:fs");
const { join, resolve } = require("node:path");

const repositoryRoot = resolve(__dirname, "..");
const theme = process.argv[2] ?? "dark";
const interaction = process.argv[3] ?? "default";
const screenshotPath = process.argv[4];
if (theme !== "light" && theme !== "dark") {
  throw new Error(`Unsupported rationale layout theme: ${theme}`);
}
if (
  ![
    "default",
    "expanded",
    "hover",
    "no-record",
    "alternatives-expanded",
  ].includes(interaction)
) {
  throw new Error(`Unsupported rationale layout interaction: ${interaction}`);
}
let server;
let window;

const close = require("./electron-check-lifecycle.cjs").createElectronCheckLifecycle({
  app, getWindow: () => window, getServer: () => server,
});

const measureRationaleLayout = async () => {
  const { createServer } = await import("vite");
  server = await createServer({
    configFile: join(
      repositoryRoot,
      "apps",
      "desktop",
      "vite.renderer.config.ts",
    ),
    logLevel: "silent",
    server: { host: "127.0.0.1", port: 0, strictPort: false },
  });
  await server.listen();

  const address = server.httpServer?.address();
  if (address === null || address === undefined) {
    throw new Error("Rationale layout server did not start");
  }
  const port = typeof address === "string" ? null : address.port;
  if (port === null) {
    throw new Error(`Unexpected rationale layout address: ${address}`);
  }

  window = new BrowserWindow({
    width: 1160,
    height: 760,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    webPreferences: { partition: `preview-${process.pid}`, offscreen: true },
  });
  await window.loadURL(
    `http://127.0.0.1:${port}/?preview=rationale&theme=${theme}`,
  );
  await require("./preview-sidebar.cjs").expandSidebar(window);

  const togglePoint = await window.webContents.executeJavaScript(`
    new Promise((resolve, reject) => {
      const deadline = Date.now() + 12000;
      const findToggle = () => {
        const toggle = document.querySelector(".context-toggle");
        if (toggle === null) {
          if (Date.now() >= deadline) {
            reject(new Error("Rationale context toggle did not render"));
            return;
          }
          setTimeout(findToggle, 16);
          return;
        }
        const rect = toggle.getBoundingClientRect();
        resolve({
          x: Math.round(rect.left + rect.width / 2),
          y: Math.round(rect.top + rect.height / 2),
        });
      };
      findToggle();
    })
  `);

  if (interaction === "expanded") {
    await window.webContents.executeJavaScript(`
      document.querySelector(".context-toggle")?.click();
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve))
      );
    `);
  }
  if (interaction === "alternatives-expanded") {
    await window.webContents.executeJavaScript(`
      document.querySelector(".decision-alternatives-toggle")?.click();
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve))
      );
    `);
  }
  if (interaction === "no-record") {
    await window.webContents.executeJavaScript(`
      document.querySelector(".rationale-discard")?.click();
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve))
      );
    `);
  } else if (interaction === "hover") {
    window.webContents.sendInputEvent({
      type: "mouseMove",
      x: togglePoint.x,
      y: togglePoint.y,
    });
  }

  return window.webContents.executeJavaScript(`
    new Promise((resolve, reject) => {
      const deadline = Date.now() + 12000;
      const measure = () => {
        const appShell = document.querySelector(".desktop-app");
        const sidebar = document.querySelector(".desktop-sidebar");
        const stage = document.querySelector(".desktop-stage");
        const workspace = document.querySelector(".decision-workspace");
        const card = document.querySelector(".decision-workspace-inner");
        const actions = document.querySelector(".rationale-actions");
        const discard = document.querySelector(".rationale-discard");
        const answerSummary = document.querySelector(
          ".decision-answer-summary"
        );
        const selectedAnswer = document.querySelector(
          ".decision-answer-item strong"
        );
        const alternatives = document.querySelector(
          ".decision-alternatives"
        );
        const alternativeOptions = Array.from(
          document.querySelectorAll(".decision-alternatives li")
        );
        const toggle = document.querySelector(".context-toggle");
        const dialog = document.querySelector('[role="dialog"]');
        const dialogContext = document.querySelector(
          ".decision-context-dialog-body"
        );
        const textarea = document.querySelector(".rationale-step textarea");
        const principleSection = document.querySelector(
          ".rationale-principle-recall"
        );
        const principleOptions = Array.from(
          document.querySelectorAll(".rationale-principle-option")
        );
        if (
          appShell === null || sidebar === null || stage === null ||
          workspace === null || card === null || actions === null || discard === null ||
          answerSummary === null || selectedAnswer === null ||
          alternatives === null || toggle === null ||
          textarea === null || principleSection === null || principleOptions.length !== 3
        ) {
          if (Date.now() >= deadline) {
            reject(new Error("Desktop rationale layout did not render"));
            return;
          }
          setTimeout(measure, 16);
          return;
        }
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            const rootStyles = getComputedStyle(document.documentElement);
            const shellStyles = getComputedStyle(appShell);
            const workspaceStyles = getComputedStyle(workspace);
            const toggleStyles = getComputedStyle(toggle);
            const actionsRect = actions.getBoundingClientRect();
            const cardRect = card.getBoundingClientRect();
            const dialogRect = dialog?.getBoundingClientRect();
            const textareaRect = textarea?.getBoundingClientRect();
            const principleOptionRects = principleOptions.map((option) =>
              option.getBoundingClientRect()
            );
            resolve({
              actionsBottom: actionsRect.bottom,
              actionsHeight: actionsRect.height,
              answerFontSize: Number.parseFloat(
                getComputedStyle(selectedAnswer).fontSize
              ),
              answerSummaryVisible: answerSummary !== null,
              answerSummaryFitsWidth:
                answerSummary.scrollWidth <= answerSummary.clientWidth + 1,
              alternativeOptionCount: alternativeOptions.length,
              alternativesVisible: alternatives !== null,
              appClientHeight: appShell.clientHeight,
              appScrollHeight: appShell.scrollHeight,
              backdropFilter: shellStyles.backdropFilter,
              cardBottom: cardRect.bottom,
              contextDialogCentered:
                dialogRect === undefined
                  ? false
                  : Math.abs(
                      dialogRect.top + dialogRect.height / 2 - innerHeight / 2
                    ) < 2,
              contextDialogOpen: dialog !== null,
              contextInsideDialog:
                dialog !== null &&
                dialogContext !== null &&
                dialog.contains(dialogContext),
              discardDisabled: discard.disabled,
              discardLabel: discard.textContent.trim(),
              inlineContextExpanded:
                document.querySelector(
                  ".decision-context > .decision-context-body"
                ) !== null,
              interaction: ${JSON.stringify(interaction)},
              navigationLabels: Array.from(
                document.querySelectorAll(".desktop-nav-item > span"),
                (node) => node.textContent,
              ),
              principleOptionCount: principleOptions.length,
              principleOptionsSingleRow:
                principleOptionRects.length > 0 &&
                principleOptionRects.every(
                  (rect) => Math.abs(rect.top - principleOptionRects[0].top) < 2
                ),
              principleSectionInsideCard:
                principleSection !== null && card.contains(principleSection),
              sidebarWidth: sidebar.getBoundingClientRect().width,
              stageWidth: stage.getBoundingClientRect().width,
              textareaBottom: textareaRect?.bottom ?? null,
              toggleBackground: toggleStyles.backgroundColor,
              tokens: {
                surface: rootStyles.getPropertyValue("--surface").trim(),
                window: rootStyles.getPropertyValue("--window").trim(),
              },
              viewportHeight: innerHeight,
              viewportWidth: innerWidth,
              workspaceClientHeight: workspace.clientHeight,
              workspaceOverflowY: workspaceStyles.overflowY,
              workspaceScrollHeight: workspace.scrollHeight,
              workspaceScrollTop: workspace.scrollTop,
            });
          });
        });
      };
      measure();
    })
  `);
};

app
  .whenReady()
  .then(measureRationaleLayout)
  .then(async (metrics) => {
    if (screenshotPath !== undefined) {
      const image = await window.webContents.capturePage();
      writeFileSync(screenshotPath, image.toPNG());
    }
    process.stdout.write(`${JSON.stringify(metrics)}\n`);
    await close(0);
  })
  .catch(async (error) => {
    process.stderr.write(
      `Rationale layout check failed: ${
        error instanceof Error ? error.stack : String(error)
      }\n`,
    );
    await close(1);
  });
