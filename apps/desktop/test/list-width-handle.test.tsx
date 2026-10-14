// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ListWidthHandle } from "../src/renderer/components/ListWidthHandle.js";

afterEach(() => { cleanup(); localStorage.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("resizes by pointer or keyboard, persists each list independently and clamps when the window shrinks", () => {
  let containerWidth = 1000;
  let resize!: () => void;
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(() => containerWidth);
  vi.stubGlobal("ResizeObserver", class { constructor(callback: () => void) { resize = callback; } observe() {} disconnect() {} });
  vi.stubGlobal("PointerEvent", MouseEvent);
  const mount = (key: string) => render(<div><aside id="list" /><ListWidthHandle storageKey={key} label="调整宽度" controls="list" /><main /></div>);
  let view = mount("assistant-width");
  let handle = screen.getByRole("separator");
  Object.assign(handle, { setPointerCapture: vi.fn(), releasePointerCapture: vi.fn() });
  expect(handle).toHaveAttribute("aria-valuenow", "248");
  fireEvent.pointerDown(handle, { button: 0, clientX: 248 });
  fireEvent.pointerMove(handle, { clientX: 340 });
  fireEvent.pointerUp(handle);
  expect(handle.parentElement?.style.getPropertyValue("--list-width")).toBe("340px");
  expect(localStorage.getItem("assistant-width")).toBe("340");
  fireEvent.keyDown(handle, { key: "End" });
  expect(handle).toHaveAttribute("aria-valuenow", "480");
  containerWidth = 700;
  act(() => resize());
  expect(handle).toHaveAttribute("aria-valuenow", "340");
  expect(handle).toHaveAttribute("aria-valuemax", "340");
  containerWidth = 1000;
  act(() => resize());
  expect(handle).toHaveAttribute("aria-valuenow", "480");
  view.unmount();
  view = mount("review-width");
  expect(screen.getByRole("separator")).toHaveAttribute("aria-valuenow", "248");
  view.unmount();
  view = mount("assistant-width");
  handle = screen.getByRole("separator");
  expect(handle).toHaveAttribute("aria-valuenow", "480");
  fireEvent.keyDown(handle, { key: "Home" });
  fireEvent.keyDown(handle, { key: "ArrowLeft" });
  expect(handle).toHaveAttribute("aria-valuenow", "180");
  fireEvent.doubleClick(handle);
  expect(handle).toHaveAttribute("aria-valuenow", "248");
  expect(localStorage.getItem("assistant-width")).toBeNull();
});

it("restores the starting width after a cancelled drag", () => {
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(1000);
  vi.stubGlobal("PointerEvent", MouseEvent);
  render(<div><ListWidthHandle storageKey="width" label="调整宽度" controls="list" /></div>);
  const handle = screen.getByRole("separator");
  Object.assign(handle, { setPointerCapture: vi.fn() });
  fireEvent.pointerDown(handle, { button: 0, clientX: 248 });
  fireEvent.pointerMove(handle, { clientX: 400 });
  fireEvent.pointerCancel(handle);
  expect(handle).toHaveAttribute("aria-valuenow", "248");
  expect(localStorage.getItem("width")).toBeNull();
});
