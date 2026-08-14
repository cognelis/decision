import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App.js";
import { AppErrorBoundary } from "./components/AppErrorBoundary.js";
import { createPreviewApi } from "./preview-api.js";
import "./styles.css";

if (
  new URLSearchParams(window.location.search).get("nativeGlass") ===
  "1"
) {
  document.documentElement.dataset.nativeGlass = "true";
}

const container = document.getElementById("root");
if (container === null) {
  throw new Error("Decision renderer root is missing");
}

createRoot(container).render(
  <StrictMode>
    <AppErrorBoundary>
      <App
        api={
          window.decision ??
          (import.meta.env.DEV ? createPreviewApi() : undefined)
        }
      />
    </AppErrorBoundary>
  </StrictMode>,
);
