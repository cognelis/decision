const { app, BrowserWindow } = require("electron");
const { readFile, writeFile } = require("node:fs/promises");

const [sourcePath, trayOutputPath] = process.argv.slice(2);
const appOnlyMarkTransform =
  ' transform="translate(512 440) scale(1.22) translate(-512 -512)"';

if (sourcePath === undefined || trayOutputPath === undefined) {
  throw new Error(
    "Usage: electron render-icon-svg.cjs <source.svg> <tray.png>",
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
    const source = await readFile(sourcePath, "utf8");
    const monochrome = source
      .replace(/^.*data-app-background="true".*$/gm, "")
      .replace('viewBox="0 0 1024 1024"', 'viewBox="220 250 584 584"')
      .replace(appOnlyMarkTransform, "")
      .replace('filter="url(#markShadow)" ', "")
      .replaceAll('stroke="url(#decisionGradient)"', 'stroke="#000000"')
      .replaceAll('stroke="url(#secondaryGradient)"', 'stroke="#000000"')
      .replaceAll('fill="url(#decisionGradient)"', 'fill="#000000"')
      .replaceAll('fill="url(#secondaryGradient)"', 'fill="#000000"');
    await renderSvg(monochrome, trayOutputPath);
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
