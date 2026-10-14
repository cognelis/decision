// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRef, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { focusFirst, navigateList } from "../src/renderer/list-navigation.js";
import { useSlashToFocus } from "../src/renderer/use-slash-focus.js";

afterEach(cleanup);

const Harness = ({
  disabled = false,
  hidden = false,
}: {
  disabled?: boolean;
  hidden?: boolean;
}) => {
  const ref = useRef<HTMLInputElement>(null);
  useSlashToFocus(ref);
  return (
    <div hidden={hidden}>
      <input ref={ref} aria-label="search" disabled={disabled} />
      <textarea aria-label="notes" />
    </div>
  );
};

describe("useSlashToFocus", () => {
  it("focuses the field on / without typing the character", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const search = screen.getByRole("textbox", { name: "search" });

    await user.keyboard("/");
    expect(search).toHaveFocus();
    expect(search).toHaveValue("");
  });

  it("leaves / alone while typing elsewhere or with a modifier", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const search = screen.getByRole("textbox", { name: "search" });
    const notes = screen.getByRole("textbox", { name: "notes" });

    await user.click(notes);
    await user.keyboard("a/b");
    expect(notes).toHaveValue("a/b");
    expect(search).not.toHaveFocus();

    notes.blur();
    await user.keyboard("{Meta>}/{/Meta}");
    expect(search).not.toHaveFocus();
  });

  it("ignores disabled or hidden fields", async () => {
    const user = userEvent.setup();
    const disabled = render(<Harness disabled />);
    await user.keyboard("/");
    expect(screen.getByRole("textbox", { name: "search" })).not.toHaveFocus();
    disabled.unmount();

    render(<Harness hidden />);
    await user.keyboard("/");
    expect(document.activeElement).toBe(document.body);
  });
});

const listEvent = (
  key: string,
  target: HTMLElement,
  currentTarget: HTMLElement,
): ReactKeyboardEvent<HTMLElement> & { preventDefault: ReturnType<typeof vi.fn> } =>
  ({
    key,
    target,
    currentTarget,
    preventDefault: vi.fn(),
  }) as unknown as ReactKeyboardEvent<HTMLElement> & {
    preventDefault: ReturnType<typeof vi.fn>;
  };

describe("navigateList", () => {
  // This markup is written straight into the document, so React's cleanup
  // never sees it. Left behind, a focused row is still the document's active
  // element in the next test — which is how the slash-focus case started
  // failing as soon as the files ran in a different order.
  afterEach(() => {
    document.getElementById("list")?.remove();
  });

  const mount = () => {
    document.body.innerHTML = `
      <ul id="list">
        <li><button class="row">one</button></li>
        <li><button class="row">two</button></li>
        <li><button class="row">three</button></li>
      </ul>`;
    const list = document.getElementById("list")!;
    const rows = [...list.querySelectorAll<HTMLElement>(".row")];
    return { list, rows };
  };

  it("moves focus with the arrow keys and clamps at the edges", () => {
    const { list, rows } = mount();
    rows[0]!.focus();

    expect(navigateList(listEvent("ArrowDown", rows[0]!, list), rows)).toBe(true);
    expect(rows[1]).toHaveFocus();
    navigateList(listEvent("End", rows[1]!, list), rows);
    expect(rows[2]).toHaveFocus();
    navigateList(listEvent("ArrowDown", rows[2]!, list), rows);
    expect(rows[2]).toHaveFocus();
    navigateList(listEvent("Home", rows[2]!, list), rows);
    expect(rows[0]).toHaveFocus();
  });

  it("hands focus back above the list from the first row", () => {
    const { list, rows } = mount();
    const onLeaveTop = vi.fn();
    const event = listEvent("ArrowUp", rows[0]!, list);

    expect(navigateList(event, rows, onLeaveTop)).toBe(true);
    expect(onLeaveTop).toHaveBeenCalledOnce();
    expect(event.preventDefault).toHaveBeenCalledOnce();
  });

  it("ignores other keys and targets outside the list", () => {
    const { list, rows } = mount();
    const outsider = document.createElement("button");
    document.body.append(outsider);

    const enter = listEvent("Enter", rows[0]!, list);
    expect(navigateList(enter, rows)).toBe(false);
    expect(enter.preventDefault).not.toHaveBeenCalled();
    expect(navigateList(listEvent("ArrowDown", outsider, list), rows)).toBe(false);
  });

  it("focuses the first match only when one exists", () => {
    const { list, rows } = mount();
    expect(focusFirst(list, ".row")).toBe(true);
    expect(rows[0]).toHaveFocus();
    expect(focusFirst(list, ".missing")).toBe(false);
    expect(focusFirst(null, ".row")).toBe(false);
  });
});
