const { app, BrowserWindow } = require("electron");
const { readFile, writeFile } = require("node:fs/promises");

const [sourcePath, outputPath] = process.argv.slice(2);

if (sourcePath === undefined || outputPath === undefined) {
  throw new Error(
    "Usage: electron render-icon-svg.cjs <source.svg> <output.png>",
  );
}

const renderSvg = async (svg, outputPath) => {
  const window = new BrowserWindow({
    width: 1024,
    height: 1024,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    webPreferences: {
      offscreen: true,
    },
  });
  const document = [
    "<!doctype html>",
    '<meta charset="utf-8">',
    "<style>",
    "html,body{width:100%;height:100%;margin:0;background:transparent;overflow:hidden}",
    "svg{display:block;width:100%;height:100%}",
    "</style>",
    svg,
  ].join("");
  await window.loadURL(
    `data:text/html;charset=utf-8,${encodeURIComponent(document)}`,
  );
  const image = await window.webContents.capturePage();
  await writeFile(outputPath, image.toPNG());
  window.destroy();
};

app
  .whenReady()
  .then(async () => {
    await renderSvg(await readFile(sourcePath, "utf8"), outputPath);
    app.quit();
  })
  .catch((error) => {
    process.stderr.write(
      `Icon rendering failed: ${
        error instanceof Error ? error.stack : String(error)
      }\n`,
    );
    app.exit(1);
  });
