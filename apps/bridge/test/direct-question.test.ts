import { describe, expect, it } from "vitest";

import { extractDirectQuestion } from "../src/direct-question.js";

describe("extractDirectQuestion", () => {
  it.each([
    ["选择哪种发布方式？", "选择哪种发布方式？"],
    [
      "我已经完成检查。\n\n接下来先修复兼容性，还是先补测试？",
      "接下来先修复兼容性，还是先补测试？",
    ],
    [
      "背景如下：\n- A：速度优先\n- B：稳定优先\n\n你希望采用哪一个？",
      "背景如下：\n- A：速度优先\n- B：稳定优先\n\n你希望采用哪一个？",
    ],
    [
      "不应采集的历史隐私。\n\n检查已经完成。\n\n候选项：\n- A：先修复\n- B：先测试\n\n你希望选哪一个？",
      "候选项：\n- A：先修复\n- B：先测试\n\n你希望选哪一个？",
    ],
  ])("extracts a direct final question from %s", (message, expected) => {
    expect(extractDirectQuestion(message)).toBe(expected);
  });

  it.each([
    "测试已经通过。",
    "代码中包含 `shouldRetry?` 变量。",
    "```ts\nconst value = ready ? a : b;\n```",
    "> 用户之前问：是否需要缓存？\n\n我已完成实现。",
    "如果失败怎么办？我会自动回滚并继续。",
    "你想怎么做？我建议先补测试。",
  ])(
    "rejects status, code, quotes, and answered rhetorical questions",
    (message) => {
      expect(extractDirectQuestion(message)).toBeNull();
    },
  );
});
