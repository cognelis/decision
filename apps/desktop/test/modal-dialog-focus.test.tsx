// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it } from "vitest";

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
