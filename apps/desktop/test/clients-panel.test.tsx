// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { DecisionApi } from "../src/shared/renderer-api.js";
import { ClientsPanel } from "../src/renderer/components/pages/clients/ClientsPanel.js";
import { createPreviewApi } from "../src/renderer/preview-api.js";

const harness = async (overrides: Partial<DecisionApi> = {}) => {
  const preview = createPreviewApi();
  const snapshot = await preview.getSnapshot();
  const api: DecisionApi = { ...preview, ...overrides };
  render(<ClientsPanel snapshot={snapshot} api={api} />);
  return { api, snapshot };
};

afterEach(cleanup);

describe("ClientsPanel", () => {
  it("reads each client's latest decision again as decisions come in", async () => {
    const preview = createPreviewApi();
    const snapshot = await preview.getSnapshot();
    let captured: Awaited<ReturnType<DecisionApi["listDecisions"]>> = [];
    const listDecisions = vi.fn<DecisionApi["listDecisions"]>(async (query) => (query.sourceClient === "claude-code" ? captured : []));
    const api: DecisionApi = { ...preview, listDecisions };
    const view = render(<ClientsPanel snapshot={snapshot} api={api} />);
    await waitFor(() => expect(listDecisions).toHaveBeenCalled());

    // Connected, then tested with one choice in Claude Code: read once, the card went on saying nothing had come in.
    const [first] = await preview.listDecisions({ query: "", limit: 1 });
    captured = [{ ...first!, question: "先用 SQLite 还是直接上 Postgres？" }];
    view.rerender(<ClientsPanel snapshot={{ ...snapshot, dashboard: { ...snapshot.dashboard, totalDecisions: snapshot.dashboard.totalDecisions + 1 } }} api={api} />);
    expect(await screen.findByText(/先用 SQLite 还是直接上 Postgres/u)).toBeVisible();
  });

  it("keeps capture clients separate from platform links", async () => {
    const listPrConnections = vi.fn(async () => []);
    await harness({ listPrConnections });
    expect(screen.getByRole("heading", { name: "Codex" })).toBeVisible();
    expect(screen.getByRole("button", { name: "链接" })).toBeVisible();
    expect(screen.queryByLabelText("访问令牌")).toBeNull();
    expect(listPrConnections).not.toHaveBeenCalled();
  });

  it("asks for repair in the action color only when a client needs it", async () => {
    const preview = createPreviewApi();
    const snapshot = await preview.getSnapshot();
    const view = render(
      <ClientsPanel
        snapshot={{
          ...snapshot,
          integrationStatus: { claudeCode: "installed", codex: "installed" },
        }}
        api={preview}
      />,
    );
    expect(screen.getByRole("button", { name: "安装或修复" })).not.toHaveClass(
      "primary-button",
    );

    view.rerender(
      <ClientsPanel
        snapshot={{
          ...snapshot,
          integrationStatus: { claudeCode: "installed", codex: "not-installed" },
        }}
        api={preview}
      />,
    );
    expect(screen.getByRole("button", { name: "安装或修复" })).toHaveClass(
      "primary-button",
    );
  });
});
