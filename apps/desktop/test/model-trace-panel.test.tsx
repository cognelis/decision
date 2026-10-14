// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { ModelTracePanel } from "../src/renderer/components/ModelTracePanel.js";
import { apiFixture, modelTraceFixture, rationaleSnapshot } from "./app-fixtures.js";

afterEach(cleanup);

it("puts the actual schema rejection first, shows request details and related calls, and copies only diagnostics metadata", async () => {
  const user = userEvent.setup();
  const write = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);
  const first = { ...modelTraceFixture(), purpose: "pr-review" as const, status: "failed" as const, errorCode: "process_failed" as const,
    processExitCode: 1, providerRequestId: "service-request-1", diagnosticExcerpt: JSON.stringify({ error: { code: "invalid_json_schema", message: "Invalid schema: missing path" }, status: 400 }),
    request: { configuredTimeoutMs: 5000, generationTimeoutMs: 30000, requestedMaxOutputTokens: 8192, systemPromptChars: 30, userPromptChars: 40 },
    input: { ...modelTraceFixture().input!, systemPrompt: "PRIVATE_INPUT_BODY", clientSystemPromptVisibility: "opaque" as const },
    output: { visibleText: "PRIVATE_OUTPUT_BODY", parsed: null },
  };
  const second = { ...modelTraceFixture(), traceId: "trace-2", attemptId: "attempt-2", createdAt: "2026-07-30T00:01:00.000Z" };
  const { api } = apiFixture(rationaleSnapshot(), [first, second]);
  render(<ModelTracePanel api={api} contentEnabled />);
  const list = await screen.findByRole("list", { name: "模型调用记录列表" });
  await user.click(within(list).getAllByRole("button", { name: "详情" })[1]!);
  let dialog = within(screen.getByRole("dialog"));
  expect(dialog.getByRole("region", { name: "失败原因" })).toHaveTextContent("Invalid schema: missing path");
  expect(dialog.getByText("进程退出码").nextElementSibling).toHaveTextContent("1");
  expect(dialog.getByText("服务商请求 ID").nextElementSibling).toHaveTextContent("service-request-1");
  expect(dialog.getByText("配置超时").nextElementSibling).toHaveTextContent("5000 ms");
  expect(dialog.getByText("输出 Schema")).toBeVisible();
  await user.click(dialog.getByRole("button", { name: "复制排障信息" }));
  const copied = JSON.parse(write.mock.calls[0]![0]);
  expect(copied).toMatchObject({ errorCode: "process_failed", processExitCode: 1, request: { requestedMaxOutputTokens: 8192 } });
  expect(copied.input).toBeUndefined(); expect(copied.output).toBeUndefined();
  expect(write.mock.calls[0]![0]).not.toMatch(/PRIVATE_INPUT_BODY|PRIVATE_OUTPUT_BODY/);
  await user.click(dialog.getByText("展开相关记录（按记录时间排列）"));
  await user.click(dialog.getByRole("button", { name: /2\..*成功/u }));
  dialog = within(screen.getByRole("dialog"));
  expect(dialog.queryByRole("region", { name: "失败原因" })).toBeNull();
  expect(dialog.getByText("记录 ID").nextElementSibling).toHaveTextContent("trace-2");
});

it("says a remote API's own message as the failure reason, not the HTTP status and body it came in", async () => {
  const body = JSON.stringify({ error: { message: "Invalid schema for response_format 'decision': required is required", type: "invalid_request_error", code: "invalid_json_schema" } }, null, 2);
  const trace = { ...modelTraceFixture(), status: "failed" as const, errorCode: "invalid_configuration" as const,
    profile: { ...modelTraceFixture().profile, backend: "openai" as const, provider: "openai" }, diagnosticExcerpt: `HTTP 400: ${body}` };
  const { api } = apiFixture(rationaleSnapshot(), [trace]);
  const user = userEvent.setup();
  render(<ModelTracePanel api={api} contentEnabled />);
  await user.click(within(await screen.findByRole("list", { name: "模型调用记录列表" })).getByRole("button", { name: "详情" }));
  const reason = within(screen.getByRole("dialog")).getByRole("region", { name: "失败原因" });
  // Written "HTTP 400: {" and the body, the excerpt was neither JSON nor its first line: the headline was the whole blob.
  expect(reason.querySelector("p")).toHaveTextContent(/^Invalid schema for response_format 'decision': required is required$/u);
});
