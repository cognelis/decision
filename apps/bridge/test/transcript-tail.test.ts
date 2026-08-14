import { mkdtemp, open, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  readCodexDecisions,
  readLastDecisionTurn,
  readLastAssistantText,
} from "../src/transcript-tail.js";

const makePath = async () => {
  const root = await mkdtemp(
    join(tmpdir(), "decision-transcript-"),
  );
  return join(root, "session.jsonl");
};

describe("readLastAssistantText", () => {
  it("extracts the last Claude assistant text from a JSONL tail", async () => {
    const path = await makePath();
    await writeFile(
      path,
      [
        JSON.stringify({
          type: "assistant",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "旧消息" }],
          },
        }),
        JSON.stringify({
          type: "assistant",
          message: {
            role: "assistant",
            content: [
              { type: "text", text: "选择 A 还是 B？" },
            ],
          },
        }),
      ].join("\n"),
    );

    await expect(readLastAssistantText(path)).resolves.toBe(
      "选择 A 还是 B？",
    );
  });

  it("extracts Codex response_item output_text", async () => {
    const path = await makePath();
    await writeFile(
      path,
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [
            { type: "output_text", text: "现在继续吗？" },
          ],
        },
      }),
    );

    await expect(readLastAssistantText(path)).resolves.toBe(
      "现在继续吗？",
    );
  });

  it("never reads more than the configured tail", async () => {
    const path = await makePath();
    await writeFile(
      path,
      `${"x".repeat(2_048)}\n${JSON.stringify({
        message: {
          role: "assistant",
          content: [{ type: "text", text: "尾部问题？" }],
        },
      })}`,
    );
    const read = vi.fn(async (file, options) =>
      file.read(options),
    );

    await expect(
      readLastAssistantText(path, {
        maximumBytes: 1_024,
        read,
      }),
    ).resolves.toBe("尾部问题？");
    expect(read).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ length: 1_024 }),
    );

    const handle = await open(path, "r");
    await handle.close();
  });

  it("ignores invalid and unsupported transcript lines", async () => {
    const path = await makePath();
    await writeFile(
      path,
      [
        "{invalid",
        JSON.stringify({
          message: {
            role: "user",
            content: [{ type: "text", text: "secret" }],
          },
        }),
      ].join("\n"),
    );

    await expect(readLastAssistantText(path)).resolves.toBeNull();
  });
});

describe("readLastDecisionTurn", () => {
  it("recovers the latest Claude user and assistant visible messages", async () => {
    const path = await makePath();
    await writeFile(
      path,
      [
        JSON.stringify({
          type: "user",
          message: {
            role: "user",
            content: [
              {
                type: "text",
                text: "继续开发 Decision，优先提高采集质量。",
              },
            ],
          },
        }),
        JSON.stringify({
          type: "tool",
          message: {
            role: "tool",
            content: [
              { type: "text", text: "不应成为任务背景" },
            ],
          },
        }),
        JSON.stringify({
          type: "assistant",
          message: {
            role: "assistant",
            content: [
              {
                type: "text",
                text:
                  "规则方案延迟低，本地模型召回更高。\n\n" +
                  "建议先规则后模型，你希望这样安排吗",
              },
            ],
          },
        }),
      ].join("\n"),
    );

    await expect(readLastDecisionTurn(path)).resolves.toEqual({
      userText:
        "继续开发 Decision，优先提高采集质量。",
      assistantText:
        "规则方案延迟低，本地模型召回更高。\n\n" +
        "建议先规则后模型，你希望这样安排吗",
    });
  });

  it("recovers only the latest Codex turn and ignores tool payloads", async () => {
    const path = await makePath();
    await writeFile(
      path,
      [
        JSON.stringify({
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [
              { type: "input_text", text: "旧任务" },
            ],
          },
        }),
        JSON.stringify({
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: [
              { type: "output_text", text: "旧回答" },
            ],
          },
        }),
        JSON.stringify({
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [
              { type: "input_text", text: "新的任务目标" },
            ],
          },
        }),
        JSON.stringify({
          type: "response_item",
          payload: {
            type: "function_call_output",
            output: JSON.stringify({
              role: "user",
              content: "不应被读取",
            }),
          },
        }),
        JSON.stringify({
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: [
              {
                type: "output_text",
                text: "方案 1 还是方案 2？",
              },
            ],
          },
        }),
      ].join("\n"),
    );

    await expect(readLastDecisionTurn(path)).resolves.toEqual({
      userText: "新的任务目标",
      assistantText: "方案 1 还是方案 2？",
    });
  });
});

