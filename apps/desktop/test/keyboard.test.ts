// @vitest-environment jsdom

import { describe, expect, it } from "vitest";

import {
  DEFER_SHORTCUT_KEYS,
  isClearShortcut,
  isDeferShortcut,
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
    expect(DEFER_SHORTCUT_KEYS).toBe("Meta+L Control+L");
  });

  it("accepts Cmd+L and Ctrl+L as the defer shortcut, by the key's place too", () => {
    expect(isDeferShortcut(keyEvent({ key: "l", metaKey: true }))).toBe(true);
    expect(isDeferShortcut(keyEvent({ key: "L", ctrlKey: true }))).toBe(true);
    expect(isDeferShortcut(keyEvent({ key: "¬", code: "KeyL", metaKey: true }))).toBe(true);
  });

  it("rejects plain, shifted, alt and composing L for defer", () => {
    expect(isDeferShortcut(keyEvent({ key: "l" }))).toBe(false);
    expect(isDeferShortcut(keyEvent({ key: "L", metaKey: true, shiftKey: true }))).toBe(false);
    expect(isDeferShortcut(keyEvent({ key: "l", ctrlKey: true, altKey: true }))).toBe(false);
    expect(isDeferShortcut(keyEvent({ key: "l", metaKey: true, isComposing: true }))).toBe(false);
    expect(isDeferShortcut(keyEvent({ key: "k", metaKey: true }))).toBe(false);
  });
});
