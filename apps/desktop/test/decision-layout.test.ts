import { describe, expect, it } from "vitest";

import {
  DESKTOP_WINDOW_MIN_SIZE,
  DESKTOP_WINDOW_SIZE,
} from "../src/shared/decision-layout.js";

describe("desktop window layout", () => {
  it("uses one stable desktop canvas for every surface", () => {
    expect(DESKTOP_WINDOW_SIZE).toEqual({
      width: 1160,
      height: 760,
    });
  });

  it("remains usable when the user resizes the window", () => {
    expect(DESKTOP_WINDOW_MIN_SIZE).toEqual({
      width: 860,
      height: 620,
    });
    expect(DESKTOP_WINDOW_MIN_SIZE.width).toBeLessThan(
      DESKTOP_WINDOW_SIZE.width,
    );
    expect(DESKTOP_WINDOW_MIN_SIZE.height).toBeLessThan(
      DESKTOP_WINDOW_SIZE.height,
    );
  });
});
