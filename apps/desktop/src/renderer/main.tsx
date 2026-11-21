import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App.js";
import { AppErrorBoundary } from "./components/AppErrorBoundary.js";
import { createPreviewApi } from "./preview-api.js";
import "./styles.css";

const container = document.getElementById("root");
if (container === null) {
  throw new Error("Paraself renderer root is missing");
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
