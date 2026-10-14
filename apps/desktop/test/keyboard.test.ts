// @vitest-environment jsdom

import { describe, expect, it } from "vitest";

import {
  isClearShortcut,
  isSubmitShortcut,
  SUBMIT_SHORTCUT_KEYS,
} from "../src/renderer/keyboard.js";

const keyEvent = (init: KeyboardEventInit): KeyboardEvent =>
  new KeyboardEvent("keydown", init);

describe("keyboard shortcuts", () => {
  it("accepts Cmd+Enter and Ctrl+Enter as the submit shortcut", () => {
    expect(isSubmitShortcut(keyEvent({ key: "Enter", metaKey: true }))).toBe(
      true,
    );
    expect(isSubmitShortcut(keyEvent({ key: "Enter", ctrlKey: true }))).toBe(
      true,
    );
  });

  it("rejects plain, shifted, alt and composing Enter", () => {
    expect(isSubmitShortcut(keyEvent({ key: "Enter" }))).toBe(false);
    expect(
      isSubmitShortcut(keyEvent({ key: "Enter", metaKey: true, shiftKey: true })),
    ).toBe(false);
    expect(
      isSubmitShortcut(keyEvent({ key: "Enter", ctrlKey: true, altKey: true })),
    ).toBe(false);
    expect(
      isSubmitShortcut(
        keyEvent({ key: "Enter", metaKey: true, isComposing: true }),
      ),
    ).toBe(false);
    expect(isSubmitShortcut(keyEvent({ key: "a", metaKey: true }))).toBe(false);
  });

  it("treats Escape as clear unless an IME is composing", () => {
    expect(isClearShortcut(keyEvent({ key: "Escape" }))).toBe(true);
    expect(isClearShortcut(keyEvent({ key: "Escape", isComposing: true }))).toBe(
      false,
    );
    expect(isClearShortcut(keyEvent({ key: "Enter" }))).toBe(false);
  });

  it("publishes both modifiers in aria-keyshortcuts syntax", () => {
    expect(SUBMIT_SHORTCUT_KEYS).toBe("Meta+Enter Control+Enter");
  });
});
