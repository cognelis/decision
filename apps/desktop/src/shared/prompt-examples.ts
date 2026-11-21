import type { PromptInput } from "./renderer-api.js";

/** Written into the prompt library once, the first time it is opened; after that they are the reader's to edit or delete. */
export const PROMPT_EXAMPLES: readonly PromptInput[] = [
  { title: "检查分支改动", body: "用 paraself-review 检查当前分支相对 main 的改动，结合过往决策和 Obsidian 笔记找遗漏。" },
  { title: "评审方案", body: "用 paraself-review 评审这个方案，重点检查以前否决过的选项和踩过的坑。" },
  { title: "查询技术选型历史", body: "用 paraself-memory 查一下，这个项目之前为什么选择 Redis，后来有没有调整？" },
];
