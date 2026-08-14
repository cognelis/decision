// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AppErrorBoundary } from "../src/renderer/components/AppErrorBoundary.js";

const BrokenSurface = () => {
  throw new Error("private /vault path");
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("AppErrorBoundary", () => {
  it("hides exception content and reloads only after explicit action", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const reload = vi.fn();
    const user = userEvent.setup();

    render(
      <AppErrorBoundary reload={reload}>
        <BrokenSurface />
      </AppErrorBoundary>,
    );

    const alert = screen.getByRole("alert", {
      name: "应用界面发生错误",
    });
    expect(alert).toHaveTextContent("重新加载后可继续使用");
    expect(alert).toHaveAccessibleDescription(
      "当前界面无法继续显示，重新加载后可继续使用。",
    );
    expect(alert).not.toHaveTextContent("/vault");
    expect(reload).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "重新加载" }));

    expect(reload).toHaveBeenCalledOnce();
  });

  it("renders healthy children without a recovery surface", () => {
    render(
      <AppErrorBoundary>
        <p>正常界面</p>
      </AppErrorBoundary>,
    );

    expect(screen.getByText("正常界面")).toBeVisible();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
