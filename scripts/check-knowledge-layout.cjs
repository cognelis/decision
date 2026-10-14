const { app, BrowserWindow } = require("electron");
const { writeFile } = require("node:fs/promises");
const { join, resolve } = require("node:path");

const repositoryRoot = resolve(__dirname, "..");
const theme = process.argv[2] ?? "dark";
const mode = process.argv[3] ?? "default";
const screenshotPath = process.argv[4];
const supportedThemes = new Set(["light", "dark"]);
const supportedModes = new Set([
  "default",
  "compact",
  "indexing",
  "semantic-unavailable",
]);

if (!supportedThemes.has(theme)) {
  throw new Error(`Unsupported Obsidian search layout theme: ${theme}`);
}
if (!supportedModes.has(mode)) {
  throw new Error(`Unsupported Obsidian search layout mode: ${mode}`);
}

let server;
let window;

const waitForPage = async (expression, failureMessage) => {
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    if (await window.webContents.executeJavaScript(expression)) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 16));
  }
  throw new Error(failureMessage);
};

const waitForAnimationFrames = () =>
  window.webContents.executeJavaScript(`
    new Promise((resolvePromise) => requestAnimationFrame(
      () => requestAnimationFrame(() => resolvePromise(true))
    ))
  `);

/**
 * `ringSelector` measures the focus ring on a different element than the one
 * that takes focus: the shared search box paints its ring on the field wrapper
 * while focus lives on the bare input inside it.
 */
const focusEvidenceFor = async (selector, ringSelector = selector) => {
  const state = await window.webContents.executeJavaScript(`
    (() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      if (element === null) return "missing";
      if (element.disabled === true || element.tabIndex < 0) {
        element.focus({ preventScroll: true });
        return "disabled";
      }
      const probe = document.createElement("button");
      probe.type = "button";
      probe.dataset.obsidianFocusProbe = "true";
      probe.setAttribute("aria-hidden", "true");
      probe.style.position = "fixed";
      probe.style.width = "1px";
      probe.style.height = "1px";
      probe.style.opacity = "0";
      probe.style.pointerEvents = "none";
      element.parentNode.insertBefore(probe, element);
      probe.focus({ preventScroll: true });
      return "ready";
    })()
  `);
  if (state === "missing") return null;
  if (state === "ready") {
    window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Tab" });
    window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Tab" });
  }
  await waitForAnimationFrames();
  const evidence = await window.webContents.executeJavaScript(`
    (() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      const ring = document.querySelector(${JSON.stringify(ringSelector)});
      const styles = getComputedStyle(ring);
      const bounds = ring.getBoundingClientRect();
      const resultBounds = ring.closest(
        ".obsidian-search-result"
      )?.getBoundingClientRect() ?? null;
      const outlineOffset = Number.parseFloat(styles.outlineOffset);
      const outlineWidth = Number.parseFloat(styles.outlineWidth);
      const outlineExtent = outlineWidth + outlineOffset;
      return {
        active: document.activeElement === element,
        boxShadow: styles.boxShadow,
        enabled: element.disabled !== true && element.tabIndex >= 0,
        focusVisible: element.matches(":focus-visible"),
        indicatorWithinResultBounds: resultBounds === null
          ? null
          : styles.boxShadow.includes("inset") || (
              bounds.left - outlineExtent >= resultBounds.left - 0.5 &&
              bounds.right + outlineExtent <= resultBounds.right + 0.5 &&
              bounds.top - outlineExtent >= resultBounds.top - 0.5 &&
              bounds.bottom + outlineExtent <= resultBounds.bottom + 0.5
            ),
        outlineColor: styles.outlineColor,
        outlineOffset,
        outlineStyle: styles.outlineStyle,
        outlineWidth,
      };
    })()
  `);
  await window.webContents.executeJavaScript(`
    document.querySelector('[data-obsidian-focus-probe="true"]')?.remove();
    true
  `);
  return evidence;
};

const close = require("./electron-check-lifecycle.cjs").createElectronCheckLifecycle({
  app, getWindow: () => window, getServer: () => server,
});

