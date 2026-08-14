const { app, BrowserWindow } = require("electron");
const { writeFile } = require("node:fs/promises");
const { join, resolve } = require("node:path");

const repositoryRoot = resolve(__dirname, "..");
const theme = process.argv[2] ?? "dark";
const surface = process.argv[3] ?? "settings";
const fourthArgument = process.argv[4];
const compact =
  fourthArgument === "compact" ||
  fourthArgument === "practice-assets-compact" ||
  fourthArgument === "methodology-analysis-compact";
const interaction =
  fourthArgument === "practice-assets-compact"
    ? "practice-assets"
    : fourthArgument === "methodology-analysis-compact"
      ? "methodology-analysis"
      : fourthArgument === "add-backend" ||
          fourthArgument === "trace-detail" ||
          fourthArgument === "decision-outcome" ||
          fourthArgument === "decision-review" ||
          fourthArgument === "decision-schedule" ||
          fourthArgument === "decision-principles" ||
          fourthArgument === "decision-search" ||
          fourthArgument === "decision-filter-stability" ||
          fourthArgument === "methodology-materials" ||
          fourthArgument === "methodology-workbench" ||
          fourthArgument === "methodology-validation" ||
          fourthArgument === "methodology-create" ||
          fourthArgument === "methodology-manual-entry" ||
          fourthArgument === "methodology-manual-evidence" ||
          fourthArgument === "methodology-source" ||
          fourthArgument === "methodology-batch" ||
          fourthArgument === "methodology-import-preview" ||
          fourthArgument === "methodology-import-detail" ||
          fourthArgument === "methodology-evidence-match" ||
          fourthArgument === "methodology-evidence-link" ||
          fourthArgument === "methodology-detail" ||
          fourthArgument === "methodology-usage" ||
          fourthArgument === "methodology-evolution" ||
          fourthArgument === "methodology-evolution-recovery" ||
          fourthArgument === "methodology-evolution-rebase" ||
          fourthArgument === "methodology-relation-queue" ||
          fourthArgument === "methodology-relation-review" ||
          fourthArgument === "methodology-quality-confirm" ||
          fourthArgument === "methodology-graph" ||
          fourthArgument === "methodology-merge-draft" ||
          fourthArgument === "methodology-merge-recovery" ||
          fourthArgument === "methodology-merge-relation-review" ||
          fourthArgument === "methodology-merge-lifecycle" ||
          fourthArgument === "methodology-consultation" ||
          fourthArgument === "methodology-analysis" ||
          fourthArgument === "practice-assets" ||
          fourthArgument === "practice-source" ||
          fourthArgument === "practice-manual" ||
          fourthArgument === "practice-detail" ||
          fourthArgument === "practice-publication" ||
          fourthArgument === "practice-freshness" ||
          fourthArgument === "practice-history"
        ? fourthArgument
        : "default";
const screenshotPath =
  interaction === "default"
    ? compact
      ? process.argv[5]
      : fourthArgument
    : process.argv[5];
const supportedSurfaces = new Set([
  "decisions",
  "methodology",
  "settings",
  "clients",
  "models",
  "activity",
]);
if (theme !== "light" && theme !== "dark") {
  throw new Error(`Unsupported desktop layout theme: ${theme}`);
}
if (!supportedSurfaces.has(surface)) {
  throw new Error(`Unsupported desktop surface: ${surface}`);
}

let server;
let window;

const close = async (exitCode) => {
  if (window !== undefined && !window.isDestroyed()) window.destroy();
  if (server !== undefined) await server.close();
  app.exit(exitCode);
};

