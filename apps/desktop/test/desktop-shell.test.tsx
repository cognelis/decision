// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { DecisionApi } from "../src/shared/renderer-api.js";
import {
  DesktopShell,
  type DesktopSurface,
} from "../src/renderer/components/DesktopShell.js";
import { createPreviewApi } from "../src/renderer/preview-api.js";
import { rationaleSnapshot } from "./app-fixtures.js";

/**
 * The shell carries the app's only global shortcuts. Until now it was exercised
 * only sideways, through App, which cannot put it in the states that matter here.
 */

const renderShell = (
  overrides: {
    activeSurface?: DesktopSurface;
    reviewActivity?: Parameters<typeof DesktopShell>[0]["reviewActivity"];
  } = {},
) => {
  const api: DecisionApi = createPreviewApi();
  render(
    <DesktopShell
      snapshot={rationaleSnapshot({ current: null, primarySurface: "dashboard" })}
      activeSurface={overrides.activeSurface ?? "decisions"}
      quickJumpApi={api}
      recordApi={api}
      reviewActivity={overrides.reviewActivity ?? null}
      onNavigate={vi.fn()}
      onRecorded={vi.fn()}
      onOpenDecision={vi.fn()}
      onOpenJournalEntry={vi.fn()}
      onOpenPrinciple={vi.fn()}
    >
      <div />
    </DesktopShell>,
  );
};

afterEach(cleanup);

describe("DesktopShell", () => {
  it("marks the review entry while a review runs and once it has a result not yet seen", () => {
    renderShell({ reviewActivity: "running" });
    expect(screen.getByRole("button", { name: "评审" })).toHaveAttribute("aria-description", "评审进行中");
    cleanup();
    renderShell({ reviewActivity: "done" });
    expect(screen.getByRole("button", { name: "评审" })).toHaveAttribute("aria-description", "有新的评审结果");
    cleanup();
    renderShell();
    expect(screen.getByRole("button", { name: "评审" })).not.toHaveAttribute("aria-description");
  });

  it("locks quick jump and capture during a decision task", () => {
    renderShell({ activeSurface: "task" });

    expect(screen.getByRole("button", { name: /快速跳转/u })).toBeDisabled();
    expect(screen.getByRole("button", { name: /主动记录/u })).toBeDisabled();
  });
});
