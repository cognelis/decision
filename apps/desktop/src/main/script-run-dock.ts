import { app } from "electron";

import { readParaselfEnvironment } from "../../../../config/paraself-environment.mjs";

// The main process's first import, so that it runs before the rest load: hidden after them, a run started by a
// script (smoke) stood in the Dock for a second each time (IMP-133).
if (readParaselfEnvironment(process.env, "SMOKE") === "1") app.dock?.hide();
