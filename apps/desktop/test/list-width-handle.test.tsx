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

it("supports the local review width range, reserves code space and remembers a preference across clamping", () => {
  let containerWidth = 1400;
  let resize!: () => void;
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(() => containerWidth);
  vi.stubGlobal("ResizeObserver", class { constructor(callback: () => void) { resize = callback; } observe() {} disconnect() {} });
  vi.stubGlobal("PointerEvent", MouseEvent);
  const mount = (remaining: number) => <div><ListWidthHandle storageKey="local-files" label="文件宽度" controls="files" defaultWidth={300} maximumWidth={560} minContentWidth={remaining} /></div>;
  const view = render(mount(708)), handle = screen.getByRole("separator");
  Object.assign(handle, { setPointerCapture: vi.fn(), releasePointerCapture: vi.fn() });
  expect(handle).toHaveAttribute("aria-valuenow", "300"); expect(handle).toHaveAttribute("aria-valuemin", "180"); expect(handle).toHaveAttribute("aria-valuemax", "560");
  fireEvent.pointerDown(handle, { button: 0, clientX: 300 });
  expect(document.body.style.userSelect).toBe("none");
  fireEvent.pointerMove(handle, { clientX: 1100 }); fireEvent.pointerUp(handle);
  expect(handle).toHaveAttribute("aria-valuenow", "560"); expect(localStorage.getItem("local-files")).toBe("560");
  expect(document.body.style.userSelect).toBe("");
  containerWidth = 920; act(() => resize());
  expect(handle).toHaveAttribute("aria-valuenow", "212"); expect(handle).toHaveAttribute("aria-valuemax", "212");
  view.rerender(mount(464));
  expect(handle).toHaveAttribute("aria-valuenow", "456");
  containerWidth = 1400; act(() => resize()); expect(handle).toHaveAttribute("aria-valuenow", "560");
  fireEvent.doubleClick(handle); expect(handle).toHaveAttribute("aria-valuenow", "300"); expect(localStorage.getItem("local-files")).toBeNull();
  fireEvent.keyDown(handle, { key: "ArrowLeft" }); expect(handle).toHaveAttribute("aria-valuenow", "290");
});

it("remains usable without localStorage and restores text selection when unmounted during a drag", () => {
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(1400);
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("unavailable"); });
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("unavailable"); });
  vi.stubGlobal("PointerEvent", MouseEvent);
  const view = render(<div><ListWidthHandle storageKey="local-files" label="文件宽度" controls="files" defaultWidth={300} maximumWidth={560} minContentWidth={708} /></div>);
  const handle = screen.getByRole("separator"); Object.assign(handle, { setPointerCapture: vi.fn() });
  fireEvent.keyDown(handle, { key: "ArrowRight" }); expect(handle).toHaveAttribute("aria-valuenow", "310");
  fireEvent.pointerDown(handle, { button: 0, clientX: 310 }); expect(document.body.style.userSelect).toBe("none");
  view.unmount(); expect(document.body.style.userSelect).toBe("");
});
