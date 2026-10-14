/** Bounded shutdown for layout probes, including Dock quit, signals and a lost test parent. */
exports.createElectronCheckLifecycle = ({ app, getWindow, getServer, runtime = process }) => {
  let closing = false;
  const parentPid = runtime.ppid;
  const dispose = () => {
    clearInterval(parentWatch);
    runtime.removeListener("SIGTERM", terminate);
    runtime.removeListener("SIGINT", interrupt);
    app.removeListener("before-quit", quit);
  };
  const close = async (exitCode) => {
    if (closing) return;
    closing = true;
    // A stuck Vite close must not keep Electron alive after the measurements have finished.
    const forceExit = setTimeout(() => {
      runtime.stderr.write("Electron layout cleanup timed out; forcing exit\n");
      dispose();
      app.exit(exitCode || 1);
    }, 1_000);
    try {
      const window = getWindow();
      if (window && !window.isDestroyed()) window.destroy();
      await getServer()?.close();
    } catch {
      runtime.stderr.write("Electron layout cleanup failed\n");
      exitCode ||= 1;
    } finally {
      clearTimeout(forceExit);
      dispose();
      app.exit(exitCode);
    }
  };
  const terminate = () => { void close(143); };
  const interrupt = () => { void close(130); };
  const quit = event => { event.preventDefault(); void close(0); };
  runtime.on("SIGTERM", terminate);
  runtime.on("SIGINT", interrupt);
  app.on("before-quit", quit);
  const parentWatch = setInterval(() => {
    try {
      if (runtime.ppid !== parentPid || parentPid <= 1) { void close(1); return; }
      runtime.kill(parentPid, 0);
    } catch (error) {
      if (error.code === "ESRCH") void close(1);
    }
  }, 500);
  parentWatch.unref();
  return close;
};
