const { app, BrowserWindow } = require("electron");
const { join, resolve } = require("node:path");

// The candidate review in the minimum window, under an assistant's whole message taken as the question: the header is
// the page's name on one line, the card gives the question whole, and 记录并补充理由, 稍后 and 忽略 sit in one bar
// at the bottom, inside the window.
const repositoryRoot = resolve(__dirname, "..");
const theme = process.argv[2] ?? "light";
if (theme !== "light" && theme !== "dark") {
  throw new Error(`Unsupported candidate layout theme: ${theme}`);
}
let server;
let window;

const close = require("./electron-check-lifecycle.cjs").createElectronCheckLifecycle({
  app, getWindow: () => window, getServer: () => server,
});

const measureCandidateLayout = async () => {
  const { createServer } = await import("vite");
  server = await createServer({
    configFile: join(repositoryRoot, "apps", "desktop", "vite.renderer.config.ts"),
    logLevel: "silent",
    server: { host: "127.0.0.1", port: 0, strictPort: false },
  });
  await server.listen();
  const address = server.httpServer?.address();
  if (address === null || address === undefined || typeof address === "string") {
    throw new Error("Candidate layout server did not start");
  }
  window = new BrowserWindow({
    width: 860,
    height: 620,
    show: false,
    frame: false,
    enableLargerThanScreen: true,
    transparent: true,
    backgroundColor: "#00000000",
    webPreferences: { partition: `preview-${process.pid}`, offscreen: true },
  });
  await window.loadURL(`http://127.0.0.1:${address.port}/?preview=candidate-long&theme=${theme}`);
  return window.webContents.executeJavaScript(`
    new Promise((resolve, reject) => {
      const deadline = Date.now() + 12000;
      const measure = () => {
        const heading = document.querySelector(".candidate-review-header h1");
        const full = document.querySelector(".candidate-question");
        const buttons = [...document.querySelectorAll(".task-actions button")];
        const record = buttons.find((button) => button.textContent.includes("记录并补充理由"));
        const later = buttons.find((button) => button.textContent.includes("稍后"));
        const dismiss = buttons.find((button) => button.textContent.trim().startsWith("忽略"));
        if (heading === null || full === null || record === undefined || later === undefined || dismiss === undefined) {
          if (Date.now() >= deadline) return reject(new Error("Candidate review did not render"));
          return setTimeout(measure, 16);
        }
        requestAnimationFrame(() => requestAnimationFrame(() => {
          const headingRect = heading.getBoundingClientRect();
          const recordRect = record.getBoundingClientRect();
          const dismissRect = dismiss.getBoundingClientRect();
          const laterRect = later.getBoundingClientRect();
          resolve({
            viewportHeight: window.innerHeight,
            headingText: heading.textContent.trim(),
            headingLineHeight: Number.parseFloat(getComputedStyle(heading).lineHeight),
            headingHeight: Math.round(headingRect.height),
            headingBottom: Math.round(headingRect.bottom),
            fullQuestionItems: full.querySelectorAll("li").length,
            actionTops: [recordRect, laterRect, dismissRect].map((rect) => Math.round(rect.top)),
            laterInHeader: later.closest("header") !== null,
            laterBottom: Math.round(laterRect.bottom),
            recordTop: Math.round(recordRect.top),
            recordBottom: Math.round(recordRect.bottom),
            dismissBottom: Math.round(dismissRect.bottom),
          });
        }));
      };
      measure();
    })
  `);
};

app
  .whenReady()
  .then(measureCandidateLayout)
  .then(async (metrics) => {
    process.stdout.write(`${JSON.stringify(metrics)}\n`);
    await close(0);
  })
  .catch(async (error) => {
    process.stderr.write(
      `Candidate layout check failed: ${error instanceof Error ? error.stack : String(error)}\n`,
    );
    await close(1);
  });