const measureDesktopLayout = async () => {
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
    throw new Error("Desktop layout server did not start");
  }
  const port = typeof address === "string" ? null : address.port;
  if (port === null) throw new Error(`Unexpected address: ${address}`);

  window = new BrowserWindow({
    width: compact ? 860 : 1160,
    height: compact ? 620 : 760,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    webPreferences: { offscreen: true },
  });
  await window.loadURL(
    `http://127.0.0.1:${port}/?preview=${surface}&theme=${theme}&interaction=${interaction}`,
  );

  let interactionMetrics = {};
  let interactionScreenshotCaptured = false;
  if (interaction === "decision-search") {
    interactionMetrics = await window.webContents.executeJavaScript(`
      new Promise((resolve, reject) => {
        const deadline = Date.now() + 12000;
        const enterQuery = () => {
          const input = document.querySelector(
            '.decision-search-field input[role="searchbox"]'
          );
          const field = document.querySelector(".decision-search-field");
          const mode = document.querySelector(
            '.decision-search-mode input[role="switch"]'
          );
          if (input === null || field === null || mode === null) {
            if (Date.now() >= deadline) {
              reject(new Error("Semantic decision search did not render"));
              return;
            }
            setTimeout(enterQuery, 16);
            return;
          }
          const setter = Object.getOwnPropertyDescriptor(
            HTMLInputElement.prototype,
            "value"
          )?.set;
          setter?.call(input, "命名规范");
          input.dispatchEvent(new Event("input", { bubbles: true }));
          input.focus();
          const modeDefaultOff = mode.getAttribute("aria-checked") === "false";
          mode.click();
          const measureSearch = () => {
            const clear = document.querySelector(".decision-search-clear");
            if (clear === null || mode.getAttribute("aria-checked") !== "true") {
              if (Date.now() >= deadline) {
                reject(new Error("Decision search clear action did not render"));
                return;
              }
              setTimeout(measureSearch, 16);
              return;
            }
            requestAnimationFrame(() => requestAnimationFrame(() => {
              const toolbar = document.querySelector(".decision-library-toolbar");
              const toolbarRect = toolbar?.getBoundingClientRect();
              resolve({
                decisionSearchFocused: document.activeElement === input,
                decisionSearchClearVisible:
                  clear.getBoundingClientRect().width > 0,
                decisionSearchModeDefaultOff: modeDefaultOff,
                decisionSearchModeEnabled:
                  mode.getAttribute("aria-checked") === "true",
                decisionSearchModeOutsideField: !field.contains(mode),
                decisionSearchSingleRow:
                  toolbarRect !== undefined &&
                  [...toolbar.children].every((child) => {
                    const rect = child.getBoundingClientRect();
                    return Math.abs(
                      rect.top + rect.height / 2 -
                        (toolbarRect.top + toolbarRect.height / 2)
                    ) < 1;
                  }),
              });
            }));
          };
          measureSearch();
        };
        enterQuery();
      })
    `);
  } else if (interaction === "decision-filter-stability") {
    interactionMetrics = await window.webContents.executeJavaScript(`
      new Promise((resolve, reject) => {
        const deadline = Date.now() + 12000;
        const measureFilters = () => {
          const toolbar = document.querySelector(".decision-library-toolbar");
          const segment = document.querySelector(".decision-filter-segment");
          const count = document.querySelector(".decision-result-count");
          const buttons = [...(segment?.querySelectorAll("button") ?? [])];
          if (toolbar === null || segment === null || count === null || buttons.length < 4) {
            if (Date.now() >= deadline) {
              reject(new Error("Decision quick filters did not render"));
              return;
            }
            setTimeout(measureFilters, 16);
            return;
          }
          if ((count.textContent?.trim() ?? "").startsWith("正在")) {
            if (Date.now() >= deadline) {
              reject(new Error("Decision quick filters never became ready"));
              return;
            }
            setTimeout(measureFilters, 16);
            return;
          }

          const samples = [];
          const capture = () => {
            const rects = [...toolbar.children].map((child) => {
              const rect = child.getBoundingClientRect();
              return { left: rect.left, right: rect.right, width: rect.width };
            });
            samples.push({ rects, count: count.textContent?.trim() ?? "" });
          };
          capture();
          let frame = 0;
          const tick = () => {
            capture();
            frame += 1;
            if (frame === 3) buttons[1].click();
            if (frame === 24) buttons[2].click();
            if (frame === 45) buttons[3].click();
            if (frame < 72) {
              requestAnimationFrame(tick);
              return;
            }
            const baseline = samples[0].rects;
            const maximumShift = samples.reduce((maximum, sample) => {
              const shift = sample.rects.reduce((rowMaximum, rect, index) => {
                const initial = baseline[index];
                if (initial === undefined) return rowMaximum;
                return Math.max(
                  rowMaximum,
                  Math.abs(rect.left - initial.left),
                  Math.abs(rect.right - initial.right),
                );
              }, 0);
              return Math.max(maximum, shift);
            }, 0);
            resolve({
              decisionFilterLoadingFlash: samples.some((sample) =>
                sample.count.startsWith("正在")
              ),
              decisionFilterMaximumShift: maximumShift,
              decisionFilterObservedCounts: [...new Set(samples.map((sample) => sample.count))],
              decisionFilterToolbarStable: maximumShift < 1,
            });
          };
          requestAnimationFrame(tick);
        };
        measureFilters();
      })
    `);
  } else if (interaction === "add-backend") {
    interactionMetrics = await window.webContents.executeJavaScript(`
      new Promise((resolve, reject) => {
        const deadline = Date.now() + 12000;
        const openEditor = () => {
          const button = [...document.querySelectorAll("button")].find(
            (candidate) => candidate.textContent?.trim() === "添加模型后端",
          );
          if (button === undefined) {
            if (Date.now() >= deadline) {
              reject(new Error("Add model backend button did not render"));
              return;
            }
            setTimeout(openEditor, 16);
            return;
          }
          const page = document.querySelector(".desktop-page-scroll");
          const listBefore = document.querySelector(".model-provider-list");
          const pageScrollHeightBefore = page?.scrollHeight ?? null;
          const listTopBefore = listBefore?.getBoundingClientRect().top ?? null;
          button.click();
          const measureEditor = () => {
            const editor = document.querySelector("#model-provider-editor");
            const list = document.querySelector(".model-provider-list");
            const dialog = document.querySelector('[role="dialog"]');
            if (editor === null || list === null || dialog === null || page === null) {
              if (Date.now() >= deadline) {
                reject(new Error("Add model backend dialog did not open"));
                return;
              }
              setTimeout(measureEditor, 16);
              return;
            }
            requestAnimationFrame(() => requestAnimationFrame(() => {
              const editorRect = editor.getBoundingClientRect();
              const listRect = list.getBoundingClientRect();
              const dialogRect = dialog.getBoundingClientRect();
              resolve({
                addButtonExpanded:
                  button.getAttribute("aria-expanded") === "true",
                addButtonLabel: button.textContent?.trim(),
                dialogCentered:
                  Math.abs(
                    dialogRect.top + dialogRect.height / 2 - innerHeight / 2
                  ) < 2,
                editorInsideDialog: dialog.contains(editor),
                editorTop: editorRect.top,
                editorVisible: editorRect.top >= 0 && editorRect.top < innerHeight,
                firstEditorControlFocused:
                  editor.querySelector("select, input") === document.activeElement,
                listTopStable:
                  listTopBefore !== null && Math.abs(listRect.top - listTopBefore) < 1,
                pageScrollHeightStable:
                  pageScrollHeightBefore !== null &&
                  page.scrollHeight === pageScrollHeightBefore,
              });
            }));
          };
          measureEditor();
        };
        openEditor();
      })
    `);
  } else if (interaction === "trace-detail") {
    interactionMetrics = await window.webContents.executeJavaScript(`
      new Promise((resolve, reject) => {
        const deadline = Date.now() + 12000;
        const openDialog = () => {
          const list = document.querySelector(".model-trace-list");
          const firstRow = document.querySelector(".model-trace-row");
          const button = [...document.querySelectorAll("button")].find(
            (candidate) => candidate.textContent?.trim() === "查看调用详情"
          );
          if (list === null || firstRow === null || button === undefined) {
            if (Date.now() >= deadline) {
              reject(new Error("Model trace detail action did not render"));
              return;
            }
            setTimeout(openDialog, 16);
            return;
          }
          const listHeightBefore = list.getBoundingClientRect().height;
          const listScrollHeightBefore = list.scrollHeight;
          const rowHeightBefore = firstRow.getBoundingClientRect().height;
          button.click();
          const measureDialog = () => {
            const dialog = document.querySelector('[role="dialog"]');
            const details = document.querySelector(".model-trace-dialog-details");
            if (dialog === null || details === null) {
              if (Date.now() >= deadline) {
                reject(new Error("Model trace detail dialog did not open"));
                return;
              }
              setTimeout(measureDialog, 16);
              return;
            }
            requestAnimationFrame(() => requestAnimationFrame(() => {
              const dialogRect = dialog.getBoundingClientRect();
              const dialogStyles = getComputedStyle(dialog);
              const backdrop = dialog.closest(".modal-backdrop");
              const backdropStyles = backdrop === null
                ? null
                : getComputedStyle(backdrop);
              resolve({
                traceDetailDialogCentered:
                  Math.abs(
                    dialogRect.top + dialogRect.height / 2 - innerHeight / 2
                  ) < 2,
                traceDetailInsideDialog: dialog.contains(details),
                traceDetailOpen: true,
                traceDetailBackdropBackground:
                  backdropStyles?.backgroundColor ?? null,
                traceDetailBackdropFilter:
                  backdropStyles?.backdropFilter ?? null,
                traceDetailBackgroundColor: dialogStyles.backgroundColor,
                traceDetailBackgroundImage: dialogStyles.backgroundImage,
                traceDetailSurfaceFilter: dialogStyles.backdropFilter,
                traceListHeightStable:
                  Math.abs(list.getBoundingClientRect().height - listHeightBefore) < 1,
                traceListScrollHeightStable:
                  list.scrollHeight === listScrollHeightBefore,
                traceRowHeightStable:
                  Math.abs(firstRow.getBoundingClientRect().height - rowHeightBefore) < 1,
              });
            }));
          };
          measureDialog();
        };
        openDialog();
      })
    `);
  } else if (interaction === "decision-outcome") {
    interactionMetrics = await window.webContents.executeJavaScript(`
      new Promise((resolve, reject) => {
        const deadline = Date.now() + 12000;
        const openDetail = () => {
          const firstRow = document.querySelector(".decision-library-row");
          const list = document.querySelector(".decision-library-list");
          if (firstRow === null || list === null) {
            if (Date.now() >= deadline) {
              reject(new Error("Decision library row did not render"));
              return;
            }
            setTimeout(openDetail, 16);
            return;
          }
          const listHeightBefore = list.getBoundingClientRect().height;
          firstRow.click();
          const openEditor = () => {
            const dialog = document.querySelector('[role="dialog"]');
            const action = [...document.querySelectorAll("button")].find(
              (button) => ["记录结果", "更新结果"].includes(
                button.textContent?.trim() ?? ""
              )
            );
            if (dialog === null || action === undefined) {
              if (Date.now() >= deadline) {
                reject(new Error("Decision detail dialog did not open"));
                return;
              }
              setTimeout(openEditor, 16);
              return;
            }
            action.click();
            const measureEditor = () => {
              const textarea = document.querySelector("#decision-outcome-input");
              if (textarea === null) {
                if (Date.now() >= deadline) {
                  reject(new Error("Decision outcome editor did not open"));
                  return;
                }
                setTimeout(measureEditor, 16);
                return;
              }
              requestAnimationFrame(() => requestAnimationFrame(() => {
                const dialogRect = dialog.getBoundingClientRect();
                resolve({
                  outcomeDialogCentered:
                    Math.abs(
                      dialogRect.top + dialogRect.height / 2 - innerHeight / 2
                    ) < 2,
                  outcomeEditorInsideDialog: dialog.contains(textarea),
                  outcomeEditorFocused: document.activeElement === textarea,
                  outcomeEditorVisible:
                    textarea.getBoundingClientRect().bottom <= dialogRect.bottom,
                  outcomeListHeightStable:
                    Math.abs(list.getBoundingClientRect().height - listHeightBefore) < 1,
                });
              }));
            };
            measureEditor();
          };
          openEditor();
        };
        openDetail();
      })
    `);
  } else if (interaction === "decision-review") {
    interactionMetrics = await window.webContents.executeJavaScript(`
      new Promise((resolve, reject) => {
        const deadline = Date.now() + 12000;
        const openDetail = () => {
          const firstRow = document.querySelector(".decision-library-row");
          const list = document.querySelector(".decision-library-list");
          if (firstRow === null || list === null) {
            if (Date.now() >= deadline) {
              reject(new Error("Decision library row did not render"));
              return;
            }
            setTimeout(openDetail, 16);
            return;
          }
          const listHeightBefore = list.getBoundingClientRect().height;
          firstRow.click();
          const openEditor = () => {
            const dialog = document.querySelector('[role="dialog"]');
            const action = [...document.querySelectorAll("button")].find(
              (button) => ["开始复盘", "更新复盘"].includes(
                button.textContent?.trim() ?? ""
              )
            );
            if (dialog === null || action === undefined) {
              if (Date.now() >= deadline) {
                reject(new Error("Decision review action did not render"));
                return;
              }
              setTimeout(openEditor, 16);
              return;
            }
            action.click();
            const measureEditor = () => {
              const textarea = document.querySelector("#decision-review-lesson");
              const verdicts = [...document.querySelectorAll(
                ".decision-verdict-options button"
              )];
              if (textarea === null || verdicts.length !== 5) {
                if (Date.now() >= deadline) {
                  reject(new Error("Decision review editor did not open"));
                  return;
                }
                setTimeout(measureEditor, 16);
                return;
              }
              requestAnimationFrame(() => requestAnimationFrame(() => {
                const dialogRect = dialog.getBoundingClientRect();
                resolve({
                  reviewDialogCentered:
                    Math.abs(
                      dialogRect.top + dialogRect.height / 2 - innerHeight / 2
                    ) < 2,
                  reviewEditorInsideDialog: dialog.contains(textarea),
                  reviewEditorFocused: document.activeElement === textarea,
                  reviewEditorVisible:
                    textarea.getBoundingClientRect().bottom <= dialogRect.bottom,
                  reviewListHeightStable:
                    Math.abs(list.getBoundingClientRect().height - listHeightBefore) < 1,
                  reviewVerdictCount: verdicts.length,
                  reviewVerdictSingleRow:
                    new Set(verdicts.map((button) =>
                      button.getBoundingClientRect().top
                    )).size === 1,
                });
              }));
            };
            measureEditor();
          };
          openEditor();
        };
        openDetail();
      })
    `);
  } else if (interaction === "decision-schedule") {
    const scheduleBaseMetrics = await window.webContents.executeJavaScript(`
      new Promise((resolve, reject) => {
        const deadline = Date.now() + 12000;
        const openDetail = () => {
          const firstRow = document.querySelectorAll(".decision-library-row")[1];
          const list = document.querySelector(".decision-library-list");
          if (firstRow === undefined || list === null) {
            if (Date.now() >= deadline) {
              reject(new Error("Decision library row did not render"));
              return;
            }
            setTimeout(openDetail, 16);
            return;
          }
          const listHeightBefore = list.getBoundingClientRect().height;
          firstRow.click();
          resolve({ listHeightBefore });
        };
        openDetail();
      })
    `);
    await window.webContents.executeJavaScript(`
      new Promise((resolve, reject) => {
        const deadline = Date.now() + 12000;
        const openEditor = () => {
          const action = [...document.querySelectorAll("button")].find(
            (button) => ["安排日期", "调整日期"].includes(
              button.textContent?.trim() ?? ""
            )
          );
          if (action === undefined) {
            if (Date.now() >= deadline) {
              reject(new Error("Decision review schedule action did not render"));
              return;
            }
            setTimeout(openEditor, 16);
            return;
          }
          action.click();
          resolve(true);
        };
        openEditor();
      })
    `);
    interactionMetrics = await window.webContents.executeJavaScript(`
      new Promise((resolve, reject) => {
        const deadline = Date.now() + 12000;
        const measureEditor = () => {
          const dialog = document.querySelector('[role="dialog"]');
          const list = document.querySelector(".decision-library-list");
          const editor = document.querySelector(".decision-review-schedule-editor");
          const dateInput = document.querySelector("#decision-review-due-date");
          const presets = [...document.querySelectorAll(
            ".decision-review-presets button"
          )];
          const noWakeCopy = [...document.querySelectorAll(
            ".decision-review-schedule-actions span"
          )].find((element) =>
            element.textContent?.includes("不会自动弹出窗口")
          );
          if (
            dialog === null ||
            list === null ||
            editor === null ||
            dateInput === null ||
            presets.length !== 3 ||
            noWakeCopy === undefined
          ) {
            if (Date.now() >= deadline) {
              reject(new Error("Decision review schedule editor did not open"));
              return;
            }
            setTimeout(measureEditor, 16);
            return;
          }
          const dialogRect = dialog.getBoundingClientRect();
          const editorRect = editor.getBoundingClientRect();
          const dateRect = dateInput.getBoundingClientRect();
          const noWakeRect = noWakeCopy.getBoundingClientRect();
          resolve({
            scheduleDialogCentered:
              Math.abs(
                dialogRect.top + dialogRect.height / 2 - innerHeight / 2
              ) < 2,
            scheduleEditorInsideDialog: dialog.contains(editor),
            scheduleEditorVisible:
              editorRect.top >= dialogRect.top &&
              editorRect.bottom <= dialogRect.bottom,
            scheduleDateVisible:
              dateRect.width > 0 &&
              dateRect.height > 0 &&
              dateRect.bottom <= dialogRect.bottom,
            scheduleNoWakeCopyVisible:
              noWakeRect.width > 0 && noWakeRect.height > 0,
            schedulePresetCount: presets.length,
            schedulePresetsSingleRow:
              new Set(presets.map((button) =>
                Math.round(button.getBoundingClientRect().top)
              )).size === 1,
            scheduleListHeightStable:
              Math.abs(
                list.getBoundingClientRect().height -
                  ${scheduleBaseMetrics.listHeightBefore}
              ) < 1,
          });
        };
        measureEditor();
      })
    `);
    if (screenshotPath !== undefined) {
      const image = await window.webContents.capturePage();
      await writeFile(screenshotPath, image.toPNG());
      interactionScreenshotCaptured = true;
    }
    await window.webContents.executeJavaScript(`
      new Promise((resolve) => {
        document.querySelector(".modal-dialog-close")?.click();
        setTimeout(resolve, 0);
      })
    `);
  } else if (interaction === "decision-principles") {
    interactionMetrics = await window.webContents.executeJavaScript(`
      new Promise((resolve, reject) => {
        const deadline = Date.now() + 12000;
        const openDetail = () => {
          const firstRow = document.querySelector(".decision-library-row");
          const list = document.querySelector(".decision-library-list");
          if (firstRow === null || list === null) {
            if (Date.now() >= deadline) {
              reject(new Error("Decision library row did not render"));
              return;
            }
            setTimeout(openDetail, 16);
            return;
          }
          const listHeightBefore = list.getBoundingClientRect().height;
          firstRow.click();
          const openEditor = () => {
            const dialog = document.querySelector('[role="dialog"]');
            const action = [...document.querySelectorAll("button")].find(
              (button) => ["关联原则", "调整关联"].includes(
                button.textContent?.trim() ?? ""
              )
            );
            if (dialog === null || action === undefined) {
              if (Date.now() >= deadline) {
                reject(new Error("Decision principle action did not render"));
                return;
              }
              setTimeout(openEditor, 16);
              return;
            }
            action.click();
            const measureEditor = () => {
              const editor = document.querySelector(".decision-principle-editor");
              const choices = [...document.querySelectorAll(
                ".decision-principle-choices label"
              )];
              const safetyCopy = [...document.querySelectorAll(
                ".decision-principle-editor > p"
              )].find((item) => item.textContent?.includes("不会由模型自动判断"));
              if (editor === null || choices.length === 0 || safetyCopy === undefined) {
                if (Date.now() >= deadline) {
                  reject(new Error("Decision principle editor did not open"));
                  return;
                }
                setTimeout(measureEditor, 16);
                return;
              }
              requestAnimationFrame(() => requestAnimationFrame(() => {
                const dialogRect = dialog.getBoundingClientRect();
                resolve({
                  decisionPrincipleDialogCentered:
                    Math.abs(dialogRect.top + dialogRect.height / 2 - innerHeight / 2) < 2,
                  decisionPrincipleEditorInsideDialog: dialog.contains(editor),
                  decisionPrincipleChoiceCount: choices.length,
                  decisionPrincipleChoicesTwoColumns:
                    choices.length < 2 ||
                    new Set(choices.slice(0, 2).map((choice) =>
                      Math.round(choice.getBoundingClientRect().top)
                    )).size === 1,
                  decisionPrincipleSafetyCopyVisible:
                    safetyCopy.getBoundingClientRect().height > 0,
                  decisionPrincipleListHeightStable:
                    Math.abs(list.getBoundingClientRect().height - listHeightBefore) < 1,
                });
              }));
            };
            measureEditor();
          };
          openEditor();
        };
        openDetail();
      })
    `);
  } else if (interaction === "methodology-workbench") {
    interactionMetrics = await window.webContents.executeJavaScript(`
      new Promise((resolve, reject) => {
        const deadline = Date.now() + 12000;
        const open = () => {
          const action = document.querySelector(".methodology-workbench-button");
          const toolbar = document.querySelector(".methodology-toolbar");
          if (action === null || toolbar === null || action.disabled) {
            if (Date.now() >= deadline) return reject(new Error("Methodology workbench action did not render"));
            setTimeout(open, 16);
            return;
          }
          const toolbarRectBefore = toolbar.getBoundingClientRect();
          action.click();
          const measure = () => {
            const dialog = document.querySelector('[role="dialog"]');
            const workbench = document.querySelector(".methodology-workbench");
            const cards = [...document.querySelectorAll(".methodology-workbench > ol button")];
            const body = dialog?.querySelector(".modal-dialog-body");
            if (dialog === null || workbench === null || cards.length !== 3) {
              if (Date.now() >= deadline) return reject(new Error("Methodology workbench did not render"));
              setTimeout(measure, 16);
              return;
            }
            requestAnimationFrame(() => requestAnimationFrame(() => {
              const dialogRect = dialog.getBoundingClientRect();
              const cardTops = cards.map((card) => card.getBoundingClientRect().top);
              resolve({
                methodologyWorkbenchCentered:
                  Math.abs(dialogRect.top + dialogRect.height / 2 - innerHeight / 2) < 2,
                methodologyWorkbenchInsideDialog: dialog.contains(workbench),
                methodologyWorkbenchCardCount: cards.length,
                methodologyWorkbenchCardsSingleRow:
                  cardTops.every((top) => Math.abs(top - cardTops[0]) < 1),
                methodologyWorkbenchBoundaryVisible:
                  workbench.textContent.includes("不会自动生成、采纳或修改原则") &&
                  workbench.textContent.includes("不会确认或忽略任何事项"),
                methodologyWorkbenchHorizontalOverflow:
                  body === null ? true : body.scrollWidth > body.clientWidth,
                methodologyWorkbenchToolbarStable:
                  Math.abs(toolbar.getBoundingClientRect().height - toolbarRectBefore.height) < 1 &&
                  Math.abs(toolbar.getBoundingClientRect().top - toolbarRectBefore.top) < 1,
              });
            }));
          };
          measure();
        };
        open();
      })
    `);
  } else if (interaction === "methodology-validation") {
    interactionMetrics = await window.webContents.executeJavaScript(`
      new Promise((resolve, reject) => {
        const deadline = Date.now() + 12000;
        const open = () => {
          const launcher = document.querySelector(".methodology-workbench-button");
          const toolbar = document.querySelector(".methodology-toolbar");
          if (launcher === null || toolbar === null || launcher.disabled) {
            if (Date.now() >= deadline) return reject(new Error("Methodology validation action did not render"));
            setTimeout(open, 16);
            return;
          }
          const toolbarRectBefore = toolbar.getBoundingClientRect();
          launcher.click();
          const openInbox = () => {
            const action = document.querySelector(".methodology-validation-button");
            if (action === null || action.disabled) {
              if (Date.now() >= deadline) return reject(new Error("Methodology validation workbench item did not render"));
              setTimeout(openInbox, 16);
              return;
            }
            action.click();
            measure();
          };
          const measure = () => {
            const dialog = document.querySelector('[role="dialog"]');
            const inbox = document.querySelector(".methodology-validation-inbox");
            const cards = [...document.querySelectorAll(".methodology-validation-list article")];
            const metrics = [...document.querySelectorAll(".methodology-validation-metrics > span")];
            const decisions = [...document.querySelectorAll(".methodology-validation-decisions > li")];
            const body = dialog?.querySelector(".modal-dialog-body");
            if (dialog === null || inbox === null || cards.length === 0 || metrics.length !== 3 || decisions.length === 0) {
              if (Date.now() >= deadline) return reject(new Error("Methodology validation inbox did not render"));
              setTimeout(measure, 16);
              return;
            }
            requestAnimationFrame(() => requestAnimationFrame(() => {
              const dialogRect = dialog.getBoundingClientRect();
              const decisionTops = decisions.map((item) => item.getBoundingClientRect().top);
              const cardActions = [...cards[0].querySelectorAll("footer button")];
              resolve({
                methodologyValidationCentered:
                  Math.abs(dialogRect.top + dialogRect.height / 2 - innerHeight / 2) < 2,
                methodologyValidationInsideDialog: dialog.contains(inbox),
                methodologyValidationCardCount: cards.length,
                methodologyValidationMetricCount: metrics.length,
                methodologyValidationDecisionCount: decisions.length,
                methodologyValidationDecisionsSingleRow:
                  decisionTops.every((top) => Math.abs(top - decisionTops[0]) < 1),
                methodologyValidationActionCount: cardActions.length,
                methodologyValidationActionsSingleRow:
                  cardActions.length > 0 && cardActions.every((item) =>
                    Math.abs(item.getBoundingClientRect().top - cardActions[0].getBoundingClientRect().top) < 1
                  ),
                methodologyValidationHumanBoundaryVisible:
                  inbox.textContent?.includes("不会自动提高可信度或改写原则") === true &&
                  inbox.textContent?.includes("不改变原则内容") === true,
                methodologyValidationHorizontalOverflow:
                  body === null ? true : body.scrollWidth > body.clientWidth,
                methodologyValidationToolbarStable:
                  Math.abs(toolbar.getBoundingClientRect().height - toolbarRectBefore.height) < 1 &&
                  Math.abs(toolbar.getBoundingClientRect().top - toolbarRectBefore.top) < 1,
              });
            }));
          };
          openInbox();
        };
        open();
      })
    `);
  } else if (interaction === "methodology-materials") {
    interactionMetrics = await window.webContents.executeJavaScript(`
      new Promise((resolve, reject) => {
        const deadline = Date.now() + 12000;
        const open = () => {
          const launcher = document.querySelector(".methodology-workbench-button");
          const toolbar = document.querySelector(".methodology-toolbar");
          if (launcher === null || toolbar === null || launcher.disabled) {
            if (Date.now() >= deadline) return reject(new Error("Methodology material action did not render"));
            setTimeout(open, 16);
            return;
          }
          const toolbarRectBefore = toolbar.getBoundingClientRect();
          launcher.click();
          const openInbox = () => {
            const action = document.querySelector(".methodology-materials-button");
            if (action === null || action.disabled) {
              if (Date.now() >= deadline) return reject(new Error("Methodology material workbench item did not render"));
              setTimeout(openInbox, 16);
              return;
            }
            action.click();
            measure();
          };
          const measure = () => {
            const dialog = document.querySelector('[role="dialog"]');
            const inbox = document.querySelector(".methodology-material-inbox");
            const modes = [...document.querySelectorAll(".methodology-material-modes button")];
            const cards = [...document.querySelectorAll(".methodology-material-list article")];
            const sources = [...document.querySelectorAll(".methodology-material-sources > li")];
            const boundary = document.querySelector(".methodology-material-boundary");
            const body = dialog?.querySelector(".modal-dialog-body");
            if (dialog === null || inbox === null || modes.length !== 2 || cards.length === 0 || boundary === null) {
              if (Date.now() >= deadline) return reject(new Error("Methodology material inbox did not render"));
              setTimeout(measure, 16);
              return;
            }
            requestAnimationFrame(() => requestAnimationFrame(() => {
              const dialogRect = dialog.getBoundingClientRect();
              const modeTops = modes.map((item) => item.getBoundingClientRect().top);
              const boundaryTops = [...boundary.children].map((item) => item.getBoundingClientRect().top);
              const cardActions = [...cards[0].querySelectorAll("footer button")];
              resolve({
                methodologyMaterialsCentered:
                  Math.abs(dialogRect.top + dialogRect.height / 2 - innerHeight / 2) < 2,
                methodologyMaterialsInsideDialog: dialog.contains(inbox),
                methodologyMaterialsModeCount: modes.length,
                methodologyMaterialsModesSingleRow:
                  modeTops.every((top) => Math.abs(top - modeTops[0]) < 1),
                methodologyMaterialsCardCount: cards.length,
                methodologyMaterialsSourceCount: sources.length,
                methodologyMaterialsActionCount: cardActions.length,
                methodologyMaterialsActionsSingleRow:
                  cardActions.length > 0 && cardActions.every((item) =>
                    Math.abs(item.getBoundingClientRect().top - cardActions[0].getBoundingClientRect().top) < 1
                  ),
                methodologyMaterialsBoundaryCount: boundary.children.length,
                methodologyMaterialsBoundarySingleRow:
                  boundaryTops.every((top) => Math.abs(top - boundaryTops[0]) < 1),
                methodologyMaterialsNoAutomaticCopy:
                  inbox.textContent?.includes("不会自动生成原则") === true &&
                  inbox.textContent?.includes("不会自动采纳或发布") === true,
                methodologyMaterialsHorizontalOverflow:
                  body === null ? true : body.scrollWidth > body.clientWidth,
                methodologyMaterialsToolbarStable:
                  Math.abs(toolbar.getBoundingClientRect().height - toolbarRectBefore.height) < 1 &&
                  Math.abs(toolbar.getBoundingClientRect().top - toolbarRectBefore.top) < 1,
              });
            }));
          };
          openInbox();
        };
        open();
      })
    `);
  } else if (interaction === "methodology-create") {
    interactionMetrics = await window.webContents.executeJavaScript(`
      new Promise((resolve, reject) => {
        const deadline = Date.now() + 12000;
        const open = () => {
          const action = document.querySelector(".methodology-create-button");
          if (action === null) {
            if (Date.now() >= deadline) return reject(new Error("Methodology create action did not render"));
            setTimeout(open, 16);
            return;
          }
          action.click();
          const measure = () => {
            const dialog = document.querySelector('[role="dialog"]');
            const chooser = document.querySelector(".methodology-create-chooser");
            const options = [...document.querySelectorAll(".methodology-create-options > button")];
            const boundary = document.querySelector(".methodology-create-boundary");
            if (dialog === null || chooser === null || options.length !== 3 || boundary === null) {
              if (Date.now() >= deadline) return reject(new Error("Methodology creation chooser did not render"));
              setTimeout(measure, 16);
              return;
            }
            requestAnimationFrame(() => requestAnimationFrame(() => {
              const dialogRect = dialog.getBoundingClientRect();
              const body = dialog.querySelector(".modal-dialog-body");
              const optionTops = options.map((option) => option.getBoundingClientRect().top);
              resolve({
                methodologyCreateCentered:
                  Math.abs(dialogRect.top + dialogRect.height / 2 - innerHeight / 2) < 2,
                methodologyCreateInsideDialog: dialog.contains(chooser),
                methodologyCreateOptionCount: options.length,
                methodologyCreateOptionsSingleRow:
                  optionTops.every((top) => Math.abs(top - optionTops[0]) < 1),
                methodologyCreateBoundaryCount: boundary.children.length,
                methodologyCreateNoModelVisible:
                  chooser.textContent?.includes("0 次模型调用") === true,
                methodologyCreateHorizontalOverflow:
                  body === null ? true : body.scrollWidth > body.clientWidth,
              });
            }));
          };
          measure();
        };
        open();
      })
    `);
  } else if (interaction === "methodology-manual-entry") {
    interactionMetrics = await window.webContents.executeJavaScript(`
      new Promise((resolve, reject) => {
        const deadline = Date.now() + 12000;
        const open = () => {
          const action = document.querySelector(".methodology-create-button");
          if (action === null) {
            if (Date.now() >= deadline) return reject(new Error("Methodology create action did not render"));
            setTimeout(open, 16);
            return;
          }
          action.click();
          const openManual = () => {
            const manual = document.querySelector(".methodology-create-option.manual");
            if (manual === null) {
              if (Date.now() >= deadline) return reject(new Error("Manual methodology option did not render"));
              setTimeout(openManual, 16);
              return;
            }
            manual.click();
            const measure = () => {
              const dialog = document.querySelector('[role="dialog"]');
              const editor = document.querySelector(".methodology-manual-entry");
              const fields = [...document.querySelectorAll(".methodology-manual-entry-form > label")];
              const safety = document.querySelector(".methodology-manual-entry-safety");
              const save = [...document.querySelectorAll("button")].find(
                (button) => button.textContent?.trim() === "保存为待确认候选"
              );
              if (dialog === null || editor === null || fields.length !== 4 || safety === null || save === undefined) {
                if (Date.now() >= deadline) return reject(new Error("Manual methodology editor did not render"));
                setTimeout(measure, 16);
                return;
              }
              requestAnimationFrame(() => requestAnimationFrame(() => {
                const dialogRect = dialog.getBoundingClientRect();
                const body = dialog.querySelector(".modal-dialog-body");
                const fieldTops = fields.map((field) => field.getBoundingClientRect().top);
                resolve({
                  methodologyManualCentered:
                    Math.abs(dialogRect.top + dialogRect.height / 2 - innerHeight / 2) < 2,
                  methodologyManualInsideDialog: dialog.contains(editor),
                  methodologyManualFieldCount: fields.length,
                  methodologyManualBoundaryFieldsSingleRow:
                    Math.abs(fieldTops[2] - fieldTops[3]) < 1,
                  methodologyManualSafetyVisible:
                    safety.getBoundingClientRect().bottom <= dialogRect.bottom,
                  methodologyManualSaveVisible:
                    save.getBoundingClientRect().bottom <= dialogRect.bottom,
                  methodologyManualHorizontalOverflow:
                    body === null ? true : body.scrollWidth > body.clientWidth,
                  methodologyManualNoModelCopy:
                    editor.textContent?.includes("不会补写事实或调用模型") === true,
                });
              }));
            };
            measure();
          };
          openManual();
        };
        open();
      })
    `);
  } else if (interaction === "methodology-manual-evidence") {
    interactionMetrics = await window.webContents.executeJavaScript(`
      new Promise((resolve, reject) => {
        const deadline = Date.now() + 12000;
        const open = () => {
          const create = document.querySelector(".methodology-create-button");
          if (create === null) {
            if (Date.now() >= deadline) return reject(new Error("Methodology create action did not render"));
            setTimeout(open, 16);
            return;
          }
          create.click();
          const chooseEvidence = () => {
            const option = document.querySelector(".methodology-generate-button");
            if (option === null) {
              if (Date.now() >= deadline) return reject(new Error("Methodology evidence option did not render"));
              setTimeout(chooseEvidence, 16);
              return;
            }
            option.click();
            const chooseSources = () => {
              const checkboxes = [...document.querySelectorAll(
                '.methodology-source-list input[type="checkbox"]'
              )];
              const manual = document.querySelector(".methodology-manual-evidence-button");
              if (checkboxes.length < 2 || manual === null) {
                if (Date.now() >= deadline) return reject(new Error("Manual evidence source choices did not render"));
                setTimeout(chooseSources, 16);
                return;
              }
              checkboxes.slice(0, 2).forEach((checkbox) => checkbox.click());
              const openManual = () => {
                const action = document.querySelector(".methodology-manual-evidence-button");
                if (action === null || action.disabled) {
                  if (Date.now() >= deadline) return reject(new Error("Manual evidence action did not become available"));
                  setTimeout(openManual, 16);
                  return;
                }
                action.click();
              const measure = () => {
                const dialogs = [...document.querySelectorAll('[role="dialog"]')];
                const dialog = dialogs[0];
                const editor = document.querySelector(".methodology-manual-evidence-entry");
                const sources = [...document.querySelectorAll(".methodology-manual-evidence-sources > li")];
                const fields = [...document.querySelectorAll(".methodology-manual-evidence-form > label")];
                const boundary = document.querySelector(".methodology-manual-evidence-boundary");
                const save = [...document.querySelectorAll("button")].find(
                  (button) => button.textContent?.trim() === "保存人工候选"
                );
                if (dialog === undefined || editor === null || sources.length !== 2 ||
                    fields.length !== 5 || boundary === null || save === undefined) {
                  if (Date.now() >= deadline) return reject(new Error("Manual evidence methodology editor did not render"));
                  setTimeout(measure, 16);
                  return;
                }
                requestAnimationFrame(() => requestAnimationFrame(() => {
                  const dialogRect = dialog.getBoundingClientRect();
                  const body = dialog.querySelector(".modal-dialog-body");
                  const sourceTops = sources.map((item) => item.getBoundingClientRect().top);
                  const boundaryTops = [...boundary.children].map((item) => item.getBoundingClientRect().top);
                  resolve({
                    methodologyManualEvidenceCentered:
                      Math.abs(dialogRect.top + dialogRect.height / 2 - innerHeight / 2) < 2,
                    methodologyManualEvidenceInsideDialog: dialog.contains(editor),
                    methodologyManualEvidenceDialogCount: dialogs.length,
                    methodologyManualEvidenceSourceCount: sources.length,
                    methodologyManualEvidenceSourcesSingleRow:
                      sourceTops.every((top) => Math.abs(top - sourceTops[0]) < 1),
                    methodologyManualEvidenceFieldCount: fields.length,
                    methodologyManualEvidenceBoundaryCount: boundary.children.length,
                    methodologyManualEvidenceBoundarySingleRow:
                      boundaryTops.every((top) => Math.abs(top - boundaryTops[0]) < 1),
                    methodologyManualEvidenceNoModelVisible:
                      editor.textContent?.includes("0 次模型调用") === true &&
                      editor.textContent?.includes("不调用模型") === true,
                    methodologyManualEvidenceSaveVisible:
                      save.getBoundingClientRect().bottom <= dialogRect.bottom,
                    methodologyManualEvidenceHorizontalOverflow:
                      body === null ? true : body.scrollWidth > body.clientWidth,
                  });
                }));
              };
              measure();
              };
              openManual();
            };
            chooseSources();
          };
          chooseEvidence();
        };
        open();
      })
    `);
  } else if (interaction === "methodology-source") {
    interactionMetrics = await window.webContents.executeJavaScript(`
      new Promise((resolve, reject) => {
        const deadline = Date.now() + 12000;
        const openChooser = () => {
          const action = [...document.querySelectorAll("button")].find(
            (button) => button.classList.contains("methodology-create-button")
          );
          const list = document.querySelector(".methodology-list");
          const row = list?.querySelector(".methodology-row") ?? null;
          if (action === undefined || list === null || row === null) {
            if (Date.now() >= deadline) {
              reject(new Error(
                "Methodology source action did not render; buttons=" +
                [...document.querySelectorAll("button")]
                  .map((button) => button.textContent?.trim() + "[" + button.className + "]")
                  .slice(0, 20)
                  .join(" | ") +
                "; list=" + (list !== null)
              ));
              return;
            }
            setTimeout(openChooser, 16);
            return;
          }
          requestAnimationFrame(() => requestAnimationFrame(() => {
            const listHeightBefore = list.getBoundingClientRect().height;
            action.click();
            const chooseEvidence = () => {
              const option = document.querySelector(".methodology-generate-button");
              if (option === null) {
                if (Date.now() >= deadline) return reject(new Error("Methodology evidence option did not render"));
                setTimeout(chooseEvidence, 16);
                return;
              }
              option.click();
            const measureChooser = () => {
            const dialog = document.querySelector('[role="dialog"]');
            const sourceList = document.querySelector(".methodology-source-list");
            const suggestionPicker = document.querySelector(
              ".methodology-suggestion-picker"
            );
            const generate = [...document.querySelectorAll("button")].find(
              (button) => button.textContent?.trim() === "模型提炼 · 1 次"
            );
            const manual = document.querySelector(".methodology-manual-evidence-button");
            if (dialog === null || sourceList === null || generate === undefined || manual === null) {
              if (Date.now() >= deadline) {
                reject(new Error("Methodology source chooser did not open"));
                return;
              }
              setTimeout(measureChooser, 16);
              return;
            }
            requestAnimationFrame(() => requestAnimationFrame(() => {
              const dialogRect = dialog.getBoundingClientRect();
              const sourceRect = sourceList.getBoundingClientRect();
              resolve({
                methodologyChooserCentered:
                  Math.abs(dialogRect.top + dialogRect.height / 2 - innerHeight / 2) < 2,
                methodologySourceListInsideDialog:
                  sourceRect.top >= dialogRect.top && sourceRect.bottom <= dialogRect.bottom,
                methodologyGenerateActionVisible:
                  generate.getBoundingClientRect().bottom <= dialogRect.bottom,
                methodologyManualEvidenceActionVisible:
                  manual.getBoundingClientRect().bottom <= dialogRect.bottom,
                methodologySourceActionsSingleRow:
                  Math.abs(
                    manual.getBoundingClientRect().top -
                    generate.getBoundingClientRect().top
                  ) < 1,
                methodologySourceCount:
                  sourceList.querySelectorAll('input[type="checkbox"]').length,
                methodologySuggestionCount:
                  suggestionPicker?.querySelectorAll("button").length ?? 0,
                methodologySuggestionPickerInsideDialog:
                  suggestionPicker === null || dialog.contains(suggestionPicker),
                methodologyListHeightStable:
                  Math.abs(list.getBoundingClientRect().height - listHeightBefore) < 1,
              });
            }));
            };
            measureChooser();
            };
            chooseEvidence();
          }));
        };
        openChooser();
      })
    `);
  } else if (interaction === "methodology-batch") {
    interactionMetrics = await window.webContents.executeJavaScript(`
      new Promise((resolve, reject) => {
        const deadline = Date.now() + 12000;
        const openChooser = () => {
          const action = document.querySelector(".methodology-create-button");
          const list = document.querySelector(".methodology-list");
          const row = list?.querySelector(".methodology-row") ?? null;
          if (action === null || list === null || row === null) {
            if (Date.now() >= deadline) {
              reject(new Error("Methodology generation action did not render"));
              return;
            }
            setTimeout(openChooser, 16);
            return;
          }
          const listHeightBefore = list.getBoundingClientRect().height;
          action.click();
          const chooseEvidence = () => {
            const option = document.querySelector(".methodology-generate-button");
            if (option === null) {
              if (Date.now() >= deadline) return reject(new Error("Methodology evidence option did not render"));
              setTimeout(chooseEvidence, 16);
              return;
            }
            option.click();
          const openBatch = () => {
            const batchAction = [...document.querySelectorAll("button")].find(
              (button) => button.textContent?.trim().startsWith("批量生成 ")
            );
            if (batchAction === undefined) {
              if (Date.now() >= deadline) {
                reject(new Error("Batch methodology action did not render"));
                return;
              }
              setTimeout(openBatch, 16);
              return;
            }
            batchAction.click();
            const measureBatch = () => {
              const dialog = document.querySelector('[role="dialog"]');
              const route = document.querySelector(".methodology-batch-route");
              const confirmation = document.querySelector(
                ".methodology-batch-confirmation"
              );
              const start = [...document.querySelectorAll("button")].find(
                (button) => button.textContent?.trim().startsWith("生成 ")
              );
              if (dialog === null || route === null || confirmation === null ||
                  start === undefined) {
                if (Date.now() >= deadline) {
                  reject(new Error("Batch methodology dialog did not open"));
                  return;
                }
                setTimeout(measureBatch, 16);
                return;
              }
              requestAnimationFrame(() => requestAnimationFrame(() => {
                const dialogRect = dialog.getBoundingClientRect();
                const actionRect = start.getBoundingClientRect();
                resolve({
                  methodologyBatchCentered:
                    Math.abs(dialogRect.top + dialogRect.height / 2 - innerHeight / 2) < 2,
                  methodologyBatchInsideDialog:
                    dialog.contains(confirmation) && dialog.contains(route),
                  methodologyBatchActionVisible:
                    actionRect.top >= dialogRect.top && actionRect.bottom <= dialogRect.bottom,
                  methodologyBatchSafetyCopyVisible:
                    confirmation.textContent?.includes("不会自动采纳") === true,
                  methodologyListHeightStable:
                    list === null || Math.abs(list.getBoundingClientRect().height - listHeightBefore) < 1,
                });
              }));
            };
            measureBatch();
          };
          openBatch();
          };
          chooseEvidence();
        };
        openChooser();
      })
    `);
  } else if (interaction === "methodology-import-preview") {
    interactionMetrics = await window.webContents.executeJavaScript(`
      new Promise((resolve, reject) => {
        const deadline = Date.now() + 12000;
        const openPreview = () => {
          const action = document.querySelector(".methodology-create-button");
          if (action === null) {
            if (Date.now() >= deadline) return reject(new Error("Methodology create action did not render"));
            setTimeout(openPreview, 16);
            return;
          }
          action.click();
          const chooseImport = () => {
            const option = document.querySelector(".methodology-import-button");
            if (option === null) {
              if (Date.now() >= deadline) return reject(new Error("Methodology import option did not render"));
              setTimeout(chooseImport, 16);
              return;
            }
            option.click();
          const measurePreview = () => {
            const dialog = document.querySelector('[role="dialog"]');
            const preview = document.querySelector(".methodology-import-preview");
            const summary = [...document.querySelectorAll(".methodology-import-summary > div")];
            const candidates = [...document.querySelectorAll(".methodology-import-candidates > li")];
            const selected = [...document.querySelectorAll('.methodology-import-candidates input[type="checkbox"]:checked')];
            const safety = document.querySelector(".methodology-import-safety");
            const submit = [...document.querySelectorAll("button")].find(
              (button) => button.textContent?.trim().startsWith("导入 1 条候选")
            );
            if (dialog === null || preview === null || summary.length !== 4 ||
                candidates.length === 0 || safety === null || submit === undefined) {
              if (Date.now() >= deadline) return reject(new Error("Methodology import preview did not render"));
              setTimeout(measurePreview, 16);
              return;
            }
            requestAnimationFrame(() => requestAnimationFrame(() => {
              const dialogRect = dialog.getBoundingClientRect();
              const submitRect = submit.getBoundingClientRect();
              resolve({
                methodologyImportPreviewCentered:
                  Math.abs(dialogRect.top + dialogRect.height / 2 - innerHeight / 2) < 2,
                methodologyImportPreviewInsideDialog:
                  dialog.contains(preview) && dialog.contains(safety),
                methodologyImportPreviewSummaryCount: summary.length,
                methodologyImportPreviewCandidateCount: candidates.length,
                methodologyImportPreviewSelectedCount: selected.length,
                methodologyImportPreviewActionVisible:
                  submitRect.top >= dialogRect.top && submitRect.bottom <= dialogRect.bottom,
                methodologyImportPreviewSafetyVisible:
                  safety.textContent?.includes("不会自动采纳") === true,
                methodologyImportPreviewHorizontalOverflow:
                  preview.scrollWidth > preview.clientWidth + 1,
              });
            }));
          };
          measurePreview();
          };
          chooseImport();
        };
        openPreview();
      })
    `);
  } else if (interaction === "methodology-import-detail") {
    interactionMetrics = await window.webContents.executeJavaScript(`
      new Promise((resolve, reject) => {
        const deadline = Date.now() + 12000;
        let list = document.querySelector(".methodology-list");
        let listHeightBefore = list?.getBoundingClientRect().height ?? 0;
        const importCandidate = () => {
          const action = document.querySelector(".methodology-create-button");
          if (action === null) {
            if (Date.now() >= deadline) {
              reject(new Error("Methodology create action did not render"));
              return;
            }
            setTimeout(importCandidate, 16);
            return;
          }
          action.click();
          const chooseImport = () => {
            const option = document.querySelector(".methodology-import-button");
            if (option === null) {
              if (Date.now() >= deadline) return reject(new Error("Methodology import option did not render"));
              setTimeout(chooseImport, 16);
              return;
            }
            option.click();
          const confirmPreview = () => {
            const confirm = [...document.querySelectorAll("button")].find(
              (button) => button.textContent?.trim().startsWith("导入 1 条候选")
            );
            if (confirm === undefined) {
              if (Date.now() >= deadline) {
                reject(new Error("Methodology import preview did not render"));
                return;
              }
              setTimeout(confirmPreview, 16);
              return;
            }
            confirm.click();
            openImported();
          };
          const openImported = () => {
            const rows = [...document.querySelectorAll(".methodology-row")];
            const row = rows.find((candidate) =>
              candidate.textContent?.includes("先保留回退路径")
            );
            if (row === undefined) {
              if (Date.now() >= deadline) {
                reject(new Error("Imported methodology row did not render"));
                return;
              }
              setTimeout(openImported, 16);
              return;
            }
            list = document.querySelector(".methodology-list");
            listHeightBefore = list?.getBoundingClientRect().height ?? 0;
            row.click();
            const measureImported = () => {
              const dialog = document.querySelector('[role="dialog"]');
              const detail = document.querySelector(".methodology-detail");
              const sourceNote = document.querySelector(
                ".methodology-import-evidence-note"
              );
              const provenance = document.querySelector(
                ".methodology-import-provenance"
              );
              const importTag = row.querySelector(".methodology-row-title em.imported");
              const accept = [...document.querySelectorAll("button")].find(
                (button) => button.textContent?.trim() === "采纳为假设"
              );
              if (dialog === null || detail === null || sourceNote === null ||
                  provenance === null ||
                  importTag === null || accept === undefined) {
                if (Date.now() >= deadline) {
                  reject(new Error("Imported methodology detail did not open"));
                  return;
                }
                setTimeout(measureImported, 16);
                return;
              }
              requestAnimationFrame(() => requestAnimationFrame(() => {
                const dialogRect = dialog.getBoundingClientRect();
                const noteRect = sourceNote.getBoundingClientRect();
                resolve({
                  methodologyImportDetailCentered:
                    Math.abs(dialogRect.top + dialogRect.height / 2 - innerHeight / 2) < 2,
                  methodologyImportDetailInsideDialog:
                    dialog.contains(detail) && dialog.contains(sourceNote),
                  methodologyImportSourceNoteVisible:
                    noteRect.top >= dialogRect.top && noteRect.top < dialogRect.bottom,
                  methodologyImportProvenanceVisible:
                    provenance.textContent?.includes("团队方法论.md") === true,
                  methodologyImportTagVisible:
                    importTag.getBoundingClientRect().width > 0,
                  methodologyImportAcceptVisible:
                    accept.getBoundingClientRect().bottom <= dialogRect.bottom,
                  methodologyListHeightStable:
                    list === null || Math.abs(list.getBoundingClientRect().height - listHeightBefore) < 1,
                });
              }));
            };
            measureImported();
          };
          confirmPreview();
          };
          chooseImport();
        };
        importCandidate();
      })
    `);
  } else if (interaction === "methodology-relation-queue") {
    interactionMetrics = await window.webContents.executeJavaScript(`
      new Promise((resolve, reject) => {
        const deadline = Date.now() + 12000;
        const openQueue = () => {
          const launcher = document.querySelector(".methodology-workbench-button");
          const list = document.querySelector(".methodology-list");
          if (launcher === null || launcher.disabled || list === null ||
              list.querySelector(".methodology-row") === null) {
            if (Date.now() >= deadline) return reject(new Error("Relationship queue action did not render"));
            setTimeout(openQueue, 16);
            return;
          }
          const listHeightBefore = list.getBoundingClientRect().height;
          launcher.click();
          const openWorkItem = () => {
            const action = document.querySelector(".methodology-relations-button");
            if (action === null || action.disabled) {
              if (Date.now() >= deadline) return reject(new Error("Relationship queue workbench item did not render"));
              setTimeout(openWorkItem, 16);
              return;
            }
            action.click();
            measureQueue();
          };
          const measureQueue = () => {
            const dialog = document.querySelector('[role="dialog"]');
            const queue = document.querySelector(".methodology-relation-queue");
            const comparison = document.querySelector(".methodology-relation-comparison");
            const cards = [...document.querySelectorAll(".methodology-relation-comparison article")];
            const options = [...document.querySelectorAll(".methodology-relation-queue-options label")];
            const note = document.querySelector(".methodology-relation-queue-note textarea");
            const safety = document.querySelector(".methodology-relation-queue-safety");
            const progress = document.querySelector('.methodology-relation-queue progress');
            const save = [...document.querySelectorAll("button")].find(
              (button) => button.textContent?.trim() === "保存并继续"
            );
            if (dialog === null || queue === null || comparison === null ||
                cards.length !== 2 || options.length !== 3 || note === null ||
                safety === null || progress === null || save === undefined) {
              if (Date.now() >= deadline) return reject(new Error("Relationship queue did not render"));
              setTimeout(measureQueue, 16);
              return;
            }
            requestAnimationFrame(() => requestAnimationFrame(() => {
              const dialogRect = dialog.getBoundingClientRect();
              const queueRect = queue.getBoundingClientRect();
              const cardTops = cards.map((card) => card.getBoundingClientRect().top);
              const optionTops = options.map((option) => option.getBoundingClientRect().top);
              resolve({
                methodologyRelationQueueCentered:
                  Math.abs(dialogRect.top + dialogRect.height / 2 - innerHeight / 2) < 2,
                methodologyRelationQueueInsideDialog:
                  dialog.contains(queue) && queueRect.bottom <= dialogRect.bottom,
                methodologyRelationQueueComparisonCount: cards.length,
                methodologyRelationQueueComparisonSingleRow:
                  cardTops.every((top) => Math.abs(top - cardTops[0]) < 1),
                methodologyRelationQueueOptionCount: options.length,
                methodologyRelationQueueOptionsSingleRow:
                  optionTops.every((top) => Math.abs(top - optionTops[0]) < 1),
                methodologyRelationQueueProgressVisible:
                  progress.getBoundingClientRect().width > 0,
                methodologyRelationQueueNoteVisible:
                  note.getBoundingClientRect().bottom <= dialogRect.bottom,
                methodologyRelationQueueSafetyVisible:
                  safety.getBoundingClientRect().bottom <= dialogRect.bottom,
                methodologyRelationQueueSaveVisible:
                  save.getBoundingClientRect().bottom <= dialogRect.bottom,
                methodologyListHeightStable:
                  list === null || Math.abs(list.getBoundingClientRect().height - listHeightBefore) < 1,
              });
            }));
          };
          openWorkItem();
        };
        openQueue();
      })
    `);
  } else if (interaction === "methodology-usage") {
    interactionMetrics = await window.webContents.executeJavaScript(`
      new Promise((resolve, reject) => {
        const deadline = Date.now() + 12000;
        const openAccepted = () => {
          const accepted = [...document.querySelectorAll(
            ".methodology-status-filter button"
          )].find((button) => button.textContent?.trim() === "已采纳");
          if (accepted === undefined) {
            if (Date.now() >= deadline) {
              reject(new Error("Accepted methodology filter did not render"));
              return;
            }
            setTimeout(openAccepted, 16);
            return;
          }
          accepted.click();
          const openDetail = () => {
            const acceptedStatus = document.querySelector(
              ".methodology-row .methodology-status.accepted"
            );
            const row = acceptedStatus?.closest(".methodology-row") ?? null;
            const list = document.querySelector(".methodology-list");
            if (row === null || list === null) {
              if (Date.now() >= deadline) {
                reject(new Error("Accepted methodology row did not render"));
                return;
              }
              setTimeout(openDetail, 16);
              return;
            }
            const listHeightBefore = list.getBoundingClientRect().height;
            row.click();
            const measureUsage = () => {
              const dialog = document.querySelector('[role="dialog"]');
              const usage = document.querySelector(".methodology-usage-section");
              const metrics = [...document.querySelectorAll(
                ".methodology-usage-metrics > div"
              )];
              const causality = document.querySelector(
                ".methodology-usage-causality"
              );
              const records = document.querySelector(
                ".methodology-usage-decisions"
              );
              if (dialog === null || usage === null || metrics.length !== 4 ||
                  causality === null || records === null) {
                if (Date.now() >= deadline) {
                  reject(new Error("Methodology usage distribution did not render"));
                  return;
                }
                setTimeout(measureUsage, 16);
                return;
              }
              records.open = true;
              requestAnimationFrame(() => requestAnimationFrame(() => {
                const dialogRect = dialog.getBoundingClientRect();
                const controls = document.querySelector(
                  ".methodology-usage-controls"
                );
                const filters = [...document.querySelectorAll(
                  ".methodology-usage-filters button"
                )];
                const recordActions = document.querySelectorAll(
                  ".methodology-usage-decisions li > button"
                );
                const nextAction = document.querySelector(
                  ".methodology-usage-next button"
                );
                resolve({
                  methodologyUsageCentered:
                    Math.abs(dialogRect.top + dialogRect.height / 2 - innerHeight / 2) < 2,
                  methodologyUsageInsideDialog: dialog.contains(usage),
                  methodologyUsageMetricCount: metrics.length,
                  methodologyUsageMetricsSingleRow:
                    new Set(metrics.map((metric) =>
                      Math.round(metric.getBoundingClientRect().top)
                    )).size === 1,
                  methodologyUsageCausalityVisible:
                    causality.textContent?.includes("不能单独证明") === true,
                  methodologyUsageHorizontalOverflow:
                    usage.scrollWidth > usage.clientWidth,
                  methodologyUsageControlsInsideDialog:
                    controls !== null && dialog.contains(controls),
                  methodologyUsageFilterCount: filters.length,
                  methodologyUsageFiltersSingleRow:
                    filters.length === 5 &&
                    new Set(filters.map((filter) =>
                      Math.round(filter.getBoundingClientRect().top)
                    )).size === 1,
                  methodologyUsageRecordActionCount: recordActions.length,
                  methodologyUsageNextActionVisible:
                    nextAction !== null && nextAction.getBoundingClientRect().width > 0,
                  methodologyListHeightStable:
                    Math.abs(list.getBoundingClientRect().height - listHeightBefore) < 1,
                });
              }));
            };
            measureUsage();
          };
          openDetail();
        };
        openAccepted();
      })
    `);
  } else if (
    interaction === "methodology-evolution" ||
    interaction === "methodology-evolution-recovery" ||
    interaction === "methodology-evolution-rebase"
  ) {
    interactionMetrics = await window.webContents.executeJavaScript(`
      new Promise((resolve, reject) => {
        const deadline = Date.now() + 12000;
        const openAccepted = () => {
          const accepted = [...document.querySelectorAll(
            ".methodology-status-filter button"
          )].find((button) => button.textContent?.trim() === "已采纳");
          if (accepted === undefined) {
            if (Date.now() >= deadline) {
              reject(new Error("Accepted methodology filter did not render"));
              return;
            }
            setTimeout(openAccepted, 16);
            return;
          }
          accepted.click();
          const openDetail = () => {
            const acceptedStatus = document.querySelector(
              ".methodology-row .methodology-status.accepted"
            );
            const row = acceptedStatus?.closest(".methodology-row") ?? null;
            const list = document.querySelector(".methodology-list");
            if (row === null || list === null) {
              if (Date.now() >= deadline) {
                reject(new Error("Accepted methodology row did not render"));
                return;
              }
              setTimeout(openDetail, 16);
              return;
            }
            const listHeightBefore = list.getBoundingClientRect().height;
            row.click();
            const startEvolution = () => {
              const action = document.querySelector(
                ".methodology-evolution-ready button"
              );
              if (action === null) {
                if (Date.now() >= deadline) {
                  reject(new Error("Methodology evolution action did not render"));
                  return;
                }
                setTimeout(startEvolution, 16);
                return;
              }
              action.click();
              let recoveryStarted = false;
              const measureEvolution = () => {
                const dialog = document.querySelector('[role="dialog"]');
                const editor = document.querySelector(
                  ".methodology-evolution-editor"
                );
                const headerCards = [...document.querySelectorAll(
                  ".methodology-evolution-editor > header > *"
                )];
                const fields = [...document.querySelectorAll(
                  ".methodology-evolution-form > label"
                )];
                const evidence = [...document.querySelectorAll(
                  ".methodology-evolution-evidence button"
                )];
                const boundary = [...document.querySelectorAll(
                  ".methodology-evolution-boundary > span"
                )];
                const save = [...document.querySelectorAll(
                  ".methodology-evolution-editor > footer button"
                )].find((button) => button.textContent?.includes("保存为修订候选"));
                if (dialog === null || editor === null || fields.length !== 5 ||
                    evidence.length < 2 || boundary.length !== 3 || save === undefined) {
                  if (Date.now() >= deadline) {
                    reject(new Error("Methodology evolution editor did not render"));
                    return;
                  }
                  setTimeout(measureEvolution, 16);
                  return;
                }
                const measureRebase = () => {
                  const rebase = document.querySelector(
                    ".methodology-revision-rebase"
                  );
                  const rebaseDialog = rebase?.closest('[role="dialog"]') ?? null;
                  const rebaseFields = [...document.querySelectorAll(
                    ".methodology-revision-rebase-fields > section"
                  )];
                  const firstColumns = rebaseFields[0] === undefined
                    ? []
                    : [...rebaseFields[0].querySelectorAll(":scope > div > *")];
                  const unresolved = [...document.querySelectorAll(
                    ".methodology-revision-rebase-fields > section > header span"
                  )].some((item) =>
                    item.textContent?.includes("当前版本和草稿都已修改") === true
                  );
                  const rebaseAction = [...document.querySelectorAll(
                    ".methodology-revision-rebase-actions button"
                  )].find((button) =>
                    button.textContent?.trim() === "迁移并继续编辑"
                  );
                  const rebaseFooter = document.querySelector(
                    ".methodology-revision-rebase-actions"
                  );
                  if (rebase === null || rebaseDialog === null ||
                      rebaseFields.length < 2 || firstColumns.length !== 3 ||
                      !unresolved || rebaseAction === undefined || rebaseFooter === null) {
                    if (Date.now() >= deadline) {
                      reject(new Error("Revision rebase dialog did not render"));
                      return;
                    }
                    setTimeout(measureRebase, 16);
                    return;
                  }
                  requestAnimationFrame(() => requestAnimationFrame(() => {
                    const dialogRect = rebaseDialog.getBoundingClientRect();
                    resolve({
                      methodologyEvolutionRebaseCentered:
                        Math.abs(dialogRect.top + dialogRect.height / 2 - innerHeight / 2) < 2,
                      methodologyEvolutionRebaseInsideDialog:
                        rebaseDialog.contains(rebase),
                      methodologyEvolutionRebaseFieldCount: rebaseFields.length,
                      methodologyEvolutionRebaseColumnsAligned:
                        new Set(firstColumns.map((column) =>
                          Math.round(column.getBoundingClientRect().top)
                        )).size === 1,
                      methodologyEvolutionRebaseUnresolvedVisible: unresolved,
                      methodologyEvolutionRebaseActionDisabled: rebaseAction.disabled,
                      methodologyEvolutionRebaseFooterVisible:
                        rebaseFooter.getBoundingClientRect().bottom <= dialogRect.bottom + 1,
                      methodologyEvolutionRebaseHorizontalOverflow:
                        rebase.scrollWidth > rebase.clientWidth,
                      methodologyListHeightStable:
                        Math.abs(list.getBoundingClientRect().height - listHeightBefore) < 1,
                    });
                  }));
                };
                if (
                  "${interaction}" === "methodology-evolution-recovery" ||
                  "${interaction}" === "methodology-evolution-rebase"
                ) {
                  if (!recoveryStarted) {
                    const title = document.querySelector(
                      ".methodology-evolution-form input"
                    );
                    const back = [...document.querySelectorAll(
                      ".methodology-evolution-editor > footer button"
                    )].find((button) => button.textContent?.trim() === "返回详情");
                    if (title === null || back === undefined) {
                      if (Date.now() >= deadline) return reject(new Error("Revision recovery controls did not render"));
                      setTimeout(measureEvolution, 16);
                      return;
                    }
                    recoveryStarted = true;
                    const valueSetter = Object.getOwnPropertyDescriptor(
                      HTMLInputElement.prototype,
                      "value"
                    )?.set;
                    valueSetter?.call(title, "恢复后的修订原则");
                    title.dispatchEvent(new Event("input", { bubbles: true }));
                    setTimeout(() => {
                      back.click();
                      const closeDetail = () => {
                        const close = document.querySelector(
                          '.modal-dialog-close[aria-label="关闭方法论详情"]'
                        );
                        if (close === null) {
                          if (Date.now() >= deadline) return reject(new Error("Revision detail did not return"));
                          setTimeout(closeDetail, 16);
                          return;
                        }
                        close.click();
                        const resume = () => {
                          const resumeAction = [...document.querySelectorAll("button")].find(
                            (button) => button.textContent?.trim() === "继续修订"
                          );
                          if (resumeAction === undefined) {
                            if (Date.now() >= deadline) return reject(new Error("Revision recovery action did not render"));
                            setTimeout(resume, 16);
                            return;
                          }
                          resumeAction.click();
                          setTimeout(
                            "${interaction}" === "methodology-evolution-rebase"
                              ? measureRebase
                              : measureEvolution,
                            16
                          );
                        };
                        resume();
                      };
                      closeDetail();
                    }, 16);
                    return;
                  }
                  const status = document.querySelector(
                    ".methodology-evolution-editor > header aside small"
                  );
                  const recoveryNotice = document.querySelector(
                    ".methodology-evolution-boundary.recovered"
                  );
                  const recoveredTitle = document.querySelector(
                    ".methodology-evolution-form input"
                  );
                  const actions = [...document.querySelectorAll(
                    ".methodology-evolution-editor > footer button"
                  )];
                  if (status === null || recoveryNotice === null || recoveredTitle === null ||
                      actions.length !== 3) {
                    if (Date.now() >= deadline) return reject(new Error("Recovered revision editor did not render"));
                    setTimeout(measureEvolution, 16);
                    return;
                  }
                  requestAnimationFrame(() => requestAnimationFrame(() => {
                    const dialogRect = dialog.getBoundingClientRect();
                    resolve({
                      methodologyEvolutionCentered:
                        Math.abs(dialogRect.top + dialogRect.height / 2 - innerHeight / 2) < 2,
                      methodologyEvolutionInsideDialog: dialog.contains(editor),
                      methodologyEvolutionRecoveryStatusVisible:
                        status.textContent?.includes("已恢复") === true,
                      methodologyEvolutionRecoveryNoticeVisible:
                        recoveryNotice.getBoundingClientRect().height > 0,
                      methodologyEvolutionRecoveryTitleRestored:
                        recoveredTitle.value === "恢复后的修订原则",
                      methodologyEvolutionRecoveryActionsVisible:
                        actions.every((button) =>
                          button.getBoundingClientRect().bottom <= dialogRect.bottom
                        ),
                      methodologyEvolutionHorizontalOverflow:
                        editor.scrollWidth > editor.clientWidth,
                      methodologyListHeightStable:
                        Math.abs(list.getBoundingClientRect().height - listHeightBefore) < 1,
                    });
                  }));
                  return;
                }
                requestAnimationFrame(() => requestAnimationFrame(() => {
                  const dialogRect = dialog.getBoundingClientRect();
                  const selectedNew = evidence.some((button) =>
                    button.getAttribute("aria-pressed") === "true" &&
                    button.textContent?.includes("采用后新复盘") === true
                  );
                  resolve({
                    methodologyEvolutionCentered:
                      Math.abs(dialogRect.top + dialogRect.height / 2 - innerHeight / 2) < 2,
                    methodologyEvolutionInsideDialog: dialog.contains(editor),
                    methodologyEvolutionHeaderSingleRow:
                      headerCards.length === 2 &&
                      new Set(headerCards.map((card) =>
                        Math.round(card.getBoundingClientRect().top)
                      )).size === 1,
                    methodologyEvolutionFieldCount: fields.length,
                    methodologyEvolutionBoundaryCount: boundary.length,
                    methodologyEvolutionEvidenceCount: evidence.length,
                    methodologyEvolutionNewEvidenceSelected: selectedNew,
                    methodologyEvolutionSaveVisible:
                      save.getBoundingClientRect().width > 0 &&
                      save.getBoundingClientRect().bottom <= dialogRect.bottom,
                    methodologyEvolutionHorizontalOverflow:
                      editor.scrollWidth > editor.clientWidth,
                    methodologyListHeightStable:
                      Math.abs(list.getBoundingClientRect().height - listHeightBefore) < 1,
                  });
                }));
              };
              measureEvolution();
            };
            startEvolution();
          };
          openDetail();
        };
        openAccepted();
      })
    `);
  } else if (
    interaction === "methodology-evidence-link" ||
    interaction === "methodology-evidence-match"
  ) {
    interactionMetrics = await window.webContents.executeJavaScript(`
      new Promise((resolve, reject) => {
        const deadline = Date.now() + 12000;
        let list = document.querySelector(".methodology-list");
        let listHeightBefore = list?.getBoundingClientRect().height ?? 0;
        const begin = () => {
          const importAction = document.querySelector(".methodology-create-button");
          if (importAction === null) {
            if (Date.now() >= deadline) {
              reject(new Error("Methodology create action did not render"));
              return;
            }
            setTimeout(begin, 16);
            return;
          }
          importAction.click();
          const chooseImport = () => {
            const option = document.querySelector(".methodology-import-button");
            if (option === null) {
              if (Date.now() >= deadline) return reject(new Error("Methodology import option did not render"));
              setTimeout(chooseImport, 16);
              return;
            }
            option.click();
          const confirmPreview = () => {
            const confirm = [...document.querySelectorAll("button")].find(
              (button) => button.textContent?.trim().startsWith("导入 1 条候选")
            );
            if (confirm === undefined) {
              if (Date.now() >= deadline) {
                reject(new Error("Methodology import preview did not render"));
                return;
              }
              setTimeout(confirmPreview, 16);
              return;
            }
            confirm.click();
            openDetail();
          };
          const openDetail = () => {
            const row = [...document.querySelectorAll(".methodology-row")].find(
              (candidate) => candidate.textContent?.includes("先保留回退路径")
            );
            if (row === undefined) {
              if (Date.now() >= deadline) {
                reject(new Error("Imported methodology row did not render"));
                return;
              }
              setTimeout(openDetail, 16);
              return;
            }
            list = document.querySelector(".methodology-list");
            listHeightBefore = list?.getBoundingClientRect().height ?? 0;
            row.click();
            const openChooser = () => {
              const link = [...document.querySelectorAll("button")].find(
                (button) => button.textContent?.trim() === "关联复盘证据"
              );
              if (link === undefined) {
                if (Date.now() >= deadline) {
                  reject(new Error("Evidence link action did not render"));
                  return;
                }
                setTimeout(openChooser, 16);
                return;
              }
              link.click();
              const saveLinks = () => {
                const dialog = document.querySelector('[role="dialog"]');
                const chooser = document.querySelector(".methodology-source-chooser");
                const sourceList = document.querySelector(".methodology-source-list");
                const checkboxes = [
                  ...document.querySelectorAll('.methodology-source-list input[type="checkbox"]')
                ];
                const save = [...document.querySelectorAll("button")].find(
                  (button) => button.textContent?.trim() === "保存证据关联"
                );
                if (dialog === null || chooser === null || sourceList === null ||
                    checkboxes.length < 2 || save === undefined) {
                  if (Date.now() >= deadline) {
                    reject(new Error("Evidence link chooser did not open"));
                    return;
                  }
                  setTimeout(saveLinks, 16);
                  return;
                }
                if ("${interaction}" === "methodology-evidence-match") {
                  const matchPicker = document.querySelector(
                    ".methodology-evidence-match-picker"
                  );
                  const matchButtons = matchPicker?.querySelectorAll("ol button") ?? [];
                  const search = document.querySelector(
                    '.methodology-source-search input[type="search"]'
                  );
                  if (matchPicker === null || matchButtons.length === 0 || search === null) {
                    if (Date.now() >= deadline) {
                      reject(new Error("Evidence matching suggestions did not render"));
                      return;
                    }
                    setTimeout(saveLinks, 16);
                    return;
                  }
                  requestAnimationFrame(() => requestAnimationFrame(() => {
                    const dialogRect = dialog.getBoundingClientRect();
                    const pickerRect = matchPicker.getBoundingClientRect();
                    const listRect = sourceList.getBoundingClientRect();
                    resolve({
                      methodologyEvidenceMatchCentered:
                        Math.abs(dialogRect.top + dialogRect.height / 2 - innerHeight / 2) < 2,
                      methodologyEvidenceMatchInsideDialog:
                        dialog.contains(chooser) && dialog.contains(matchPicker),
                      methodologyEvidenceMatchCount: matchButtons.length,
                      methodologyEvidenceMatchReasonVisible:
                        [...matchPicker.querySelectorAll("small")].every(
                          (item) => item.getBoundingClientRect().height > 0
                        ),
                      methodologyEvidenceSearchVisible:
                        search.getBoundingClientRect().bottom <= dialogRect.bottom,
                      methodologyEvidenceSourceListInsideDialog:
                        listRect.top >= dialogRect.top && listRect.bottom <= dialogRect.bottom,
                      methodologyEvidenceMatchCompact:
                        pickerRect.height <= 38 + matchButtons.length * 52 + 2,
                      methodologyEvidenceSuggestionsHidden:
                        document.querySelector(".methodology-suggestion-picker") === null,
                      methodologyListHeightStable:
                        list === null || Math.abs(list.getBoundingClientRect().height - listHeightBefore) < 1,
                    });
                  }));
                  return;
                }
                checkboxes[0].click();
                checkboxes[1].click();
                requestAnimationFrame(() => {
                  save.click();
                  const measureLinked = () => {
                    const linkedDialog = document.querySelector('[role="dialog"]');
                    const detail = document.querySelector(".methodology-detail");
                    const evidence = document.querySelector(".methodology-evidence-section");
                    const adjust = document.querySelector(
                      ".methodology-evidence-link-actions.detached"
                    );
                    if (linkedDialog === null || detail === null || evidence === null ||
                        adjust === null) {
                      if (Date.now() >= deadline) {
                        reject(new Error("Linked methodology detail did not return"));
                        return;
                      }
                      setTimeout(measureLinked, 16);
                      return;
                    }
                    requestAnimationFrame(() => requestAnimationFrame(() => {
                      const dialogRect = linkedDialog.getBoundingClientRect();
                      resolve({
                        methodologyEvidenceLinkCentered:
                          Math.abs(dialogRect.top + dialogRect.height / 2 - innerHeight / 2) < 2,
                        methodologyEvidenceLinkInsideDialog:
                          linkedDialog.contains(detail) && linkedDialog.contains(evidence),
                        methodologyEvidenceLinkCount:
                          evidence.querySelectorAll("li").length,
                        methodologyEvidenceAdjustVisible:
                          adjust.getBoundingClientRect().bottom <= dialogRect.bottom,
                        methodologyEvidenceSuggestionsHidden:
                          document.querySelector(".methodology-suggestion-picker") === null,
                        methodologyListHeightStable:
                          list === null || Math.abs(list.getBoundingClientRect().height - listHeightBefore) < 1,
                      });
                    }));
                  };
                  measureLinked();
                });
              };
              saveLinks();
            };
            openChooser();
          };
          confirmPreview();
          };
          chooseImport();
        };
        begin();
      })
    `);
  } else if (
    interaction === "methodology-detail" ||
    interaction === "methodology-relation-review" ||
    interaction === "methodology-quality-confirm"
  ) {
    interactionMetrics = await window.webContents.executeJavaScript(`
      new Promise((resolve, reject) => {
        const deadline = Date.now() + 12000;
        const openDetail = () => {
          const row = document.querySelector(".methodology-row");
          const list = document.querySelector(".methodology-list");
          if (row === null || list === null) {
            if (Date.now() >= deadline) {
              reject(new Error("Methodology row did not render"));
              return;
            }
            setTimeout(openDetail, 16);
            return;
          }
          const listHeightBefore = list.getBoundingClientRect().height;
          row.click();
          const measureDetail = () => {
            const dialog = document.querySelector('[role="dialog"]');
            const detail = document.querySelector(".methodology-detail");
            const evidence = document.querySelector(".methodology-evidence-section");
            const quality = document.querySelector(".methodology-quality-section");
            const relations = document.querySelectorAll(".methodology-relation-list li");
            const accept = [...document.querySelectorAll("button")].find(
              (button) => ["采纳原则", "检查后采纳"].includes(
                button.textContent?.trim() ?? ""
              )
            );
            if (dialog === null || detail === null || evidence === null ||
                quality === null || accept === undefined) {
              if (Date.now() >= deadline) {
                reject(new Error("Methodology detail did not open"));
                return;
              }
              setTimeout(measureDetail, 16);
              return;
            }
            if ("${interaction}" === "methodology-quality-confirm") {
              accept.click();
              const measureConfirmation = () => {
                const confirmation = document.querySelector(
                  ".methodology-acceptance-confirmation"
                );
                const confirmAction = [...document.querySelectorAll("button")]
                  .find((button) =>
                    button.textContent?.trim() === "确认仍然采纳"
                  );
                if (confirmation === null || confirmAction === undefined) {
                  if (Date.now() >= deadline) {
                    reject(new Error("Methodology quality confirmation did not open"));
                    return;
                  }
                  setTimeout(measureConfirmation, 16);
                  return;
                }
                requestAnimationFrame(() => requestAnimationFrame(() => {
                  const dialogRect = dialog.getBoundingClientRect();
                  const confirmationRect = confirmation.getBoundingClientRect();
                  resolve({
                    methodologyDetailCentered:
                      Math.abs(dialogRect.top + dialogRect.height / 2 - innerHeight / 2) < 2,
                    methodologyQualityConfirmationVisible:
                      confirmationRect.top >= dialogRect.top &&
                      confirmationRect.bottom <= dialogRect.bottom,
                    methodologyQualityConfirmActionVisible:
                      confirmAction.getBoundingClientRect().bottom <= dialogRect.bottom,
                    methodologyListHeightStable:
                      Math.abs(list.getBoundingClientRect().height - listHeightBefore) < 1,
                  });
                }));
              };
              measureConfirmation();
              return;
            }
            if ("${interaction}" === "methodology-relation-review") {
              const review = [...document.querySelectorAll("button")].find(
                (button) => button.textContent?.trim() === "核对关系"
              );
              if (review === undefined) {
                if (Date.now() >= deadline) {
                  reject(new Error("Methodology relation review action did not render"));
                  return;
                }
                setTimeout(measureDetail, 16);
                return;
              }
              review.click();
              const measureRelationEditor = () => {
                const relationDialog = document.querySelector('[role="dialog"]');
                const editor = document.querySelector(".methodology-relation-editor");
                const options = document.querySelectorAll(
                  '.methodology-relation-options input[type="radio"]'
                );
                const note = document.querySelector(
                  ".methodology-relation-note textarea"
                );
                const safety = document.querySelector(
                  ".methodology-relation-safety-copy"
                );
                const save = [...document.querySelectorAll("button")].find(
                  (button) => button.textContent?.trim() === "保存关系结论"
                );
                if (relationDialog === null || editor === null ||
                    options.length !== 3 || note === null || safety === null ||
                    save === undefined) {
                  if (Date.now() >= deadline) {
                    reject(new Error("Methodology relation review dialog did not open"));
                    return;
                  }
                  setTimeout(measureRelationEditor, 16);
                  return;
                }
                requestAnimationFrame(() => requestAnimationFrame(() => {
                  const relationRect = relationDialog.getBoundingClientRect();
                  const optionRects = [...document.querySelectorAll(
                    ".methodology-relation-options > label"
                  )].map((item) => item.getBoundingClientRect());
                  resolve({
                    methodologyRelationDialogCentered:
                      Math.abs(relationRect.top + relationRect.height / 2 - innerHeight / 2) < 2,
                    methodologyRelationEditorInsideDialog:
                      relationDialog.contains(editor),
                    methodologyRelationOptionCount: options.length,
                    methodologyRelationOptionsSingleColumn:
                      optionRects.every((rect, index) =>
                        index === 0 || rect.top > optionRects[index - 1].top
                      ),
                    methodologyRelationNoteVisible:
                      note.getBoundingClientRect().bottom <= relationRect.bottom,
                    methodologyRelationSafetyCopyVisible:
                      safety.getBoundingClientRect().height > 0,
                    methodologyRelationSaveVisible:
                      save.getBoundingClientRect().bottom <= relationRect.bottom,
                    methodologyListHeightStable:
                      Math.abs(list.getBoundingClientRect().height - listHeightBefore) < 1,
                  });
                }));
              };
              measureRelationEditor();
              return;
            }
            requestAnimationFrame(() => requestAnimationFrame(() => {
              const dialogRect = dialog.getBoundingClientRect();
              resolve({
                methodologyDetailCentered:
                  Math.abs(dialogRect.top + dialogRect.height / 2 - innerHeight / 2) < 2,
                methodologyDetailInsideDialog: dialog.contains(detail),
                methodologyEvidenceCount: evidence.querySelectorAll("li").length,
                methodologyQualityVisible:
                  quality.getBoundingClientRect().top >= dialogRect.top &&
                  quality.getBoundingClientRect().top < dialogRect.bottom,
                methodologyRelationCount: relations.length,
                methodologyAcceptVisible:
                  accept.getBoundingClientRect().bottom <= dialogRect.bottom,
                methodologyListHeightStable:
                  Math.abs(list.getBoundingClientRect().height - listHeightBefore) < 1,
              });
            }));
          };
          measureDetail();
        };
        openDetail();
      })
    `);
  } else if (interaction === "methodology-consultation") {
    interactionMetrics = await window.webContents.executeJavaScript(`
      new Promise((resolve, reject) => {
        const deadline = Date.now() + 12000;
        const openAnalysis = () => {
          const action = [...document.querySelectorAll("button")].find(
            (button) => button.textContent?.trim() === "分析"
          );
          if (action === undefined) {
            if (Date.now() >= deadline) return reject(new Error("Analytics action did not render"));
            setTimeout(openAnalysis, 16);
            return;
          }
          action.click();
          openPreview();
        };
        const openPreview = () => {
          const action = [...document.querySelectorAll("button")].find(
            (button) => button.textContent?.trim() === "试算一次"
          );
          if (action === undefined) {
            if (Date.now() >= deadline) return reject(new Error("Consultation preview action did not render"));
            setTimeout(openPreview, 16);
            return;
          }
          action.click();
          runPreview();
        };
        const runPreview = () => {
          const question = document.querySelector('.consultation-preview textarea[required]');
          const submit = [...document.querySelectorAll(".consultation-preview-actions button")].find(
            (button) => button.textContent?.trim() === "查看实际结果"
          );
          if (question === null || submit === undefined) {
            if (Date.now() >= deadline) return reject(new Error("Consultation preview form did not render"));
            setTimeout(runPreview, 16);
            return;
          }
          const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
          setter?.call(question, "上线前是否先验证关键边界？");
          question.dispatchEvent(new Event("input", { bubbles: true }));
          const submitWhenReady = () => {
            if (submit.disabled) {
              if (Date.now() >= deadline) return reject(new Error("Consultation preview did not become submittable"));
              setTimeout(submitWhenReady, 16);
              return;
            }
            submit.click();
            measure();
          };
          submitWhenReady();
        };
        const measure = () => {
          const dialog = document.querySelector('[role="dialog"]');
          const preview = document.querySelector(".consultation-preview");
          const fields = [...document.querySelectorAll(".consultation-preview-fields > label, .consultation-preview-fields > fieldset")];
          const options = [...document.querySelectorAll(".consultation-preview-options > div")];
          const actions = [...document.querySelectorAll(".consultation-preview-actions button")];
          const feedback = document.querySelector(".consultation-preview-feedback");
          const feedbackButtons = [...document.querySelectorAll('.consultation-preview-feedback [role="group"] button')];
          const body = dialog?.querySelector(".modal-dialog-body");
          if (dialog === null || preview === null || fields.length !== 3 ||
              options.length !== 2 || actions.length !== 2 || feedback === null ||
              feedbackButtons.length !== 3) {
            if (Date.now() >= deadline) return reject(new Error("Consultation preview did not render"));
            setTimeout(measure, 16);
            return;
          }
          requestAnimationFrame(() => requestAnimationFrame(() => {
            const dialogRect = dialog.getBoundingClientRect();
            resolve({
              consultationPreviewCentered:
                Math.abs(dialogRect.top + dialogRect.height / 2 - innerHeight / 2) < 2,
              consultationPreviewInsideDialog: dialog.contains(preview),
              consultationPreviewFieldCount: fields.length,
              consultationPreviewOptionCount: options.length,
              consultationPreviewOptionsSingleRow:
                options.every((item) => Math.abs(
                  item.getBoundingClientRect().top - options[0].getBoundingClientRect().top
                ) < 1),
              consultationPreviewActionsSingleRow:
                actions.every((item) => Math.abs(
                  item.getBoundingClientRect().top - actions[0].getBoundingClientRect().top
                ) < 1),
              consultationPreviewBoundaryVisible:
                preview.textContent.includes("不调用模型") &&
                preview.textContent.includes("不写入决策"),
              consultationPreviewFeedbackVisible:
                feedback.getBoundingClientRect().height > 0 &&
                feedback.textContent.includes("只记录分类计数"),
              consultationPreviewFeedbackButtons: feedbackButtons.length,
              consultationPreviewFeedbackSingleRow:
                feedbackButtons.every((button) => Math.abs(
                  button.getBoundingClientRect().top -
                  feedbackButtons[0].getBoundingClientRect().top
                ) < 1),
              consultationPreviewHorizontalOverflow:
                body === null ? true : body.scrollWidth > body.clientWidth,
            });
          }));
        };
        openAnalysis();
      })
    `);
  } else if (interaction === "methodology-analysis") {
    interactionMetrics = await window.webContents.executeJavaScript(`
      new Promise((resolve, reject) => {
        const deadline = Date.now() + 12000;
        const openAnalysis = () => {
          const action = [...document.querySelectorAll("button")].find(
            (button) => button.textContent?.trim() === "分析"
          );
          if (action === undefined) {
            if (Date.now() >= deadline) return reject(new Error("Analytics action did not render"));
            setTimeout(openAnalysis, 16);
            return;
          }
          action.click();
          const measure = () => {
            const analytics = document.querySelector(".decision-analytics");
            const card = document.querySelector(".methodology-card");
            const summary = document.querySelector(".analytics-summary");
            const consultation = document.querySelector(".consultation-calibration");
            const consultationMetrics = [...document.querySelectorAll(".consultation-calibration dl > div")];
            const rows = [...document.querySelectorAll(".analytics-group-row")];
            const headers = [...document.querySelectorAll(".analytics-group-header")];
            const refresh = [...document.querySelectorAll("button")].find(
              (button) => button.textContent?.trim() === "刷新分析"
            );
            if (analytics === null || card === null || summary === null || consultation === null ||
                consultationMetrics.length !== 4 ||
                rows.length === 0 || headers.length === 0 || refresh === undefined) {
              if (Date.now() >= deadline) return reject(new Error("Analytics view did not render"));
              setTimeout(measure, 16);
              return;
            }
            requestAnimationFrame(() => requestAnimationFrame(() => {
              const analyticsRect = analytics.getBoundingClientRect();
              const cardRect = card.getBoundingClientRect();
              const headerColumns = [...headers[0].children].map(
                (child) => child.getBoundingClientRect().left
              );
              const rowsAligned = rows.every((row) => {
                const columns = [...row.children].map(
                  (child) => child.getBoundingClientRect().left
                );
                return columns.length === headerColumns.length && columns.every(
                  (left, index) => Math.abs(left - headerColumns[index]) < 1
                );
              });
              resolve({
                analyticsInsideCard:
                  analyticsRect.left >= cardRect.left && analyticsRect.right <= cardRect.right &&
                  analyticsRect.top >= cardRect.top && analyticsRect.bottom <= cardRect.bottom,
                analyticsHorizontalOverflow:
                  analytics.scrollWidth > analytics.clientWidth,
                analyticsSummaryCount: summary.children.length,
                consultationMetricsCount: consultationMetrics.length,
                consultationMetricsSingleRow: consultationMetrics.every(
                  (metric) => Math.abs(
                    metric.getBoundingClientRect().top -
                    consultationMetrics[0].getBoundingClientRect().top
                  ) < 1
                ),
                consultationInsideCard:
                  consultation.getBoundingClientRect().left >= cardRect.left &&
                  consultation.getBoundingClientRect().right <= cardRect.right,
                consultationPrivacyVisible:
                  consultation.textContent.includes("不保存输入、令牌或单次记录"),
                analyticsGroupColumnCount: headerColumns.length,
                analyticsGroupColumnsAligned: rowsAligned,
                analyticsRefreshVisible:
                  refresh.getBoundingClientRect().bottom <= innerHeight,
              });
            }));
          };
          measure();
        };
        openAnalysis();
      })
    `);
  } else if (interaction === "methodology-graph") {
    interactionMetrics = await window.webContents.executeJavaScript(`
      new Promise((resolve, reject) => {
        const deadline = Date.now() + 12000;
        const openGraph = () => {
          const action = [...document.querySelectorAll("button")].find(
            (button) => button.textContent?.trim() === "图谱"
          );
          if (action === undefined) {
            if (Date.now() >= deadline) {
              reject(new Error("Knowledge graph action did not render"));
              return;
            }
            setTimeout(openGraph, 16);
            return;
          }
          action.click();
          const measureGraph = () => {
            const graph = document.querySelector(".knowledge-graph");
            const card = document.querySelector(".methodology-card");
            const cluster = document.querySelector(".knowledge-graph-cluster");
            const evidence = document.querySelector(".knowledge-graph-evidence > li");
            const summary = document.querySelector(".knowledge-graph-summary");
            const toolbar = document.querySelector(".knowledge-graph-toolbar");
            const search = document.querySelector('.knowledge-graph-search input[type="search"]');
            const relation = document.querySelector(".knowledge-principle-relations li");
            const tabs = document.querySelectorAll('[role="tab"]');
            const graphTab = [...tabs].find(
              (button) => button.textContent?.trim() === "图谱"
            );
            if (graph === null || card === null || cluster === null ||
                evidence === null || summary === null || toolbar === null ||
                search === null || relation === null || graphTab === undefined) {
              if (Date.now() >= deadline) {
                reject(new Error("Knowledge graph did not render"));
                return;
              }
              setTimeout(measureGraph, 16);
              return;
            }
            requestAnimationFrame(() => requestAnimationFrame(() => {
              const graphRect = graph.getBoundingClientRect();
              const cardRect = card.getBoundingClientRect();
              const toolbarCenter = toolbar.getBoundingClientRect().top +
                toolbar.getBoundingClientRect().height / 2;
              resolve({
                methodologyGraphInsideCard:
                  graphRect.left >= cardRect.left && graphRect.right <= cardRect.right &&
                  graphRect.top >= cardRect.top && graphRect.bottom <= cardRect.bottom,
                methodologyGraphHorizontalOverflow:
                  graph.scrollWidth > graph.clientWidth,
                methodologyGraphProjectCount:
                  document.querySelectorAll(".knowledge-graph-projects span").length,
                methodologyGraphPrincipleCount:
                  document.querySelectorAll(".knowledge-graph-cluster").length,
                methodologyGraphRelationCount:
                  document.querySelectorAll(".knowledge-principle-relations li").length,
                methodologyGraphSearchVisible:
                  search.getBoundingClientRect().width > 0,
                methodologyGraphSummaryCount: summary.children.length,
                methodologyGraphToolbarSingleRow:
                  [...toolbar.children].every((child) => {
                    const rect = child.getBoundingClientRect();
                    return Math.abs(rect.top + rect.height / 2 - toolbarCenter) < 1;
                  }),
                methodologyGraphEvidenceColumnCount: evidence.children.length,
                methodologyTabCount: tabs.length,
                methodologyGraphTabSelected:
                  graphTab.getAttribute("aria-selected") === "true",
              });
            }));
          };
          measureGraph();
        };
        openGraph();
      })
    `);
  } else if (
    interaction === "methodology-merge-draft" ||
    interaction === "methodology-merge-recovery" ||
    interaction === "methodology-merge-relation-review"
  ) {
    interactionMetrics = await window.webContents.executeJavaScript(`
      new Promise((resolve, reject) => {
        const deadline = Date.now() + 12000;
        const openGraph = () => {
          const graphAction = [...document.querySelectorAll("button")].find(
            (button) => button.textContent?.trim() === "图谱"
          );
          if (graphAction === undefined) {
            if (Date.now() >= deadline) return reject(new Error("Knowledge graph action did not render"));
            setTimeout(openGraph, 16);
            return;
          }
          graphAction.click();
          const focusDuplicate = () => {
            const graph = document.querySelector(".knowledge-graph");
            const relation = document.querySelector(
              ".knowledge-principle-relations li.duplicate > button"
            );
            if (graph === null || relation === null) {
              if (Date.now() >= deadline) return reject(new Error("Duplicate relationship did not render"));
              setTimeout(focusDuplicate, 16);
              return;
            }
            const graphHeightBefore = graph.getBoundingClientRect().height;
            relation.click();
            const openMerge = () => {
              const action = [...document.querySelectorAll("button")].find(
                (button) => button.textContent?.trim() === "建立合并草案"
              );
              if (action === undefined) {
                if (Date.now() >= deadline) return reject(new Error("Merge draft action did not render"));
                setTimeout(openMerge, 16);
                return;
              }
              action.click();
              let relationReviewStarted = false;
              let relationReviewConfirmations = 0;
              let recoveryStarted = false;
              const measureMerge = () => {
                const dialogs = [...document.querySelectorAll('[role="dialog"]')];
                const dialog = dialogs[0];
                const editor = document.querySelector(".methodology-merge-editor");
                const sources = [...document.querySelectorAll(".methodology-merge-sources article")];
                const picker = document.querySelector(
                  '.methodology-merge-source-picker input[type="checkbox"]'
                );
                if (sources.length === 2 && picker !== null) {
                  picker.click();
                  setTimeout(measureMerge, 16);
                  return;
                }
                if (sources.length === 3 && !relationReviewStarted) {
                  const review = [...document.querySelectorAll(
                    ".methodology-merge-review-candidates button"
                  )].find((button) => button.textContent?.trim() === "核对后加入");
                  if (review === undefined) {
                    if (Date.now() >= deadline) return reject(new Error("Partial merge candidate did not render"));
                    setTimeout(measureMerge, 16);
                    return;
                  }
                  relationReviewStarted = true;
                  review.click();
                  setTimeout(measureMerge, 16);
                  return;
                }
                if (sources.length === 3 && relationReviewStarted &&
                    "${interaction}" === "methodology-merge-relation-review") {
                  const reviewPanel = document.querySelector(
                    ".methodology-merge-relation-review"
                  );
                  const pairs = [...document.querySelectorAll(
                    ".methodology-merge-relation-pair article"
                  )];
                  const actions = [...document.querySelectorAll(
                    ".methodology-merge-relation-review > footer button"
                  )];
                  const progress = document.querySelector(
                    ".methodology-merge-relation-review > header span"
                  );
                  const fields = [...document.querySelectorAll(
                    ".methodology-merge-fields input, .methodology-merge-fields textarea"
                  )];
                  if (dialog === undefined || reviewPanel === null || pairs.length !== 2 ||
                      actions.length !== 3 || progress === null) {
                    if (Date.now() >= deadline) return reject(new Error("Inline merge relationship review did not render"));
                    setTimeout(measureMerge, 16);
                    return;
                  }
                  requestAnimationFrame(() => requestAnimationFrame(() => {
                    const dialogRect = dialog.getBoundingClientRect();
                    const body = dialog.querySelector(".modal-dialog-body");
                    resolve({
                      methodologyMergeRelationCentered:
                        Math.abs(dialogRect.top + dialogRect.height / 2 - innerHeight / 2) < 2,
                      methodologyMergeRelationInsideDialog:
                        dialog.contains(reviewPanel),
                      methodologyMergeRelationDialogCount: dialogs.length,
                      methodologyMergeRelationSourceCount: sources.length,
                      methodologyMergeRelationPairCount: pairs.length,
                      methodologyMergeRelationActionCount: actions.length,
                      methodologyMergeRelationProgressVisible:
                        progress.textContent?.replace(/\\s/g, "") === "第1/2对",
                      methodologyMergeRelationComposeHidden: fields.length === 0,
                      methodologyMergeRelationHorizontalOverflow:
                        body === null ? true : body.scrollWidth > body.clientWidth,
                    });
                  }));
                  return;
                }
                if (sources.length === 3 && relationReviewConfirmations < 2) {
                  const confirm = [...document.querySelectorAll(
                    ".methodology-merge-relation-review button"
                  )].find((button) => button.textContent?.trim() === "确认重复并继续");
                  if (confirm === undefined) {
                    if (Date.now() >= deadline) return reject(new Error("Inline pairwise review did not advance"));
                    setTimeout(measureMerge, 16);
                    return;
                  }
                  relationReviewConfirmations += 1;
                  confirm.click();
                  setTimeout(measureMerge, 16);
                  return;
                }
                const fields = [...document.querySelectorAll(
                  ".methodology-merge-fields input, .methodology-merge-fields textarea"
                )];
                const evidence = [...document.querySelectorAll(
                  '.methodology-merge-evidence input[type="checkbox"]'
                )];
                const safety = document.querySelector(".methodology-merge-safety");
                const groupRule = document.querySelector(
                  ".methodology-merge-source-picker legend"
                );
                const sourceLimit = document.querySelector(
                  ".methodology-merge-source-heading em"
                );
                const relationOutcome = document.querySelector(
                  ".methodology-merge-relation-outcome"
                );
                const save = [...document.querySelectorAll("button")].find(
                  (button) => button.textContent?.trim() === "创建待确认草案"
                );
                if (dialog === undefined || editor === null || sources.length !== 4 ||
                    fields.length !== 5 || evidence.length === 0 || safety === null ||
                    groupRule === null || sourceLimit === null ||
                    (relationOutcome === null && !(recoveryStarted &&
                      "${interaction}" === "methodology-merge-recovery")) ||
                    save === undefined) {
                  if (Date.now() >= deadline) return reject(new Error(
                    "Merge draft editor did not render: " + JSON.stringify({
                      dialogs: dialogs.length,
                      editor: editor !== null,
                      sources: sources.length,
                      fields: fields.length,
                      evidence: evidence.length,
                      safety: safety !== null,
                      groupRule: groupRule !== null,
                      sourceLimit: sourceLimit?.textContent?.trim() ?? null,
                      relationOutcome: relationOutcome !== null,
                      save: save !== undefined,
                      recoveryStarted,
                      notice: document.querySelector(
                        ".methodology-operation-notice"
                      )?.textContent?.trim() ?? null,
                      resume: [...document.querySelectorAll("button")].some(
                        (button) => button.textContent?.trim() === "继续合并"
                      ),
                    })
                  ));
                  setTimeout(measureMerge, 16);
                  return;
                }
                if ("${interaction}" === "methodology-merge-recovery") {
                  if (!recoveryStarted) {
                    const title = document.querySelector(
                      '.methodology-merge-fields input[aria-label="新标题"]'
                    );
                    const later = [...document.querySelectorAll(
                      ".methodology-merge-actions button"
                    )].find((button) => button.textContent?.trim() === "稍后继续");
                    if (title === null || later === undefined) {
                      if (Date.now() >= deadline) return reject(new Error("Merge recovery controls did not render"));
                      setTimeout(measureMerge, 16);
                      return;
                    }
                    recoveryStarted = true;
                    const valueSetter = Object.getOwnPropertyDescriptor(
                      HTMLInputElement.prototype,
                      "value"
                    )?.set;
                    valueSetter?.call(title, "恢复后的合并原则");
                    title.dispatchEvent(new Event("input", { bubbles: true }));
                    setTimeout(() => {
                      later.click();
                      const resume = () => {
                        const action = [...document.querySelectorAll("button")].find(
                          (button) => button.textContent?.trim() === "继续合并"
                        );
                        if (action === undefined) {
                          if (Date.now() >= deadline) return reject(new Error("Merge recovery action did not render"));
                          setTimeout(resume, 16);
                          return;
                        }
                        action.click();
                        setTimeout(measureMerge, 16);
                      };
                      resume();
                    }, 16);
                    return;
                  }
                  const status = document.querySelector(
                    ".methodology-merge-source-heading small"
                  );
                  const recoveryNotice = document.querySelector(
                    ".methodology-merge-guidance.recovered"
                  );
                  const recoveredTitle = document.querySelector(
                    '.methodology-merge-fields input[aria-label="新标题"]'
                  );
                  const actions = [...document.querySelectorAll(
                    ".methodology-merge-actions button"
                  )];
                  if (status === null || recoveryNotice === null || recoveredTitle === null ||
                      actions.length !== 3) {
                    if (Date.now() >= deadline) return reject(new Error("Recovered merge editor did not render"));
                    setTimeout(measureMerge, 16);
                    return;
                  }
                  requestAnimationFrame(() => requestAnimationFrame(() => {
                    const body = dialog.querySelector(".modal-dialog-body");
                    resolve({
                      methodologyMergeDialogCount: dialogs.length,
                      methodologyMergeSourceCount: sources.length,
                      methodologyMergeRecoveryStatusVisible:
                        status.textContent?.includes("已恢复") === true,
                      methodologyMergeRecoveryNoticeVisible:
                        recoveryNotice.getBoundingClientRect().height > 0,
                      methodologyMergeRecoveryTitleRestored:
                        recoveredTitle.value === "恢复后的合并原则",
                      methodologyMergeRecoveryActionsVisible:
                        actions.every((button) =>
                          button.getBoundingClientRect().bottom <=
                            dialog.getBoundingClientRect().bottom
                        ),
                      methodologyMergeRecoveryHorizontalOverflow:
                        body === null ? true : body.scrollWidth > body.clientWidth,
                    });
                  }));
                  return;
                }
                requestAnimationFrame(() => requestAnimationFrame(() => {
                  const dialogRect = dialog.getBoundingClientRect();
                  const sourceTops = sources.map((source) => source.getBoundingClientRect().top);
                  const body = dialog.querySelector(".modal-dialog-body");
                  resolve({
                    methodologyMergeCentered:
                      Math.abs(dialogRect.top + dialogRect.height / 2 - innerHeight / 2) < 2,
                    methodologyMergeInsideDialog: dialog.contains(editor),
                    methodologyMergeDialogCount: dialogs.length,
                    methodologyMergeSourceCount: sources.length,
                    methodologyMergeSourcesSingleRow:
                      sourceTops.every((top) => Math.abs(top - sourceTops[0]) < 1),
                    methodologyMergeFieldCount: fields.length,
                    methodologyMergeEvidenceCount: evidence.length,
                    methodologyMergeSafetyVisible:
                      safety.getBoundingClientRect().height > 0,
                    methodologyMergeGroupRuleVisible:
                      groupRule.textContent?.includes("扩展合并组") === true,
                    methodologyMergeSourceLimitVisible:
                      sourceLimit.textContent?.trim() === "4 / 5",
                    methodologyMergeRelationReviewCount:
                      relationReviewConfirmations,
                    methodologyMergeRelationOutcomeVisible:
                      relationOutcome.getBoundingClientRect().height > 0,
                    methodologyMergeActionVisible:
                      save.getBoundingClientRect().bottom <= dialogRect.bottom,
                    methodologyMergeHorizontalOverflow:
                      body === null ? true : body.scrollWidth > body.clientWidth,
                    methodologyMergeGraphHeightStable:
                      Math.abs(graph.getBoundingClientRect().height - graphHeightBefore) < 1,
                  });
                }));
              };
              measureMerge();
            };
            openMerge();
          };
          focusDuplicate();
        };
        openGraph();
      })
    `);
  } else if (interaction === "methodology-merge-lifecycle") {
    interactionMetrics = await window.webContents.executeJavaScript(`
      new Promise((resolve, reject) => {
        const deadline = Date.now() + 12000;
        const openAccepted = () => {
          const accepted = [...document.querySelectorAll(
            ".methodology-status-filter button"
          )].find((button) => button.textContent?.trim() === "已采纳");
          if (accepted === undefined) {
            if (Date.now() >= deadline) return reject(new Error("Accepted methodology filter did not render"));
            setTimeout(openAccepted, 16);
            return;
          }
          accepted.click();
          const openDetail = () => {
            const row = [...document.querySelectorAll(".methodology-row")].find(
              (candidate) => candidate.textContent?.includes("先稳定可回退骨架")
            );
            if (row === undefined) {
              if (Date.now() >= deadline) return reject(new Error("Accepted merged principle did not render"));
              setTimeout(openDetail, 16);
              return;
            }
            row.click();
            const openLifecycle = () => {
              const action = [...document.querySelectorAll("button")].find(
                (button) => button.textContent?.trim() === "整理来源"
              );
              if (action === undefined) {
                if (Date.now() >= deadline) return reject(new Error("Merge source cleanup action did not render"));
                setTimeout(openLifecycle, 16);
                return;
              }
              action.click();
              const measureLifecycle = () => {
                const dialog = document.querySelector('[role="dialog"]');
                const lifecycle = document.querySelector(".methodology-merge-lifecycle");
                const steps = [...document.querySelectorAll(
                  ".methodology-merge-lifecycle-steps > span"
                )];
                const sources = [...document.querySelectorAll(
                  ".methodology-merge-lifecycle-sources li"
                )];
                const assets = [...document.querySelectorAll(
                  ".methodology-merge-lifecycle-assets li"
                )];
                const action = [...document.querySelectorAll("button")].find(
                  (button) => button.textContent?.trim() === "生成替换草案"
                );
                const safety = document.querySelector(
                  ".methodology-merge-lifecycle-assets > p"
                );
                if (dialog === null || lifecycle === null || steps.length !== 3 ||
                    sources.length !== 3 || assets.length !== 1 ||
                    action === undefined || safety === null) {
                  if (Date.now() >= deadline) return reject(new Error("Merge source cleanup dialog did not render"));
                  setTimeout(measureLifecycle, 16);
                  return;
                }
                requestAnimationFrame(() => requestAnimationFrame(() => {
                  const dialogRect = dialog.getBoundingClientRect();
                  const body = dialog.querySelector(".modal-dialog-body");
                  resolve({
                    methodologyMergeLifecycleCentered:
                      Math.abs(dialogRect.top + dialogRect.height / 2 - innerHeight / 2) < 2,
                    methodologyMergeLifecycleInsideDialog:
                      dialog.contains(lifecycle),
                    methodologyMergeLifecycleStepCount: steps.length,
                    methodologyMergeLifecycleSourceCount: sources.length,
                    methodologyMergeLifecycleAssetCount: assets.length,
                    methodologyMergeLifecycleActionVisible:
                      action.getBoundingClientRect().bottom <= dialogRect.bottom,
                    methodologyMergeLifecycleSafetyVisible:
                      safety.getBoundingClientRect().bottom <= dialogRect.bottom,
                    methodologyMergeLifecycleHorizontalOverflow:
                      body === null ? true : body.scrollWidth > body.clientWidth,
                  });
                }));
              };
              measureLifecycle();
            };
            openLifecycle();
          };
          openDetail();
        };
        openAccepted();
      })
    `);
  } else if (interaction === "practice-assets") {
    interactionMetrics = await window.webContents.executeJavaScript(`
      new Promise((resolve, reject) => {
        const deadline = Date.now() + 12000;
        const openAssets = () => {
          const action = [...document.querySelectorAll("button")].find(
            (button) => button.textContent?.trim() === "技能与流程"
          );
          if (action === undefined) {
            if (Date.now() >= deadline) return reject(new Error("Practice assets action did not render"));
            setTimeout(openAssets, 16);
            return;
          }
          action.click();
          const measure = () => {
            const assets = document.querySelector(".practice-assets");
            const row = document.querySelector(".practice-asset-row");
            const card = document.querySelector(".methodology-card");
            const mainToolbar = document.querySelector(".methodology-toolbar");
            const assetsToolbar = document.querySelector(".practice-assets-toolbar");
            const statusFilters = [...document.querySelectorAll(
              ".practice-assets-toolbar .methodology-status-filter button"
            )];
            const viewTabs = [...document.querySelectorAll(
              '.methodology-view-tabs [role="tab"]'
            )];
            if (assets === null || row === null || card === null ||
                mainToolbar === null || assetsToolbar === null ||
                !mainToolbar.contains(assetsToolbar) || statusFilters.length !== 4) {
              if (Date.now() >= deadline) return reject(new Error("Practice assets did not render"));
              setTimeout(measure, 16);
              return;
            }
            requestAnimationFrame(() => requestAnimationFrame(() => {
              const assetsRect = assets.getBoundingClientRect();
              const cardRect = card.getBoundingClientRect();
              const mainToolbarRect = mainToolbar.getBoundingClientRect();
              const assetsToolbarRect = assetsToolbar.getBoundingClientRect();
              resolve({
                practiceAssetsInsideCard:
                  assetsRect.left >= cardRect.left && assetsRect.right <= cardRect.right &&
                  assetsRect.top >= cardRect.top && assetsRect.bottom <= cardRect.bottom,
                practiceAssetsToolbarInsideMain:
                  mainToolbar.contains(assetsToolbar),
                practiceAssetsToolbarHeightMatches:
                  Math.abs(mainToolbarRect.height - 44) < 1 &&
                  assetsToolbarRect.top >= mainToolbarRect.top &&
                  assetsToolbarRect.bottom <= mainToolbarRect.bottom,
                practiceAssetsFiltersSingleRow:
                  new Set(statusFilters.map((button) =>
                    Math.round(button.getBoundingClientRect().top)
                  )).size === 1,
                practiceAssetsViewTabCount: viewTabs.length,
                practiceAssetColumnCount: row.children.length,
                practiceAssetsHorizontalOverflow:
                  assets.scrollWidth > assets.clientWidth,
                practiceAssetRowCount:
                  document.querySelectorAll(".practice-asset-row").length,
              });
            }));
          };
          measure();
        };
        openAssets();
      })
    `);
  } else if (interaction === "practice-source") {
    interactionMetrics = await window.webContents.executeJavaScript(`
      new Promise((resolve, reject) => {
        const deadline = Date.now() + 12000;
        const openAssets = () => {
          const action = [...document.querySelectorAll("button")].find(
            (button) => button.textContent?.trim() === "技能与流程"
          );
          if (action === undefined) {
            if (Date.now() >= deadline) return reject(new Error("Practice assets action did not render"));
            setTimeout(openAssets, 16);
            return;
          }
          action.click();
          const openChooser = () => {
            const generate = [...document.querySelectorAll("button")].find(
              (button) => button.textContent?.trim() === "新建草案"
            );
            if (generate === undefined) {
              if (Date.now() >= deadline) return reject(new Error("Practice generate action did not render"));
              setTimeout(openChooser, 16);
              return;
            }
            generate.click();
            const measure = () => {
              const dialog = document.querySelector('[role="dialog"]');
              const types = [...document.querySelectorAll(".practice-kind-picker button")];
              const principles = document.querySelector(".practice-principle-list");
              const submit = [...document.querySelectorAll("button")].find(
                (button) => button.textContent?.trim() === "调用模型生成技能"
              );
              const manual = [...document.querySelectorAll("button")].find(
                (button) => button.textContent?.trim() === "手动编写"
              );
              const boundary = document.querySelector(".practice-creation-boundary");
              if (dialog === null || types.length !== 2 || principles === null ||
                  submit === undefined || manual === undefined || boundary === null) {
                if (Date.now() >= deadline) return reject(new Error("Practice source chooser did not render"));
                setTimeout(measure, 16);
                return;
              }
              requestAnimationFrame(() => requestAnimationFrame(() => {
                const dialogRect = dialog.getBoundingClientRect();
                resolve({
                  practiceChooserCentered:
                    Math.abs(dialogRect.top + dialogRect.height / 2 - innerHeight / 2) < 2,
                  practiceTypeCount: types.length,
                  practiceTypesSingleRow:
                    new Set(types.map((button) => button.getBoundingClientRect().top)).size === 1,
                  practicePrincipleCount:
                    principles.querySelectorAll('input[type="checkbox"]').length,
                  practiceSubmitVisible:
                    submit.getBoundingClientRect().bottom <= dialogRect.bottom,
                  practiceManualActionVisible:
                    manual.getBoundingClientRect().bottom <= dialogRect.bottom,
                  practiceCreationBoundaryCount: boundary.children.length,
                });
              }));
            };
            measure();
          };
          openChooser();
        };
        openAssets();
      })
    `);
  } else if (interaction === "practice-manual") {
    interactionMetrics = await window.webContents.executeJavaScript(`
      new Promise((resolve, reject) => {
        const deadline = Date.now() + 12000;
        const openAssets = () => {
          const action = [...document.querySelectorAll("button")].find(
            (button) => button.textContent?.trim() === "技能与流程"
          );
          if (action === undefined) {
            if (Date.now() >= deadline) return reject(new Error("Practice assets action did not render"));
            setTimeout(openAssets, 16);
            return;
          }
          action.click();
          const openChooser = () => {
            const create = [...document.querySelectorAll("button")].find(
              (button) => button.textContent?.trim() === "新建草案"
            );
            if (create === undefined) {
              if (Date.now() >= deadline) return reject(new Error("Practice create action did not render"));
              setTimeout(openChooser, 16);
              return;
            }
            create.click();
            const selectSource = () => {
              const source = document.querySelector('.practice-principle-list input[type="checkbox"]');
              const manual = [...document.querySelectorAll("button")].find(
                (button) => button.textContent?.trim() === "手动编写"
              );
              if (source === null || manual === undefined) {
                if (Date.now() >= deadline) return reject(new Error("Manual practice source choice did not render"));
                setTimeout(selectSource, 16);
                return;
              }
              source.click();
              manual.click();
              const measure = () => {
                const dialog = document.querySelector('[role="dialog"]');
                const draft = document.querySelector(".practice-manual-draft");
                const editor = draft?.querySelector(".practice-asset-editor") ?? null;
                const fields = editor === null ? [] : [...editor.querySelectorAll(":scope > label")];
                const safety = draft?.querySelector(".practice-manual-safety") ?? null;
                const sourceSummary = draft?.querySelector(".practice-manual-source-summary") ?? null;
                const save = [...document.querySelectorAll("button")].find(
                  (button) => button.textContent?.trim() === "保存为待确认草案"
                );
                if (dialog === null || draft === null || editor === null || fields.length !== 6 ||
                    safety === null || sourceSummary === null || save === undefined) {
                  if (Date.now() >= deadline) return reject(new Error("Manual practice editor did not render"));
                  setTimeout(measure, 16);
                  return;
                }
                requestAnimationFrame(() => requestAnimationFrame(() => {
                  const dialogRect = dialog.getBoundingClientRect();
                  const body = dialog.querySelector(".modal-dialog-body");
                  const fieldTops = fields.map((field) => field.getBoundingClientRect().top);
                  resolve({
                    practiceManualCentered:
                      Math.abs(dialogRect.top + dialogRect.height / 2 - innerHeight / 2) < 2,
                    practiceManualInsideDialog: dialog.contains(draft),
                    practiceManualFieldCount: fields.length,
                    practiceManualTwoColumnRows:
                      Math.abs(fieldTops[1] - fieldTops[2]) < 1 &&
                      Math.abs(fieldTops[3] - fieldTops[4]) < 1,
                    practiceManualSourceVisible:
                      sourceSummary.getBoundingClientRect().bottom <= dialogRect.bottom,
                    practiceManualSafetyVisible:
                      safety.getBoundingClientRect().bottom <= dialogRect.bottom,
                    practiceManualSaveVisible:
                      save.getBoundingClientRect().bottom <= dialogRect.bottom,
                    practiceManualHorizontalOverflow:
                      body === null ? true : body.scrollWidth > body.clientWidth,
                    practiceManualNoModelCopy:
                      draft.textContent?.includes("系统不会替你补写步骤或验收标准") === true,
                  });
                }));
              };
              measure();
            };
            selectSource();
          };
          openChooser();
        };
        openAssets();
      })
    `);
  } else if (interaction === "practice-detail") {
    interactionMetrics = await window.webContents.executeJavaScript(`
      new Promise((resolve, reject) => {
        const deadline = Date.now() + 12000;
        const openAssets = () => {
          const action = [...document.querySelectorAll("button")].find(
            (button) => button.textContent?.trim() === "技能与流程"
          );
          if (action === undefined) {
            if (Date.now() >= deadline) return reject(new Error("Practice assets action did not render"));
            setTimeout(openAssets, 16);
            return;
          }
          action.click();
          const openDetail = () => {
            const row = document.querySelector(".practice-asset-row");
            if (row === null) {
              if (Date.now() >= deadline) return reject(new Error("Practice asset row did not render"));
              setTimeout(openDetail, 16);
              return;
            }
            row.click();
            const measure = () => {
              const dialog = document.querySelector('[role="dialog"]');
              const detail = document.querySelector(".practice-asset-detail");
              const accept = [...document.querySelectorAll("button")].find(
                (button) => button.textContent?.trim() === "采纳草案"
              );
              if (dialog === null || detail === null || accept === undefined) {
                if (Date.now() >= deadline) return reject(new Error("Practice asset detail did not render"));
                setTimeout(measure, 16);
                return;
              }
              requestAnimationFrame(() => requestAnimationFrame(() => {
                const dialogRect = dialog.getBoundingClientRect();
                resolve({
                  practiceDetailCentered:
                    Math.abs(dialogRect.top + dialogRect.height / 2 - innerHeight / 2) < 2,
                  practiceDetailInsideDialog: dialog.contains(detail),
                  practiceStepCount:
                    detail.querySelectorAll(":scope > section > ol > li").length,
                  practiceAcceptVisible:
                    accept.getBoundingClientRect().bottom <= dialogRect.bottom,
                  practiceInstallBoundaryVisible:
                    detail.textContent?.includes("发布只在明确确认后执行") === true,
                });
              }));
            };
            measure();
          };
          openDetail();
        };
        openAssets();
      })
    `);
  } else if (interaction === "practice-publication") {
    interactionMetrics = await window.webContents.executeJavaScript(`
      new Promise((resolve, reject) => {
        const deadline = Date.now() + 12000;
        const openAssets = () => {
          const action = [...document.querySelectorAll("button")].find(
            (button) => button.textContent?.trim() === "技能与流程"
          );
          if (action === undefined) {
            if (Date.now() >= deadline) return reject(new Error("Practice assets action did not render"));
            setTimeout(openAssets, 16);
            return;
          }
          action.click();
          const openDetail = () => {
            const row = document.querySelector(".practice-asset-row");
            if (row === null) {
              if (Date.now() >= deadline) return reject(new Error("Practice asset row did not render"));
              setTimeout(openDetail, 16);
              return;
            }
            row.click();
            const acceptDraft = () => {
              const accept = [...document.querySelectorAll("button")].find(
                (button) => button.textContent?.trim() === "采纳草案"
              );
              if (accept === undefined) {
                if (Date.now() >= deadline) return reject(new Error("Practice accept action did not render"));
                setTimeout(acceptDraft, 16);
                return;
              }
              accept.click();
              const measure = () => {
                const dialog = document.querySelector('[role="dialog"]');
                const publication = document.querySelector(".practice-publication-section");
                const grid = document.querySelector(".practice-publication-grid");
                const cards = [...document.querySelectorAll(".practice-publication-card")];
                const source = document.querySelector(".practice-source-principles");
                const actions = cards.flatMap((card) =>
                  [...card.querySelectorAll("button")]
                );
                if (dialog === null || publication === null || grid === null || cards.length !== 2 || source === null) {
                  if (Date.now() >= deadline) return reject(new Error("Practice publication controls did not render"));
                  setTimeout(measure, 16);
                  return;
                }
                requestAnimationFrame(() => requestAnimationFrame(() => {
                  const dialogRect = dialog.getBoundingClientRect();
                  const publicationRect = publication.getBoundingClientRect();
                  resolve({
                    practicePublicationInsideDialog:
                      dialog.contains(publication) &&
                      publicationRect.bottom <= dialogRect.bottom,
                    practicePublicationCardCount: cards.length,
                    practicePublicationColumnCount:
                      new Set(cards.map((card) => card.getBoundingClientRect().left)).size,
                    practicePublicationActionsVisible:
                      actions.length === 2 &&
                      actions.every((button) => button.getBoundingClientRect().bottom <= dialogRect.bottom),
                    practiceSourceCollapsed: !source.hasAttribute("open"),
                  });
                }));
              };
              measure();
            };
            acceptDraft();
          };
          openDetail();
        };
        openAssets();
      })
    `);
  } else if (interaction === "practice-freshness") {
    interactionMetrics = await window.webContents.executeJavaScript(`
      new Promise((resolve, reject) => {
        const deadline = Date.now() + 12000;
        const openAssets = () => {
          const action = [...document.querySelectorAll("button")].find(
            (button) => button.textContent?.trim() === "技能与流程"
          );
          if (action === undefined) {
            if (Date.now() >= deadline) return reject(new Error("Practice assets action did not render"));
            setTimeout(openAssets, 16);
            return;
          }
          action.click();
          const openAccepted = () => {
            const accepted = [...document.querySelectorAll(".practice-assets-toolbar .methodology-status-filter button")].find(
              (button) => button.textContent?.trim() === "已采纳"
            );
            if (accepted === undefined) {
              if (Date.now() >= deadline) return reject(new Error("Accepted practice filter did not render"));
              setTimeout(openAccepted, 16);
              return;
            }
            accepted.click();
            const openDetail = () => {
              const row = [...document.querySelectorAll(".practice-asset-row")].find(
                (candidate) => candidate.textContent?.includes("来源更新后的实践校准")
              );
              if (row === undefined) {
                if (Date.now() >= deadline) return reject(new Error(
                  "Stale practice asset did not render; rows=" +
                  [...document.querySelectorAll(".practice-asset-row")]
                    .map((candidate) => candidate.textContent?.trim())
                    .join(" | ") +
                  "; filters=" +
                  [...document.querySelectorAll(".practice-assets-toolbar .methodology-status-filter button")]
                    .map((button) => button.textContent?.trim() + ":" + button.getAttribute("aria-pressed"))
                    .join(" | ")
                ));
                setTimeout(openDetail, 16);
                return;
              }
              row.click();
              const measure = () => {
                const dialog = document.querySelector('[role="dialog"]');
                const notice = document.querySelector(".practice-freshness-notice");
                const sourceDiff = document.querySelector(".practice-source-diff");
                const warning = document.querySelector(".practice-publication-source-warning");
                const regenerate = [...document.querySelectorAll("button")].find(
                  (button) => button.textContent?.trim() === "重新生成新草案"
                );
                const rollback = [...document.querySelectorAll("button")].find(
                  (button) => button.textContent?.trim() === "回滚"
                );
                const publish = [...document.querySelectorAll("button")].find(
                  (button) => button.textContent?.trim() === "已发布"
                );
                if (dialog === null || notice === null || sourceDiff === null || warning === null ||
                    regenerate === undefined || rollback === undefined || publish === undefined) {
                  if (Date.now() >= deadline) return reject(new Error("Practice freshness controls did not render"));
                  setTimeout(measure, 16);
                  return;
                }
                requestAnimationFrame(() => requestAnimationFrame(() => {
                  const dialogRect = dialog.getBoundingClientRect();
                  resolve({
                    practiceDetailCentered:
                      Math.abs(dialogRect.top + dialogRect.height / 2 - innerHeight / 2) < 2,
                    practiceFreshnessVisible:
                      notice.getBoundingClientRect().bottom <= dialogRect.bottom,
                    practiceRegenerateVisible:
                      regenerate.getBoundingClientRect().bottom <= dialogRect.bottom,
                    practicePublishPaused: publish.disabled === true,
                    practiceRollbackVisible: rollback.disabled === false,
                    practiceSourceDiffVisible:
                      sourceDiff.hasAttribute("open") &&
                      sourceDiff.getBoundingClientRect().bottom <= dialogRect.bottom,
                    practiceSourceFieldChangeCount:
                      sourceDiff.querySelectorAll(".practice-source-field-list > div").length,
                  });
                }));
              };
              measure();
            };
            openDetail();
          };
          openAccepted();
        };
        openAssets();
      })
    `);
  } else if (interaction === "practice-history") {
    interactionMetrics = await window.webContents.executeJavaScript(`
      new Promise((resolve, reject) => {
        const deadline = Date.now() + 12000;
        const openAssets = () => {
          const action = [...document.querySelectorAll("button")].find(
            (button) => button.textContent?.trim() === "技能与流程"
          );
          if (action === undefined) {
            if (Date.now() >= deadline) return reject(new Error("Practice assets action did not render"));
            setTimeout(openAssets, 16);
            return;
          }
          action.click();
          const openAccepted = () => {
            const accepted = [...document.querySelectorAll(".practice-assets-toolbar .methodology-status-filter button")].find(
              (button) => button.textContent?.trim() === "已采纳"
            );
            if (accepted === undefined) {
              if (Date.now() >= deadline) return reject(new Error("Accepted practice filter did not render"));
              setTimeout(openAccepted, 16);
              return;
            }
            accepted.click();
            const openDetail = () => {
              const row = [...document.querySelectorAll(".practice-asset-row")].find(
                (candidate) => candidate.textContent?.includes("来源更新后的实践校准")
              );
              if (row === undefined) {
                if (Date.now() >= deadline) return reject(new Error("Stale practice asset did not render"));
                setTimeout(openDetail, 16);
                return;
              }
              row.click();
              const openHistory = () => {
                const history = document.querySelector(".practice-version-history");
                const summary = history?.querySelector("summary");
                if (history === null || history === undefined || summary === null || summary === undefined) {
                  if (Date.now() >= deadline) return reject(new Error("Practice history did not render"));
                  setTimeout(openHistory, 16);
                  return;
                }
                summary.click();
                const selectVersion = () => {
                  const versions = [...history.querySelectorAll(".practice-version-list button")];
                  if (versions.length !== 2) {
                    if (Date.now() >= deadline) return reject(new Error("Practice history versions did not render"));
                    setTimeout(selectVersion, 16);
                    return;
                  }
                  versions[0].click();
                  const openConfirmation = () => {
                    const restore = [...history.querySelectorAll("button")].find(
                      (button) => button.textContent?.trim() === "恢复此版本"
                    );
                    const comparison = history.querySelector(".practice-version-comparison");
                    if (restore === undefined || comparison === null) {
                      if (Date.now() >= deadline) return reject(new Error("Practice version comparison did not render"));
                      setTimeout(openConfirmation, 16);
                      return;
                    }
                    restore.click();
                    const measure = () => {
                      const dialog = document.querySelector('[role="dialog"]');
                      const confirmation = history.querySelector(
                        ".practice-version-restore-confirm"
                      );
                      if (dialog === null || confirmation === null) {
                        if (Date.now() >= deadline) return reject(new Error("Practice restore confirmation did not render"));
                        setTimeout(measure, 16);
                        return;
                      }
                      history.scrollIntoView({ block: "center" });
                      requestAnimationFrame(() => requestAnimationFrame(() => {
                        const dialogRect = dialog.getBoundingClientRect();
                        resolve({
                          practiceDetailCentered:
                            Math.abs(dialogRect.top + dialogRect.height / 2 - innerHeight / 2) < 2,
                          practiceHistoryVisible:
                            history.getBoundingClientRect().top >= dialogRect.top &&
                            history.getBoundingClientRect().bottom <= dialogRect.bottom,
                          practiceHistoryVersionCount: versions.length,
                          practiceHistoryComparisonVisible:
                            comparison.getBoundingClientRect().bottom <= dialogRect.bottom,
                          practiceHistoryRestoreConfirmationVisible:
                            confirmation.getBoundingClientRect().bottom <= dialogRect.bottom,
                        });
                      }));
                    };
                    measure();
                  };
                  openConfirmation();
                };
                selectVersion();
              };
              openHistory();
            };
            openDetail();
          };
          openAccepted();
        };
        openAssets();
      })
    `);
  }

  const metrics = await window.webContents.executeJavaScript(`
    new Promise((resolve, reject) => {
      const deadline = Date.now() + 12000;
      const measure = () => {
        const appShell = document.querySelector(".desktop-app");
        const sidebar = document.querySelector(".desktop-sidebar");
        const stage = document.querySelector(".desktop-stage");
        const page = document.querySelector(".desktop-page-scroll");
        const header = document.querySelector(".desktop-view-header");
        const heading = header?.querySelector("h1");
        const surfaceRoot = document.querySelector(".${surface}-panel");
        const modelProfile = document.querySelector(".provider-copy strong");
        const traceRow = document.querySelector(".model-trace-row");
        const traceRows = [...document.querySelectorAll(".model-trace-row")];
        const traceList = document.querySelector(".model-trace-list");
        const traceCard = document.querySelector(".model-trace-card");
        const activityRecognition = document.querySelector(
          ".activity-recognition-card"
        );
        const decisionRow = document.querySelector(".decision-library-row");
        const methodologyRow = document.querySelector(".methodology-row");
        const methodologyToolbar = document.querySelector(".methodology-toolbar");
        const methodologyViewTabs = document.querySelector(".methodology-view-tabs");
        const methodologyActiveTab = document.querySelector(
          '.methodology-view-tabs [aria-selected="true"]'
        );
        const methodologyRecordsToolbar = document.querySelector(
          ".methodology-records-toolbar"
        );
        const methodologyStatusFilter = document.querySelector(
          ".methodology-status-filter"
        );
        const methodologyBuildGuide = document.querySelector(
          ".methodology-build-guide"
        );
        const methodologyBuildMetrics = [
          ...document.querySelectorAll(".methodology-build-metrics > div"),
        ];
        const methodologyBuildActions = [
          ...document.querySelectorAll(".methodology-build-actions button"),
        ];
        const methodologyBuildPathItems = [
          ...document.querySelectorAll(".methodology-build-path li"),
        ];
        const methodologyGraph = document.querySelector(".knowledge-graph");
        const methodologyAnalysis = document.querySelector(".decision-analytics");
        const practiceAssetRow = document.querySelector(".practice-asset-row");
        if (appShell === null || sidebar === null || stage === null ||
            page === null || header === null || heading === null ||
            surfaceRoot === null ||
            ("${surface}" === "decisions" && decisionRow === null) ||
            ("${surface}" === "methodology" &&
              !"${interaction}".startsWith("practice-") &&
              "${interaction}" !== "methodology-graph" &&
              "${interaction}" !== "methodology-merge-draft" &&
              "${interaction}" !== "methodology-merge-recovery" &&
              "${interaction}" !== "methodology-merge-relation-review" &&
              "${interaction}" !== "methodology-analysis" &&
              "${interaction}" !== "methodology-consultation" && methodologyRow === null) ||
            ("${surface}" === "methodology" &&
              ("${interaction}" === "methodology-graph" ||
                "${interaction}" === "methodology-merge-draft" ||
                "${interaction}" === "methodology-merge-relation-review") && methodologyGraph === null) ||
            ("${surface}" === "methodology" &&
              ("${interaction}" === "methodology-analysis" ||
                "${interaction}" === "methodology-consultation") && methodologyAnalysis === null) ||
            ("${surface}" === "methodology" &&
              "${interaction}".startsWith("practice-") && practiceAssetRow === null) ||
            ("${surface}" === "models" && modelProfile === null) ||
            ("${surface}" === "activity" &&
              (traceRow === null || traceList === null ||
                traceCard === null || activityRecognition === null))) {
          if (Date.now() >= deadline) {
            reject(new Error("Desktop ${surface} layout did not render"));
            return;
          }
          setTimeout(measure, 16);
          return;
        }
        requestAnimationFrame(() => requestAnimationFrame(() => {
          const rootStyles = getComputedStyle(document.documentElement);
          const shellStyles = getComputedStyle(appShell);
          const headingBounds = heading.getBoundingClientRect();
          const path = document.querySelector(".path-value");
          const pathStyles = path === null ? null : getComputedStyle(path);
          const traceListStyles = traceList === null
            ? null
            : getComputedStyle(traceList);
          const traceListScrollbarStyles = traceList === null
            ? null
            : getComputedStyle(traceList, "::-webkit-scrollbar");
          const decisionRows = [
            ...document.querySelectorAll(".decision-library-row"),
          ];
          const decisionList = document.querySelector(".decision-library-list");
          const decisionListStyles = decisionList === null
            ? null
            : getComputedStyle(decisionList);
          const decisionListScrollbarStyles = decisionList === null
            ? null
            : getComputedStyle(decisionList, "::-webkit-scrollbar");
          const visibleDecisionColumns = decisionRows.map((row) =>
            [...row.children].map((child) => child.getBoundingClientRect().left),
          );
          const firstDecisionColumns = visibleDecisionColumns[0] ?? [];
          const methodologyRows = [
            ...document.querySelectorAll(".methodology-row"),
          ];
          const visibleMethodologyColumns = methodologyRows.map((row) =>
            [...row.children].map((child) => child.getBoundingClientRect().left),
          );
          const firstMethodologyColumns = visibleMethodologyColumns[0] ?? [];
          const visibleTraceColumns = traceRows.map((row) =>
            [...row.children]
              .filter((child) => getComputedStyle(child).display !== "none")
              .map((child) => child.getBoundingClientRect().left),
          );
          const firstTraceColumns = visibleTraceColumns[0] ?? [];
          const cards = [...page.querySelectorAll(
            ".settings-card, .client-card, .client-actions-card, .recognition-overview, .decision-library-card, .methodology-card"
          )];
          const buttons = [...page.querySelectorAll("button")];
          const providerRows = [...page.querySelectorAll(".provider-row")];
          const providerSwitches = [
            ...page.querySelectorAll('.provider-switch input[role="switch"]'),
          ];
          const providerDragHandles = [
            ...page.querySelectorAll(".provider-drag-handle"),
          ];
          const providerStatusLefts = providerRows.map((row) =>
            row.querySelector(".provider-status-cell")?.getBoundingClientRect().left ?? null,
          );
          const providerSwitchLefts = providerRows.map((row) =>
            row.querySelector(".provider-switch")?.getBoundingClientRect().left ?? null,
          );
          const providerActionLefts = providerRows.map((row) =>
            row.querySelector(".provider-actions")?.getBoundingClientRect().left ?? null,
          );
          const providerTestActionLefts = providerRows.map((row) =>
            row.querySelector(".provider-actions .text-button")?.getBoundingClientRect().left ?? null,
          );
          const firstContent = page.firstElementChild;
          const firstContentRect = firstContent?.getBoundingClientRect();
          const cardHeaderHeights = [...page.querySelectorAll(
            ".settings-card-header"
          )].map((cardHeader) => cardHeader.getBoundingClientRect().height);
          const cardHeadersSingleRow = [...page.querySelectorAll(
            ".settings-card-header"
          )].every((cardHeader) => {
            const titleGroup = cardHeader.querySelector(":scope > div:first-child");
            if (titleGroup === null) return false;
            const styles = getComputedStyle(titleGroup);
            return styles.display === "flex" && styles.flexDirection === "row";
          });
          const pageRect = page.getBoundingClientRect();
          const pageStyles = getComputedStyle(page);
          const maximumScrollTop = page.scrollHeight - page.clientHeight;
          if (traceList !== null) {
            traceList.scrollTop = traceList.scrollHeight - traceList.clientHeight;
          }
          page.scrollTop = maximumScrollTop;
          requestAnimationFrame(() => requestAnimationFrame(() => resolve({
            appClientHeight: appShell.clientHeight,
            appScrollHeight: appShell.scrollHeight,
            activityRecognitionVisible: activityRecognition !== null,
            backdropFilter: shellStyles.backdropFilter,
            cardCount: cards.length,
            cardHeaderHeights,
            cardHeadersSingleRow,
            cardsFitWidth: cards.every((card) => {
              const rect = card.getBoundingClientRect();
              return rect.left >= pageRect.left - 1 && rect.right <= pageRect.right + 1;
            }),
            clientCardCount: document.querySelectorAll(".client-card").length,
            clientHeight: page.clientHeight,
            clientWidth: page.clientWidth,
            controlsFitWidth: buttons.every((button) => {
              const rect = button.getBoundingClientRect();
              return rect.left >= pageRect.left - 1 && rect.right <= pageRect.right + 1;
            }),
            decisionColumnCount: firstDecisionColumns.length,
            decisionColumnsAligned: visibleDecisionColumns.every(
              (columns) =>
                columns.length === firstDecisionColumns.length &&
                columns.every(
                  (left, index) =>
                    Math.abs(left - (firstDecisionColumns[index] ?? left)) < 1,
                ),
            ),
            decisionListOverflowY: decisionListStyles?.overflowY ?? null,
            decisionListScrollbarWidth:
              decisionListStyles?.scrollbarWidth ?? null,
            decisionListWebkitScrollbarDisplay:
              decisionListScrollbarStyles?.display ?? null,
            headerHeight: header.getBoundingClientRect().height,
            heading: heading.textContent?.trim(),
            headingVisible:
              headingBounds.width > 1 && headingBounds.height > 1,
            modelProfileVisible: page.textContent?.includes("Codex CLI") === true,
            methodologyColumnCount: firstMethodologyColumns.length,
            methodologyColumnsAligned: visibleMethodologyColumns.every(
              (columns) =>
                columns.length === firstMethodologyColumns.length &&
                columns.every(
                  (left, index) =>
                    Math.abs(left - (firstMethodologyColumns[index] ?? left)) < 1,
                ),
            ),
            methodologyActiveIndicatorHeight:
              methodologyActiveTab === null
                ? null
                : getComputedStyle(methodologyActiveTab, "::after").height,
            methodologyBuildActionCount: methodologyBuildActions.length,
            methodologyBuildActionsFit:
              methodologyBuildGuide === null ||
              methodologyBuildActions.every((action) => {
                const actionRect = action.getBoundingClientRect();
                const guideRect = methodologyBuildGuide.getBoundingClientRect();
                return actionRect.left >= guideRect.left - 1 &&
                  actionRect.right <= guideRect.right + 1;
              }),
            methodologyBuildGuideVisible:
              methodologyBuildGuide !== null &&
              methodologyBuildGuide.getBoundingClientRect().height > 0,
            methodologyBuildMetricCount: methodologyBuildMetrics.length,
            methodologyBuildMetricsSingleRow:
              methodologyBuildMetrics.length > 0 &&
              methodologyBuildMetrics.every((metric) =>
                Math.abs(
                  metric.getBoundingClientRect().top -
                    methodologyBuildMetrics[0].getBoundingClientRect().top
                ) < 1
              ),
            methodologyBuildPathCount: methodologyBuildPathItems.length,
            methodologyBuildPathSingleRow:
              methodologyBuildPathItems.length > 0 &&
              methodologyBuildPathItems.every((item) =>
                Math.abs(
                  item.getBoundingClientRect().top -
                    methodologyBuildPathItems[0].getBoundingClientRect().top
                ) < 1
              ),
            methodologyRecordsToolbarHeight:
              methodologyRecordsToolbar?.getBoundingClientRect().height ?? null,
            methodologyStatusFilterBackground:
              methodologyStatusFilter === null
                ? null
                : getComputedStyle(methodologyStatusFilter).backgroundColor,
            methodologyStatusFilterBorderWidth:
              methodologyStatusFilter === null
                ? null
                : getComputedStyle(methodologyStatusFilter).borderTopWidth,
            methodologyToolbarHeight:
              methodologyToolbar?.getBoundingClientRect().height ?? null,
            methodologyToolbarsSingleRow:
              methodologyToolbar === null || methodologyRecordsToolbar === null
                ? null
                : methodologyRecordsToolbar.parentElement === methodologyToolbar &&
                  Math.abs(
                    methodologyRecordsToolbar.getBoundingClientRect().top +
                      methodologyRecordsToolbar.getBoundingClientRect().height / 2 -
                      (methodologyToolbar.getBoundingClientRect().top +
                        methodologyToolbar.getBoundingClientRect().height / 2)
                  ) < 1,
            methodologyViewTabsBackground:
              methodologyViewTabs === null
                ? null
                : getComputedStyle(methodologyViewTabs).backgroundColor,
            methodologyViewTabsBorderWidth:
              methodologyViewTabs === null
                ? null
                : getComputedStyle(methodologyViewTabs).borderTopWidth,
            navigationLabels: Array.from(
              document.querySelectorAll(".desktop-nav-item > span"),
              (node) => node.textContent,
            ),
            overflowY: getComputedStyle(page).overflowY,
            pageContentLeftInset:
              firstContentRect === undefined
                ? null
                : firstContentRect.left - pageRect.left,
            pageContentRightInset:
              firstContentRect === undefined
                ? null
                : pageRect.right - firstContentRect.right,
            pagePaddingBottom: Number.parseFloat(pageStyles.paddingBottom),
            pagePaddingLeft: Number.parseFloat(pageStyles.paddingLeft),
            pagePaddingRight: Number.parseFloat(pageStyles.paddingRight),
            pagePaddingTop: Number.parseFloat(pageStyles.paddingTop),
            pathOverflowWrap: pathStyles?.overflowWrap ?? null,
            pathScrollWidth: path?.scrollWidth ?? null,
            pathClientWidth: path?.clientWidth ?? null,
            pathTextOverflow: pathStyles?.textOverflow ?? null,
            providerDragHandleCount: providerDragHandles.length,
            providerLegacyMoveActionsVisible: buttons.some((button) =>
              ["上移", "下移"].includes(button.textContent?.trim() ?? ""),
            ),
            providerRowHeights: providerRows.map(
              (row) => row.getBoundingClientRect().height,
            ),
            providerStatusLefts,
            providerSwitchCount: providerSwitches.length,
            providerSwitchLefts,
            providerActionLefts,
            providerTestActionLefts,
            scrollHeight: page.scrollHeight,
            scrollTopAfter: page.scrollTop,
            scrollWidth: page.scrollWidth,
            sidebarWidth: sidebar.getBoundingClientRect().width,
            stageWidth: stage.getBoundingClientRect().width,
            surface: "${surface}",
            tokens: {
              modalBackdrop: rootStyles
                .getPropertyValue("--modal-backdrop").trim(),
              modalSurface: rootStyles
                .getPropertyValue("--modal-surface").trim(),
              surface: rootStyles.getPropertyValue("--surface").trim(),
              toolbar: rootStyles.getPropertyValue("--toolbar").trim(),
              window: rootStyles.getPropertyValue("--window").trim(),
              windowHighlight: rootStyles
                .getPropertyValue("--window-highlight").trim(),
            },
            traceRowVisible: traceRow !== null,
            traceColumnCount: firstTraceColumns.length,
            traceColumnsAligned: visibleTraceColumns.every(
              (columns) =>
                columns.length === firstTraceColumns.length &&
                columns.every(
                  (left, index) =>
                    Math.abs(left - (firstTraceColumns[index] ?? left)) < 1,
                ),
            ),
            traceGridTemplateColumns:
              traceRow === null
                ? null
                : getComputedStyle(traceRow).gridTemplateColumns,
            traceCardBottom: traceCard?.getBoundingClientRect().bottom ?? null,
            traceContentBottom:
              pageRect.bottom - Number.parseFloat(pageStyles.paddingBottom),
            traceListClientHeight: traceList?.clientHeight ?? null,
            traceListOverflowY: traceListStyles?.overflowY ?? null,
            traceListScrollbarWidth: traceListStyles?.scrollbarWidth ?? null,
            traceListScrollHeight: traceList?.scrollHeight ?? null,
            traceListScrollTopAfter: traceList?.scrollTop ?? null,
            traceListWebkitScrollbarDisplay:
              traceListScrollbarStyles?.display ?? null,
            viewportHeight: innerHeight,
            viewportWidth: innerWidth,
          })));
        }));
      };
      measure();
    })
  `);
  if (screenshotPath !== undefined && !interactionScreenshotCaptured) {
    await window.webContents.executeJavaScript(`
      document.querySelector(".desktop-page-scroll").scrollTop = 0
      document.querySelector(".model-trace-list")?.scrollTo({ top: 0 })
    `);
    const image = await window.webContents.capturePage();
    await writeFile(screenshotPath, image.toPNG());
  }
  return { ...metrics, ...interactionMetrics };
};

app
  .whenReady()
  .then(measureDesktopLayout)
  .then(async (metrics) => {
    process.stdout.write(`${JSON.stringify(metrics)}\n`);
    await close(0);
  })
  .catch(async (error) => {
    process.stderr.write(
      `Desktop layout check failed: ${
        error instanceof Error ? error.stack : String(error)
      }\n`,
    );
    await close(1);
  });
