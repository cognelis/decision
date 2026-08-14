// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import brandIconUrl from "../assets/decision-mark.svg?url";
import { BrandIcon } from "../src/renderer/components/BrandIcon.js";

afterEach(cleanup);

describe("BrandIcon", () => {
  it("renders the shared decision mark source", () => {
    render(<BrandIcon decorative={false} />);

    expect(
      screen.getByRole("img", { name: "Decision" }),
    ).toHaveAttribute("src", brandIconUrl);
  });

  it("uses a full unoutlined canvas so macOS can apply its own mask", async () => {
    const source = await readFile(
      join(process.cwd(), "apps/desktop/assets/decision-mark.svg"),
      "utf8",
    );

    expect(source).toContain(
      '<rect data-app-background="true" width="1024" height="1024"',
    );
    expect(source).not.toMatch(/data-app-background="true"[^>]+stroke=/u);
    expect(source).toContain('<stop stop-color="#6F4DFF"/>');
    expect(source).toContain('<stop offset="1" stop-color="#C3B4FF"/>');
    expect(source).toContain(
      'transform="translate(512 440) scale(1.22) translate(-512 -512)"',
    );
    expect(source).not.toContain("#36D3A4");
  });

  it("crops the menu bar template tightly around the decision mark", async () => {
    const renderer = await readFile(
      join(process.cwd(), "scripts/render-icon-svg.cjs"),
      "utf8",
    );

    expect(renderer).toContain('viewBox="220 250 584 584"');
    expect(renderer).toContain('.replace(appOnlyMarkTransform, "")');
  });
});
