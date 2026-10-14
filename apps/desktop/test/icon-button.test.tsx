// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { StrictMode, useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { IconButton, ActionIcon } from "../src/renderer/components/IconButton.js";
import { ModalDialog } from "../src/renderer/components/ModalDialog.js";

afterEach(cleanup);

it("shows a portal tooltip on hover, hides on leave and scroll, and preserves clicks", () => {
  const click = vi.fn();
  const view = render(<div style={{ overflow: "hidden" }}><IconButton aria-label="打开来源" onClick={click}><ActionIcon name="open" /></IconButton></div>);
  const button = screen.getByRole("button", { name: "打开来源" });
  fireEvent.mouseEnter(button);
  const tooltip = screen.getByRole("tooltip");
  expect(tooltip).toHaveTextContent("打开来源");
  expect(tooltip.parentElement).toBe(document.body);
  expect(view.container).not.toContainElement(tooltip);
  fireEvent.mouseLeave(button);
  expect(screen.queryByRole("tooltip")).toBeNull();
  fireEvent.focus(button);
  expect(screen.getByRole("tooltip")).toBeVisible();
  fireEvent.scroll(window);
  expect(screen.queryByRole("tooltip")).toBeNull();
  fireEvent.click(button);
  expect(click).toHaveBeenCalledTimes(1);
});

it("dismisses the tooltip without blocking the dialog Escape shortcut", () => {
  const close = vi.fn();
  render(<ModalDialog title="设置" onClose={close}><p>内容</p></ModalDialog>);
  const button = screen.getByRole("button", { name: "关闭设置" });
  fireEvent.focus(button);
  expect(screen.getByRole("tooltip")).toBeVisible();
  fireEvent.keyDown(button, { key: "Escape" });
  expect(screen.queryByRole("tooltip")).toBeNull();
  expect(close).toHaveBeenCalledTimes(1);
});

it("returns focus to the opener even when the dialog autofocuses a field", async () => {
  const Harness = () => {
    const [open, setOpen] = useState(false);
    return <><button onClick={() => setOpen(true)}>打开</button>{open ? <ModalDialog title="编辑" onClose={() => setOpen(false)}><input aria-label="名称" autoFocus /></ModalDialog> : null}</>;
  };
  render(<StrictMode><Harness /></StrictMode>);
  const opener = screen.getByRole("button", { name: "打开" });
  opener.focus();
  fireEvent.click(opener);
  await new Promise(resolve => requestAnimationFrame(resolve));
  expect(screen.getByLabelText("名称")).toHaveFocus();
  fireEvent.keyDown(screen.getByLabelText("名称"), { key: "Escape" });
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(opener).toHaveFocus();
});

it("returns focus to what opened the first dialog when a second one took its place", () => {
  const Harness = () => {
    const [open, setOpen] = useState<"a" | "b" | null>(null);
    return <><button onClick={() => setOpen("a")}>打开 A</button>
      {open === "a" ? <ModalDialog title="A" onClose={() => setOpen(null)}><button onClick={() => setOpen("b")}>换成 B</button></ModalDialog> : null}
      {open === "b" ? <ModalDialog title="B" onClose={() => setOpen(null)}><input aria-label="B 的内容" /></ModalDialog> : null}</>;
  };
  render(<StrictMode><Harness /></StrictMode>);
  const opener = screen.getByRole("button", { name: "打开 A" });
  opener.focus();
  fireEvent.click(opener);
  const swap = screen.getByRole("button", { name: "换成 B" });
  swap.focus();
  fireEvent.click(swap);
  // The reader works in the second dialog before closing it.
  screen.getByLabelText("B 的内容").focus();
  fireEvent.keyDown(screen.getByLabelText("B 的内容"), { key: "Escape" });
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(opener).toHaveFocus();
});

it("keeps disabled actions inert", () => {
  const click = vi.fn();
  render(<IconButton aria-label="移除" disabled onClick={click}><ActionIcon name="close" /></IconButton>);
  const button = screen.getByRole("button", { name: "移除" });
  fireEvent.mouseEnter(button);
  fireEvent.click(button);
  expect(screen.queryByRole("tooltip")).toBeNull();
  expect(click).not.toHaveBeenCalled();
});
