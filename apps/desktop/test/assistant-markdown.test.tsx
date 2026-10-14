// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { renderMarkdown } from "../src/renderer/components/pages/assistant/markdown.js";

const show = (source: string) => {
  const { container } = render(<div>{renderMarkdown(source)}</div>);
  return container.firstElementChild!;
};

afterEach(cleanup);

describe("assistant answer markdown", () => {
  it("links only supplied citation numbers outside code and ordinary Markdown links", () => {
    const onSelect = vi.fn();
    render(<div>{renderMarkdown("正文 [1]、[99] 和 `[1]`。\n\n**加粗 [1]**\n\n```\n[1]\n```\n\n[1](https://example.com) 与 \\[1]", { indexes: [1], onSelect })}</div>);
    const buttons = screen.getAllByRole("button", { name: "查看引用 1" });
    expect(buttons).toHaveLength(2);
    fireEvent.click(buttons[0]!);
    expect(onSelect).toHaveBeenCalledWith(1);
    expect(screen.queryByRole("button", { name: "查看引用 99" })).toBeNull();
    expect(document.querySelector("a")).toBeNull();
  });

  it("renders the block shapes a model actually writes", () => {
    const view = show(
      [
        "## 结论",
        "",
        "先留在测试环境 [1]。",
        "",
        "- 第一条",
        "- 第二条",
        "",
        "1. 先做这个",
        "2. 再做那个",
        "",
        "> 引用一句",
        "",
        "```ts",
        "const x = 1;",
        "```",
      ].join("\n"),
    );

    expect(view.querySelector("h4")).toHaveTextContent("结论");
    expect(view.querySelectorAll("ul li")).toHaveLength(2);
    expect(view.querySelectorAll("ol li")).toHaveLength(2);
    expect(view.querySelector("blockquote")).toHaveTextContent("引用一句");
    expect(view.querySelector("pre code")).toHaveTextContent("const x = 1;");
    // Citation markers are not links and must survive untouched.
    expect(view).toHaveTextContent("先留在测试环境 [1]。");
  });

  it("renders the tables and break a PR overview writes", () => {
    const view = show(
      [
        "### 3) 逐文件说明表",
        "",
        "| 文件 | 变更要点 |",
        "|------|----------|",
        "| `migrations/[g-1].js` | 新增 **迁移脚本** |",
        "| README.md | 取值 a \\| b |",
        "| 只有一格 |",
        "说明紧跟表格：",
        "| 列 | 值 |",
        "| :-- | --: |",
        "| x | 1 |",
        "",
        "---",
        "",
        "选 A | 选 B 仍是一段文字。",
      ].join("\n"),
    );

    const [files, second] = view.querySelectorAll("table");
    expect([...files!.querySelectorAll("th")].map((cell) => cell.textContent)).toEqual(["文件", "变更要点"]);
    const rows = [...files!.querySelectorAll("tbody tr")].map((row) => [...row.querySelectorAll("td")]);
    expect(rows[0]![0]!.querySelector("code")).toHaveTextContent("migrations/[g-1].js");
    expect(rows[0]![1]!.querySelector("strong")).toHaveTextContent("迁移脚本");
    expect(rows[1]![1]).toHaveTextContent("取值 a | b");
    expect(rows[2]!.map((cell) => cell.textContent)).toEqual(["只有一格", ""]);
    // A table may follow a paragraph line directly.
    expect(second!.parentElement!.previousElementSibling).toHaveTextContent("说明紧跟表格：");
    expect(second!.querySelectorAll("td")).toHaveLength(2);
    expect(view.querySelector("hr")).not.toBeNull();
    expect(view.lastElementChild).toHaveTextContent("选 A | 选 B 仍是一段文字。");
    expect(view.textContent).not.toContain("--");
  });

  it("renders emphasis and inline code without touching the rest", () => {
    const view = show("**重点**和 *斜体*，还有 `code` 与 _下划斜体_。");

    expect(view.querySelector("strong")).toHaveTextContent("重点");
    expect(view.querySelectorAll("em")).toHaveLength(2);
    expect(view.querySelector("code")).toHaveTextContent("code");
  });

  it("leaves identifiers and globs as written: no emphasis inside a word or around spaced asterisks", () => {
    const view = show("通过 batch_id 和 question_index 关联，created_at 与 updated_at 不变，匹配 *.md 和 *.ts。");

    expect(view.querySelectorAll("em")).toHaveLength(0);
    expect(view).toHaveTextContent("通过 batch_id 和 question_index 关联，created_at 与 updated_at 不变，匹配 *.md 和 *.ts。");
  });

  it("keeps a link's label and drops the destination it chose", () => {
    const view = show("见 [某个页面](https://example.com/evil) 的说明。");

    expect(view).toHaveTextContent("见 某个页面 的说明。");
    expect(view.querySelector("a")).toBeNull();
    expect(view.innerHTML).not.toContain("example.com");
  });

  it("never turns model output into markup", () => {
    const view = show(
      '<img src=x onerror="alert(1)"> 与 <script>bad()</script>',
    );

    expect(view.querySelector("img")).toBeNull();
    expect(view.querySelector("script")).toBeNull();
    expect(view).toHaveTextContent('<img src=x onerror="alert(1)">');
  });

  it("still shows a code block the model never closed", () => {
    const view = show("```\n没写结束围栏");

    expect(view.querySelector("pre code")).toHaveTextContent("没写结束围栏");
  });

  it("keeps an ordered list starting where the model started it", () => {
    const view = show("3. 第三步\n4. 第四步");

    expect(view.querySelector("ol")).toHaveAttribute("start", "3");
  });

  it("renders plain prose as one paragraph per block", () => {
    const view = show("第一段第一行\n第一段第二行\n\n第二段");

    const paragraphs = view.querySelectorAll("p");
    expect(paragraphs).toHaveLength(2);
    expect(paragraphs[0]).toHaveTextContent("第一段第一行 第一段第二行");
    expect(paragraphs[1]).toHaveTextContent("第二段");
  });

  it("produces nothing for an empty answer", () => {
    render(<div data-testid="empty">{renderMarkdown("\n\n  \n")}</div>);

    expect(screen.getByTestId("empty")).toBeEmptyDOMElement();
  });
});
