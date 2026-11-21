// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";

import { ModalDialog } from "../src/renderer/components/ModalDialog.js";

afterEach(cleanup);

it("keeps Shift+Tab inside the dialog when focus is on the dialog itself", async () => {
  const user = userEvent.setup();
  render(
    <>
      <button type="button">页面上的按钮</button>
      <ModalDialog title="补充决策理由" onClose={() => undefined}>
        <p>正文</p>
        <button type="button">保存</button>
      </ModalDialog>
    </>,
  );
  const dialog = screen.getByRole("dialog", { name: "补充决策理由" });
  // Where the dialog puts focus back when a control goes away, and where a click on its text leaves it.
  dialog.focus();

  await user.tab({ shift: true });
  expect(screen.getByRole("button", { name: "保存" })).toHaveFocus();

  dialog.focus();
  await user.tab();
  expect(dialog).toContainElement(document.activeElement as HTMLElement);
});

it("closes from its button when something is typed, as Cancel does, but not from a stray Escape or click outside", () => {
  const onClose = vi.fn();
  const { rerender } = render(<ModalDialog title="编辑链接" unsaved onClose={onClose}><input aria-label="名称" /></ModalDialog>);
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
  fireEvent.mouseDown(document.querySelector(".modal-backdrop")!);
  expect(onClose).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "关闭编辑链接" }));
  expect(onClose).toHaveBeenCalledOnce();

  // While it saves, nothing closes it.
  rerender(<ModalDialog title="编辑链接" unsaved dismissible={false} onClose={onClose}><input aria-label="名称" /></ModalDialog>);
  expect(screen.getByRole("button", { name: "关闭编辑链接" })).toBeDisabled();
});