describe("readCodexDecisions", () => {
  it("extracts every completed native request_user_input from the matching turn", async () => {
    const path = await makePath();
    const turnId =
      "019f9f26-cd37-7ed3-b68e-50c33a5253da";
    await writeFile(
      path,
      [
        JSON.stringify({
          type: "response_item",
          payload: {
            type: "function_call",
            name: "request_user_input",
            arguments: JSON.stringify({
              questions: [
                {
                  header: "工作方式",
                  id: "working_style",
                  question:
                    "接下来处理开发任务时，你希望我采用哪种起步方式？",
                  options: [
                    {
                      label: "先写测试 (Recommended)",
                      description:
                        "先明确预期行为并建立失败测试，再实现功能。",
                    },
                    {
                      label: "先做原型",
                      description:
                        "先快速验证方案与交互，再补齐测试和正式实现。",
                    },
                  ],
                },
              ],
            }),
            call_id: "call_native_question",
            internal_chat_message_metadata_passthrough: {
              turn_id: turnId,
            },
          },
        }),
        JSON.stringify({
          type: "response_item",
          payload: {
            type: "function_call_output",
            call_id: "call_native_question",
            output: JSON.stringify({
              answers: {
                working_style: {
                  answers: ["先写测试 (Recommended)"],
                },
              },
            }),
            internal_chat_message_metadata_passthrough: {
              turn_id: turnId,
            },
          },
        }),
        JSON.stringify({
          type: "response_item",
          payload: {
            type: "function_call",
            name: "request_user_input",
            arguments: JSON.stringify({
              questions: [
                {
                  header: "验证方式",
                  id: "verification",
                  question: "完成后如何验证？",
                  options: [
                    { label: "自动测试" },
                    { label: "人工检查" },
                  ],
                },
              ],
            }),
            call_id: "call_second_question",
            internal_chat_message_metadata_passthrough: {
              turn_id: turnId,
            },
          },
        }),
        JSON.stringify({
          type: "response_item",
          payload: {
            type: "function_call_output",
            call_id: "call_second_question",
            output: JSON.stringify({
              answers: {
                verification: {
                  answers: ["自动测试"],
                },
              },
            }),
            internal_chat_message_metadata_passthrough: {
              turn_id: turnId,
            },
          },
        }),
      ].join("\n"),
    );

    await expect(
      readCodexDecisions(path, { turnId }),
    ).resolves.toEqual([
      {
        turnId,
        toolUseId: "call_native_question",
        toolInput: {
          questions: [
            {
              header: "工作方式",
              id: "working_style",
              question:
                "接下来处理开发任务时，你希望我采用哪种起步方式？",
              options: [
                {
                  label: "先写测试 (Recommended)",
                  description:
                    "先明确预期行为并建立失败测试，再实现功能。",
                },
                {
                  label: "先做原型",
                  description:
                    "先快速验证方案与交互，再补齐测试和正式实现。",
                },
              ],
            },
          ],
        },
        toolResponse: {
          answers: {
            working_style: {
              answers: ["先写测试 (Recommended)"],
            },
          },
        },
      },
      {
        turnId,
        toolUseId: "call_second_question",
        toolInput: {
          questions: [
            {
              header: "验证方式",
              id: "verification",
              question: "完成后如何验证？",
              options: [
                { label: "自动测试" },
                { label: "人工检查" },
              ],
            },
          ],
        },
        toolResponse: {
          answers: {
            verification: {
              answers: ["自动测试"],
            },
          },
        },
      },
    ]);
  });

  it("ignores wrong-turn, unmatched, malformed, and unrelated records", async () => {
    const path = await makePath();
    await writeFile(
      path,
      [
        JSON.stringify({
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [
              { type: "input_text", text: "unrelated secret" },
            ],
          },
        }),
        "{invalid",
        JSON.stringify({
          type: "response_item",
          payload: {
            type: "function_call",
            name: "request_user_input",
            arguments: JSON.stringify({
              questions: [
                {
                  id: "wrong",
                  question: "Wrong turn?",
                  options: [],
                },
              ],
            }),
            call_id: "call-cross-turn",
            internal_chat_message_metadata_passthrough: {
              turn_id: "other-turn",
            },
          },
        }),
        JSON.stringify({
          type: "response_item",
          payload: {
            type: "function_call_output",
            call_id: "call-cross-turn",
            output: JSON.stringify({
              answers: { wrong: { answers: ["No"] } },
            }),
            internal_chat_message_metadata_passthrough: {
              turn_id: "target-turn",
            },
          },
        }),
        JSON.stringify({
          type: "response_item",
          payload: {
            type: "function_call",
            name: "request_user_input",
            arguments: JSON.stringify({
              questions: [
                {
                  id: "unanswered",
                  question: "Unanswered?",
                  options: [],
                },
              ],
            }),
            call_id: "call-unanswered",
            internal_chat_message_metadata_passthrough: {
              turn_id: "target-turn",
            },
          },
        }),
      ].join("\n"),
    );

    await expect(
      readCodexDecisions(path, { turnId: "target-turn" }),
    ).resolves.toEqual([]);
  });

  it("does not pair a truncated call with an output in the bounded tail", async () => {
    const path = await makePath();
    const turnId = "bounded-turn";
    await writeFile(
      path,
      [
        JSON.stringify({
          type: "response_item",
          payload: {
            type: "function_call",
            name: "request_user_input",
            arguments: JSON.stringify({
              questions: [
                {
                  id: "bounded",
                  question: "Bounded?",
                  options: [],
                },
              ],
            }),
            call_id: "call-bounded",
            internal_chat_message_metadata_passthrough: {
              turn_id: turnId,
            },
          },
        }),
        "x".repeat(1_024),
        JSON.stringify({
          type: "response_item",
          payload: {
            type: "function_call_output",
            call_id: "call-bounded",
            output: JSON.stringify({
              answers: { bounded: { answers: ["Yes"] } },
            }),
            internal_chat_message_metadata_passthrough: {
              turn_id: turnId,
            },
          },
        }),
      ].join("\n"),
    );
    const read = vi.fn(async (file, options) =>
      file.read(options),
    );

    await expect(
      readCodexDecisions(path, {
        turnId,
        maximumBytes: 512,
        read,
      }),
    ).resolves.toEqual([]);
    expect(read).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ length: 512 }),
    );
  });
});
