// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { FindBar } from "../src/renderer/components/FindBar.js";

afterEach(cleanup);

it("finds words on the page with ⌘F and walks through them", async () => {
  render(<><section className="desktop-stage"><p>超时 设置</p><p>请求超时后重试</p></section><FindBar /></>);
  fireEvent.keyDown(window, { key: "f", metaKey: true });
  const field = await screen.findByRole("searchbox", { name: "在页面中查找" });
  fireEvent.change(field, { target: { value: "超时" } });
  expect(screen.getByText("1 / 2")).toBeVisible();
  fireEvent.keyDown(field, { key: "Enter" });
  expect(screen.getByText("2 / 2")).toBeVisible();
  fireEvent.keyDown(field, { key: "Enter", shiftKey: true });
  expect(screen.getByText("1 / 2")).toBeVisible();
  // A new search starts from its first match, wherever the last one had got to.
  fireEvent.keyDown(field, { key: "Enter" });
  fireEvent.change(field, { target: { value: "超" } });
  expect(screen.getByText("1 / 2")).toBeVisible();
  fireEvent.change(field, { target: { value: "没有的词" } });
  expect(screen.getByText("没有匹配")).toBeVisible();
  fireEvent.keyDown(field, { key: "Escape" });
  expect(screen.queryByRole("search", { name: "在页面中查找" })).toBeNull();
});

it("looks in the dialog on top rather than the page behind it", async () => {
  render(<><section className="desktop-stage"><p>超时</p><p>超时</p></section><div role="dialog" aria-label="PR 详情"><p>超时后请求仍在运行</p></div><FindBar /></>);
  fireEvent.keyDown(window, { key: "f", ctrlKey: true });
  fireEvent.change(await screen.findByRole("searchbox", { name: "在页面中查找" }), { target: { value: "超时" } });
  expect(screen.getByText("1 / 1")).toBeVisible();
});

it("passes over a dialog left open on a page kept hidden, and finds on the page in view", async () => {
  render(<>
    <div className="modal-backdrop" hidden><div role="dialog" aria-label="决策详情"><p>别处的内容</p></div></div>
    <section className="desktop-stage"><p>理由面板上的超时</p></section>
    <FindBar />
  </>);
  fireEvent.keyDown(window, { key: "f", metaKey: true });
  fireEvent.change(await screen.findByRole("searchbox", { name: "在页面中查找" }), { target: { value: "超时" } });
  // Searched in the hidden dialog, it said 没有匹配 for words in plain view.
  expect(screen.getByText("1 / 1")).toBeVisible();
});

it("searches again when the text under it changes, and hands focus back when it closes", async () => {
  const page = (words: string) => <><section className="desktop-stage"><button type="button">记录</button><p>{words}</p></section><FindBar /></>;
  const { rerender } = render(page("超时 超时"));
  const before = screen.getByRole("button", { name: "记录" });
  before.focus();
  fireEvent.keyDown(window, { key: "f", metaKey: true });
  const field = await screen.findByRole("searchbox", { name: "在页面中查找" });
  fireEvent.change(field, { target: { value: "超时" } });
  expect(screen.getByText("1 / 2")).toBeVisible();
  // Another record opened in place: the count follows it without a keystroke.
  rerender(page("超时"));
  expect(await screen.findByText("1 / 1")).toBeVisible();
  field.focus();
  fireEvent.keyDown(field, { key: "Escape" });
  expect(before).toHaveFocus();
});
