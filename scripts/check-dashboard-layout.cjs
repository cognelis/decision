const { app, BrowserWindow } = require("electron");
const { writeFile } = require("node:fs/promises");
const { join, resolve } = require("node:path");

const repositoryRoot = resolve(__dirname, "..");
const theme = process.argv[2] ?? "dark";
const thirdArgument = process.argv[3];
const mode =
  thirdArgument === "compact" ||
  thirdArgument === "rationale-dialog" ||
  thirdArgument === "rationale-continuous" ||
  thirdArgument === "rationale-compact" ||
  thirdArgument === "tall"
    ? thirdArgument
    : "default";
const compact = mode === "compact" || mode === "rationale-compact";
const continuous = mode === "rationale-continuous" || mode === "rationale-compact";
const tall = mode === "tall";
const screenshotPath = mode === "default" ? thirdArgument : process.argv[4];
if (theme !== "light" && theme !== "dark") {
  throw new Error(`Unsupported dashboard layout theme: ${theme}`);
}
let server;
let window;

const close = require("./electron-check-lifecycle.cjs").createElectronCheckLifecycle({
  app, getWindow: () => window, getServer: () => server,
});

const measureDashboardLayout = async () => {
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
    throw new Error("Dashboard layout server did not start");
  }
  const port = typeof address === "string" ? null : address.port;
  if (port === null) throw new Error(`Unexpected address: ${address}`);

  window = new BrowserWindow({
    width: compact ? 860 : 1160,
    height: compact ? 620 : tall ? 900 : 760,
    show: false,
    frame: false,
    // Kept at this size on a smaller display (GitHub's macOS runner is 1024x768), which clamps a window otherwise.
    enableLargerThanScreen: true,
    transparent: true,
    backgroundColor: "#00000000",
    webPreferences: { partition: `preview-${process.pid}`, backgroundThrottling: false, offscreen: true },
  });
  await window.loadURL(
    `http://127.0.0.1:${port}/?preview=dashboard&theme=${theme}`,
  );
  await require("./preview-sidebar.cjs").expandSidebar(window);

  let interactionMetrics = {};
  if (mode === "rationale-dialog" || continuous) {
    interactionMetrics = await window.webContents.executeJavaScript(`
      new Promise((resolve, reject) => {
        const deadline = Date.now() + 12000;
        const openDialog = () => {
          const button = [...document.querySelectorAll("button")].find(
            (candidate) => (candidate.getAttribute("aria-label") ?? candidate.textContent?.trim()) === ${JSON.stringify(continuous ? "连续补充" : "补充理由")}
          );
          const card = document.querySelector(".dashboard-rationale-card");
          const scroll = document.querySelector(".dashboard-scroll");
          if (button === undefined || card === null || scroll === null) {
            if (Date.now() >= deadline) {
              reject(new Error("Pending rationale action did not render"));
              return;
            }
            setTimeout(openDialog, 16);
            return;
          }
          const cardHeightBefore = card.getBoundingClientRect().height;
          const scrollHeightBefore = scroll.scrollHeight;
          button.click();
          const measureDialog = () => {
            const dialog = document.querySelector('[role="dialog"]');
            const textarea = dialog?.querySelector("textarea");
            if (dialog === null || textarea === null) {
              if (Date.now() >= deadline) {
                reject(new Error("Pending rationale dialog did not open"));
                return;
              }
              setTimeout(measureDialog, 16);
              return;
            }
            requestAnimationFrame(() => requestAnimationFrame(() => {
              const dialogRect = dialog.getBoundingClientRect();
              const editorRect = textarea.getBoundingClientRect();
              const actions = dialog.querySelector(".rationale-workspace-actions").getBoundingClientRect();
              const composer = dialog.querySelector(".rationale-composer");
              resolve({
                rationaleActionsVisible: actions.bottom <= innerHeight && actions.top >= dialogRect.top,
                rationaleEditorVisible: editorRect.top >= dialogRect.top && editorRect.bottom <= actions.top,
                rationaleComposerFits: composer.scrollHeight <= composer.clientHeight + 1,
                rationaleProgressVisible: dialog.querySelector("progress") !== null,
                rationaleCardHeightStable:
                  Math.abs(card.getBoundingClientRect().height - cardHeightBefore) < 1,
                rationaleDialogCentered:
                  Math.abs(
                    dialogRect.top + dialogRect.height / 2 - innerHeight / 2
                  ) < 2,
                rationaleDialogOpen: true,
                rationaleEditorInsideDialog: dialog.contains(textarea),
                rationaleEditorFocused: document.activeElement === textarea,
                rationalePageHeightStable: scroll.scrollHeight === scrollHeightBefore,
              });
            }));
          };
          measureDialog();
        };
        openDialog();
      })
    `);
  }

  const metrics = await window.webContents.executeJavaScript(`
    new Promise((resolve, reject) => {
      const deadline = Date.now() + 12000;
      const measure = () => {
        const appShell = document.querySelector(".desktop-app");
        const sidebar = document.querySelector(".desktop-sidebar");
        const brandIcon = document.querySelector(".desktop-brand-icon");
        const stage = document.querySelector(".desktop-stage");
        const header = document.querySelector(".desktop-view-header");
        const heading = header?.querySelector("h1");
        const scroll = document.querySelector(".dashboard-scroll");
        const startButton = [...document.querySelectorAll("button")]
          .find((button) => button.textContent?.trim() === "开始处理");
        const rationaleButton = [...document.querySelectorAll("button")]
          .find((button) => button.textContent?.trim() === "补充理由");
        const discardButton = [...document.querySelectorAll("button")]
          .find((button) => button.textContent?.trim() === "不保留");
        const rationaleList = document.querySelector(
          ".dashboard-rationale-list"
        );
        const rationaleRows = [
          ...document.querySelectorAll(".dashboard-rationale-row"),
        ];
        const rationaleContext = document.querySelector(
          ".dashboard-rationale-context"
        );
        const rationaleDescription = document.querySelector(
          ".dashboard-rationale-description"
        );
        const historyBadge = document.querySelector(".dashboard-history-badge");
        const recentList = document.querySelector(".recent-decision-list");
        const recentCard = recentList?.closest(".dashboard-recent-card");
        const summary = document.querySelector(".dashboard-summary");
        const summaryItems = [
          ...document.querySelectorAll(".dashboard-summary-item"),
        ];
        const cardHeaders = [
          ...document.querySelectorAll(".dashboard-card-header"),
        ];
        if (
          appShell === null || sidebar === null || brandIcon === null || stage === null ||
          header === null || heading === null || scroll === null ||
          startButton === undefined || rationaleButton === undefined ||
          discardButton === undefined || rationaleList === null ||
          rationaleRows.length < 3 || rationaleContext === null ||
          rationaleDescription === null || historyBadge === null ||
          recentList === null ||
          recentCard === null ||
          summary === null ||
          summaryItems.length !== 4 ||
          cardHeaders.length === 0
        ) {
          if (Date.now() >= deadline) {
            reject(new Error("Desktop dashboard layout did not render"));
            return;
          }
          setTimeout(measure, 16);
          return;
        }
        requestAnimationFrame(() => requestAnimationFrame(() => {
          const startBounds = startButton.getBoundingClientRect();
          const headingBounds = heading.getBoundingClientRect();
          const rationaleBounds = rationaleButton.getBoundingClientRect();
          const discardBounds = discardButton.getBoundingClientRect();
          const firstSummaryTop = summaryItems[0].getBoundingClientRect().top;
          const scrollBounds = scroll.getBoundingClientRect();
          const stageBounds = stage.getBoundingClientRect();
          const scrollStyles = getComputedStyle(scroll);
          const summaryBounds = summary.getBoundingClientRect();
          const recentListStyles = getComputedStyle(recentList);
          const brandIconStyles = getComputedStyle(brandIcon);
          const recentListScrollbarStyles = getComputedStyle(
            recentList,
            "::-webkit-scrollbar",
          );
          const summaryColumns = summaryItems.filter((item) =>
            Math.abs(item.getBoundingClientRect().top - firstSummaryTop) < 1
          ).length;
          const maximumScrollTop = scroll.scrollHeight - scroll.clientHeight;
          recentList.scrollTop =
            recentList.scrollHeight - recentList.clientHeight;
          scroll.scrollTop = maximumScrollTop;
          requestAnimationFrame(() => requestAnimationFrame(() => {
            const recentItems = [...recentList.querySelectorAll(":scope > li")];
            const recentCardBounds = recentCard.getBoundingClientRect();
            const recentListBounds = recentList.getBoundingClientRect();
            const lastRecentItemBounds = recentItems.at(-1)?.getBoundingClientRect();
            resolve({
              appClientHeight: appShell.clientHeight,
              appScrollHeight: appShell.scrollHeight,
              brandIconBorderRadius: Number.parseFloat(
                brandIconStyles.borderTopLeftRadius,
              ),
              cardHeaderHeights: cardHeaders.map(
                (cardHeader) => cardHeader.getBoundingClientRect().height,
              ),
              cardHeadersSingleRow: cardHeaders.every((cardHeader) => {
                const titleGroup = cardHeader.querySelector(":scope > div");
                if (titleGroup === null) return false;
                const styles = getComputedStyle(titleGroup);
                return styles.display === "flex" && styles.flexDirection === "row";
              }),
              rationaleDescriptionWhiteSpace: getComputedStyle(
                rationaleDescription,
              ).whiteSpace,
              clientHeight: scroll.clientHeight,
              clientWidth: scroll.clientWidth,
              headerHeight: header.getBoundingClientRect().height,
              heading: heading.textContent?.trim() ?? "",
              headingVisible:
                headingBounds.width > 1 && headingBounds.height > 1,
              historyBadge: historyBadge.textContent?.trim() ?? "",
              navigationLabels: Array.from(
                document.querySelectorAll(".desktop-nav-item > span"),
                (node) => node.textContent,
              ),
              overflowY: getComputedStyle(scroll).overflowY,
              pageContentLeftInset: summaryBounds.left - scrollBounds.left,
              pageContentRightInset: scrollBounds.right - summaryBounds.right,
              pagePaddingBottom: Number.parseFloat(scrollStyles.paddingBottom),
              pagePaddingLeft: Number.parseFloat(scrollStyles.paddingLeft),
              pagePaddingRight: Number.parseFloat(scrollStyles.paddingRight),
              pagePaddingTop: Number.parseFloat(scrollStyles.paddingTop),
              visualTopInset: summaryBounds.top - stageBounds.top,
              rationaleButtonHeight: rationaleBounds.height,
              rationaleButtonWidth: rationaleBounds.width,
              rationaleDiscardButtonHeight: discardBounds.height,
              rationaleDiscardButtonWidth: discardBounds.width,
              rationaleContextWidth:
                rationaleContext.getBoundingClientRect().width,
              rationaleDescription:
                rationaleDescription.textContent?.trim() ?? "",
              rationaleListClientHeight: rationaleList.clientHeight,
              rationaleListOverflowY: getComputedStyle(rationaleList).overflowY,
              rationaleListScrollHeight: rationaleList.scrollHeight,
              rationaleRowMaxHeight: Math.max(
                ...rationaleRows.map((row) => row.getBoundingClientRect().height)
              ),
              recentListClientHeight: recentList.clientHeight,
              recentListOverflowY: recentListStyles.overflowY,
              recentListScrollbarWidth: recentListStyles.scrollbarWidth,
              recentListScrollHeight: recentList.scrollHeight,
              recentListScrollTopAfter: recentList.scrollTop,
              recentLastItemBottom: lastRecentItemBounds?.bottom ?? null,
              recentLastItemFullyVisible:
                lastRecentItemBounds !== undefined &&
                lastRecentItemBounds.bottom <= recentListBounds.bottom + 1,
              recentListBottom: recentListBounds.bottom,
              recentListSafeGap:
                lastRecentItemBounds === undefined
                  ? null
                  : recentListBounds.bottom - lastRecentItemBounds.bottom,
              recentListWithinCard:
                recentListBounds.bottom <= recentCardBounds.bottom + 1,
              recentListWebkitScrollbarDisplay:
                recentListScrollbarStyles.display,
              recentCardBottomAfterScroll: recentCardBounds.bottom,
              recentCardContentBottomGap:
                scrollBounds.bottom -
                Number.parseFloat(scrollStyles.paddingBottom) -
                recentCardBounds.bottom,
              visualBottomInset: stageBounds.bottom - recentCardBounds.bottom,
              scrollHeight: scroll.scrollHeight,
              scrollTopAfter: scroll.scrollTop,
              scrollWidth: scroll.scrollWidth,
              sidebarWidth: sidebar.getBoundingClientRect().width,
              stageWidth: stage.getBoundingClientRect().width,
              startButtonHeight: startBounds.height,
              startButtonWidth: startBounds.width,
              summaryColumns,
              summaryInteractiveCount: summaryItems.filter(
                (item) =>
                  item.tagName === "BUTTON" &&
                  item.classList.contains("interactive")
              ).length,
              summaryItemHeights: summaryItems.map(
                (item) => item.getBoundingClientRect().height
              ),
              recentItemsAreButtons: recentItems.every(
                (item) => item.firstElementChild?.tagName === "BUTTON"
              ),
              // The two bottom actions are one block. Each pushing itself
              // down would leave the free space between them instead.
              sidebarActionGaps: (() => {
                const boxes = [
                  ...document.querySelectorAll(".desktop-shortcut-help"),
                ].map((action) => action.getBoundingClientRect());
                return boxes
                  .slice(1)
                  .map((box, index) =>
                    Math.round(box.top - boxes[index].bottom)
                  );
              })(),
              sidebarActionLabels: [
                ...document.querySelectorAll(".desktop-shortcut-help"),
              ].map((button) => button.getAttribute("aria-label") ?? ""),
              sidebarActionsFit: (() => {
                const actions = [
                  ...document.querySelectorAll(".desktop-shortcut-help"),
                ];
                if (actions.length === 0) return false;
                const sidebarBounds = sidebar.getBoundingClientRect();
                const boxes = actions.map((action) =>
                  action.getBoundingClientRect()
                );
                const inside = boxes.every(
                  (box) =>
                    box.width > 0 &&
                    box.height > 0 &&
                    box.left >= sidebarBounds.left &&
                    box.right <= sidebarBounds.right + 1 &&
                    box.bottom <= sidebarBounds.bottom + 1
                );
                // Two stacked buttons can each be inside the sidebar and still
                // be painted over one another; overflow alone never says so.
                const separate = boxes.every((box, index) =>
                  boxes.every(
                    (other, otherIndex) =>
                      index === otherIndex ||
                      box.right <= other.left + 1 ||
                      other.right <= box.left + 1 ||
                      box.bottom <= other.top + 1 ||
                      other.bottom <= box.top + 1
                  )
                );
                return inside && separate;
              })(),
              viewportHeight: innerHeight,
              viewportWidth: innerWidth,
            });
          }));
        }));
      };
      measure();
    })
  `);

  if (screenshotPath !== undefined) {
    await window.webContents.executeJavaScript(
      compact
        ? `
          const scroll = document.querySelector(".dashboard-scroll")
          const recentCard = document.querySelector(".dashboard-recent-card")
          const recentList = document.querySelector(".recent-decision-list")
          scroll.scrollTop += recentCard.getBoundingClientRect().top -
            scroll.getBoundingClientRect().top - 12
          recentList.scrollTop = recentList.scrollHeight
        `
        : `
          document.querySelector(".dashboard-scroll").scrollTop = 0
          document.querySelector(".recent-decision-list").scrollTop = 0
        `,
    );
    const image = await window.webContents.capturePage();
    await writeFile(screenshotPath, image.toPNG());
  }
  return { ...metrics, ...interactionMetrics };
};

app
  .whenReady()
  .then(measureDashboardLayout)
  .then(async (metrics) => {
    process.stdout.write(`${JSON.stringify(metrics)}\n`);
    await close(0);
  })
  .catch(async (error) => {
    process.stderr.write(
      `Dashboard layout check failed: ${
        error instanceof Error ? error.stack : String(error)
      }\n`,
    );
    await close(1);
  });