const measureObsidianSearchLayout = async () => {
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
    throw new Error("Obsidian search layout server did not start");
  }
  const port = typeof address === "string" ? null : address.port;
  if (port === null) throw new Error(`Unexpected address: ${address}`);

  const compact = mode === "compact";
  window = new BrowserWindow({
    width: compact ? 860 : 1160,
    height: compact ? 620 : 760,
    show: true,
    frame: false,
    // Kept at this size on a smaller display (GitHub's macOS runner is 1024x768), which clamps a window otherwise.
    enableLargerThanScreen: true,
    transparent: true,
    backgroundColor: "#00000000",
    webPreferences: { partition: `preview-${process.pid}`, backgroundThrottling: false, offscreen: true },
  });
  await window.loadURL(
    `http://127.0.0.1:${port}/?preview=decisions&theme=${theme}&interaction=${mode}`,
  );
  await require("./preview-sidebar.cjs").expandSidebar(window);
  window.focus();
  window.webContents.focus();

  const shouldSearch = mode !== "indexing";
  await waitForPage(
    `Boolean(
      document.querySelector(".decision-library-panel") &&
      document.querySelector(".decision-search-field input") &&
      document.querySelector(".vault-note-results") &&
      document.querySelector(".obsidian-search-state")
    )`,
    "Knowledge page did not render",
  );
  if (shouldSearch) {
    await window.webContents.executeJavaScript(`
      (() => {
        const input = document.querySelector(".decision-search-field input");
        const nativeValueSetter = Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          "value"
        )?.set;
        if (input === null || nativeValueSetter === undefined) {
          throw new Error("Native search input setter is unavailable");
        }
        nativeValueSetter.call(input, "本地语义发布线索");
        input.dispatchEvent(new Event("input", { bubbles: true }));
      })()
    `);
    // The shared box debounces into both halves; no submit to dispatch.
    await waitForPage(
      `document.querySelectorAll(".obsidian-search-result").length >= 10`,
      "Synthetic Obsidian search results did not render",
    );
  }
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  const resultActionFocus = await focusEvidenceFor(
    ".obsidian-search-result-action",
  );
  const rebuildFocus = await focusEvidenceFor(
    ".obsidian-search-rebuild",
  );
  const inputFocus = await focusEvidenceFor(
    ".decision-search-field input",
    ".decision-search-field",
  );

  const metrics = await window.webContents.executeJavaScript(`
    (() => {
        const appShell = document.querySelector(".desktop-app");
        const sidebar = document.querySelector(".desktop-sidebar");
        const stage = document.querySelector(".desktop-stage");
        const page = document.querySelector(".decision-library-panel");
        const panel = page?.querySelector(".vault-note-results");
        const header = page?.querySelector(".desktop-view-header");
        const heading = header?.querySelector("h1");
        const description = header?.querySelector("p");
        const content = page?.querySelector(".decision-library-content");
        const form = page?.querySelector(".decision-search-control");
        const field = page?.querySelector(".decision-search-field");
        const input = field?.querySelector("input");
        const submit = panel?.querySelector(".obsidian-search-rebuild");
        const privacy = panel?.querySelector(".obsidian-search-privacy");
        const status = panel?.querySelector(".obsidian-search-state");
        const coverage = panel?.querySelector(".obsidian-search-coverage");
        const statusStrip = panel?.querySelector(
          ".obsidian-search-status-strip"
        );
        const rebuild = panel?.querySelector(".obsidian-search-rebuild");
        const results = panel?.querySelector(".obsidian-search-results");
        const resultRows = [...panel?.querySelectorAll(".obsidian-search-result") ?? []];
        const resultActions = [...panel?.querySelectorAll(".obsidian-search-result-action") ?? []];
        const userFields = [...panel?.querySelectorAll(
          ".obsidian-search-result-title, .obsidian-search-result-path, .obsidian-search-result-heading, .obsidian-search-result-snippet"
        ) ?? []];
        const instruction = panel?.querySelector(".obsidian-search-instruction");
        if (
          appShell === null || sidebar === null || stage === null || panel === null ||
          header === null || heading === null || description === null ||
          content === null || form === null || field === null || input === null ||
          submit === null || privacy === null || status === null ||
          coverage === null || statusStrip === null || rebuild === null
        ) throw new Error("Obsidian search layout did not become measurable");
          const isVisible = (element) => {
            const bounds = element.getBoundingClientRect();
            const styles = getComputedStyle(element);
            return bounds.width > 1 && bounds.height > 1 &&
              styles.visibility !== "hidden" && styles.display !== "none";
          };
          const isInsideViewport = (element) => {
            const bounds = element.getBoundingClientRect();
            return bounds.left >= -1 && bounds.right <= innerWidth + 1 &&
              bounds.top >= -1 && bounds.bottom <= innerHeight + 1;
          };
          const formBounds = form.getBoundingClientRect();
          const panelBounds = panel.getBoundingClientRect();
          const contentBounds = content.getBoundingClientRect();
          const statusStripBounds = statusStrip.getBoundingClientRect();
          const fieldBounds = field.getBoundingClientRect();
          const inputBounds = input.getBoundingClientRect();
          const submitBounds = submit.getBoundingClientRect();
          const resultPathStyles = resultRows.map((row) => {
            const path = row.querySelector(".obsidian-search-result-path");
            return path === null ? null : getComputedStyle(path);
          }).filter(Boolean);
          const resultsClientHeight = results?.clientHeight ?? null;
          const resultsScrollHeight = results?.scrollHeight ?? null;
          let resultsScrollTopAfter = null;
          if (results !== null) {
            results.scrollTop = results.scrollHeight - results.clientHeight;
            resultsScrollTopAfter = results.scrollTop;
          }
          const allWidthTargets = [
            panel, content, form, field, input, submit, coverage, rebuild,
            ...resultRows, ...resultActions, ...userFields,
          ];
          const rootStyles = getComputedStyle(document.documentElement);
          const scrollingElement = document.scrollingElement;
          const body = document.body;
          const panelStyles = getComputedStyle(panel);
          const statusStripStyles = getComputedStyle(statusStrip);
          const firstResult = resultRows[0] ?? null;
          const firstResultTitle = firstResult?.querySelector(
            ".obsidian-search-result-title"
          ) ?? null;
          return {
            appClientHeight: appShell.clientHeight,
            appScrollHeight: appShell.scrollHeight,
            appScrollWidth: appShell.scrollWidth,
            contentClientHeight: content.clientHeight,
            contentWidth: contentBounds.width,
            contentOverflowY: getComputedStyle(content).overflowY,
            contentScrollHeight: content.scrollHeight,
            computedTheme: {
              panelBackground: panelStyles.backgroundColor,
              panelColor: panelStyles.color,
              resultBackground: firstResult === null
                ? null
                : getComputedStyle(firstResult).backgroundColor,
              resultColor: firstResultTitle === null
                ? null
                : getComputedStyle(firstResultTitle).color,
              statusBackground: statusStripStyles.backgroundColor,
              statusColor: getComputedStyle(status).color,
            },
            coverageVisible: isVisible(coverage),
            description: description.textContent?.trim() ?? "",
            descriptionVisible: isVisible(description),
            // The note card must never clip its own chrome: an index strip cut
            // in half hides how much of the vault is actually searchable.
            noteChromeFits: statusStripBounds.bottom <= panelBounds.bottom + 1 &&
              statusStrip.scrollHeight <= statusStrip.clientHeight + 1 &&
              statusStripBounds.top >= panelBounds.top - 1,
            formFits: form.scrollWidth <= form.clientWidth + 1 &&
              fieldBounds.left >= formBounds.left - 1 &&
              fieldBounds.right <= formBounds.right + 1,
            // The decision card clips what overflows it, so a toolbar wider
            // than the card puts its later filters out of reach entirely.
            decisionToolbarFits: (() => {
              const card = document.querySelector(".decision-library-card");
              if (card === null) return null;
              return card.scrollWidth <= card.clientWidth + 1;
            })(),
            heading: heading.textContent?.trim() ?? "",
            headingVisible: isVisible(heading),
            hybridResultCount: panel.querySelectorAll(".obsidian-search-match.hybrid").length,
            indexingInstructionVisible: instruction !== null && isVisible(instruction),
            inputDisabled: input.disabled,
            inputFocus: ${JSON.stringify(inputFocus)},
            inputHeight: inputBounds.height,
            keywordResultCount: panel.querySelectorAll(".obsidian-search-match.keyword").length,
            mode: ${JSON.stringify(mode)},
            navigationLabels: Array.from(
              document.querySelectorAll(".desktop-nav-item > span"),
              (node) => node.textContent
            ),
            noHorizontalOverflow: document.documentElement.scrollWidth <= innerWidth &&
              allWidthTargets.every((element) => element.scrollWidth <= element.clientWidth + 1),
            outerScroll: {
              bodyClientHeight: body.clientHeight,
              bodyClientWidth: body.clientWidth,
              bodyScrollHeight: body.scrollHeight,
              bodyScrollWidth: body.scrollWidth,
              documentClientHeight: scrollingElement.clientHeight,
              documentClientWidth: scrollingElement.clientWidth,
              documentScrollHeight: scrollingElement.scrollHeight,
              documentScrollWidth: scrollingElement.scrollWidth,
            },
            privacy: privacy.textContent?.trim() ?? "",
            privacyVisible: isVisible(privacy),
            rebuildFocus: ${JSON.stringify(rebuildFocus)},
            resultActionFocus: ${JSON.stringify(resultActionFocus)},
            resultActionReachable: resultActions.length > 0 && resultActions.every(
              (action) => !action.disabled && action.tabIndex >= 0 &&
                action.getBoundingClientRect().width > 1
            ),
            resultCount: resultRows.length,
            resultFieldsFit: userFields.every(
              (element) => element.scrollWidth <= element.clientWidth + 1
            ) && resultActions.every(
              (element) => element.scrollWidth <= element.clientWidth + 1
            ),
            resultPathOverflowWrap: resultPathStyles.map((styles) => styles.overflowWrap),
            resultPathTextOverflow: resultPathStyles.map((styles) => styles.textOverflow),
            resultsClientHeight,
            resultsOverflowY: results === null ? null : getComputedStyle(results).overflowY,
            resultsScrollHeight,
            resultsScrollTopAfter,
            searchControlsReachable: isInsideViewport(input) && isInsideViewport(submit),
            semanticResultCount: panel.querySelectorAll(".obsidian-search-match.semantic").length,
            sidebarWidth: sidebar.getBoundingClientRect().width,
            panelWidth: panelBounds.width,
            stageClientHeight: stage.clientHeight,
            stageOverflowY: getComputedStyle(stage).overflowY,
            stageScrollHeight: stage.scrollHeight,
            stageWidth: stage.getBoundingClientRect().width,
            status: status.textContent?.trim() ?? "",
            statusStripWidth: statusStripBounds.width,
            statusVisible: isVisible(status),
            submitHeight: submitBounds.height,
            theme: ${JSON.stringify(theme)},
            viewportHeight: innerHeight,
            viewportWidth: innerWidth,
            tokens: {
              surface: rootStyles.getPropertyValue("--surface").trim(),
              surfaceInset: rootStyles.getPropertyValue("--surface-inset").trim(),
              text: rootStyles.getPropertyValue("--text").trim(),
              window: rootStyles.getPropertyValue("--window").trim(),
            },
          };
    })()
  `);

  if (screenshotPath !== undefined) {
    const image = await window.webContents.capturePage();
    await writeFile(screenshotPath, image.toPNG());
  }
  return metrics;
};

app.whenReady().then(async () => {
  try {
    const metrics = await measureObsidianSearchLayout();
    process.stdout.write(`${JSON.stringify(metrics)}\n`);
    await close(0);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    await close(1);
  }
});
