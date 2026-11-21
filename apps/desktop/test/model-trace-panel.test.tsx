// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { ModelTracePanel } from "../src/renderer/components/ModelTracePanel.js";
import { apiFixture, modelTraceFixture, rationaleSnapshot } from "./app-fixtures.js";

afterEach(cleanup);

it.each([true, false])("keeps trace actions available while the content preference save succeeds=%s", async (success) => {
  const { api } = apiFixture(rationaleSnapshot(), [modelTraceFixture()]);
  let finish!: () => void;
  let fail!: (error: Error) => void;
  vi.mocked(api.setModelTraceContentEnabled).mockReturnValueOnce(new Promise((resolve, reject) => { finish = resolve; fail = reject; }));
  const user = userEvent.setup();
  render(<ModelTracePanel api={api} contentEnabled />);
  const list = await screen.findByRole("list", { name: "模型调用记录列表" });
  const toggle = screen.getByRole("switch");
  await user.click(toggle);
  expect(toggle).toBeDisabled();
  expect(screen.getByRole("button", { name: "清空记录" })).toBeEnabled();
  await user.click(within(list).getByRole("button", { name: "详情" }));
  const dialog = within(screen.getByRole("dialog"));
  expect(dialog.getByRole("button", { name: "删除这条记录" })).toBeEnabled();
  expect(dialog.getByRole("button", { name: "复制排障信息" })).toBeEnabled();
  await act(async () => { if (success) finish(); else fail(new Error("日志偏好未保存")); });
  expect(toggle).toBeEnabled();
  if (success) expect(toggle).not.toBeChecked();
  else expect(toggle).toBeChecked();
  expect(screen.getByText(success ? "新的模型调用只记录元数据。" : "日志偏好未保存")).toBeInTheDocument();
  expect(api.listModelTraces).toHaveBeenCalledTimes(1);
});

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

it("names a context summary by what it is, in the purpose filter and in the list", async () => {
  const summary = { ...modelTraceFixture(), traceId: "trace-summary", attemptId: "attempt-summary", purpose: "context-summary" as const };
  const { api } = apiFixture(rationaleSnapshot(), [modelTraceFixture(), summary]);
  render(<ModelTracePanel api={api} contentEnabled />);
  const filter = await screen.findByRole("group", { name: "按用途筛选" });
  expect(within(filter).getByRole("button", { name: "上下文总结 1" })).toBeInTheDocument();
  expect(within(screen.getByRole("list", { name: "模型调用记录列表" })).getByText("上下文总结")).toBeVisible();
});

it("names each call's backend as it is configured, and says on its row why it failed", async () => {
  const failed = { ...modelTraceFixture(), traceId: "trace-failed", attemptId: "attempt-failed", status: "failed" as const, errorCode: "process_failed" as const,
    profile: { ...modelTraceFixture().profile, profileId: "remote-deepseek", backend: "openai-compatible" as const, provider: "DeepSeek" },
    diagnosticExcerpt: `HTTP 400: ${JSON.stringify({ error: { message: "Invalid schema: missing path" } })}` };
  const { api } = apiFixture(rationaleSnapshot(), [modelTraceFixture(), failed]);
  render(<ModelTracePanel api={api} contentEnabled />);
  const list = within(await screen.findByRole("list", { name: "模型调用记录列表" }));

  // The name given in 模型, not the kind of API behind it; a record naming none reads as its kind.
  expect(list.getByText("DeepSeek")).toBeVisible();
  expect(list.queryByText("OpenAI 兼容 API")).toBeNull();
  expect(list.getByText("Qwen 本地模型")).toBeVisible();
  // Why it failed, on one line under the call, without opening its details.
  expect(list.getByText("客户端进程失败").closest("p")).toHaveTextContent("客户端进程失败 · Invalid schema: missing path");
  expect(list.getAllByRole("listitem")).toHaveLength(2);
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

it("says a moderation refusal is the provider's review of the content, not the key, with what it flagged", async () => {
  const said = { error: { code: 403, message: "openai/gpt-4o requires moderation on OpenAI. Your input was flagged for \"harassment\". No credits were charged." } };
  const trace = { ...modelTraceFixture(), status: "failed" as const, errorCode: "content_refused" as const,
    profile: { ...modelTraceFixture().profile, backend: "openai-compatible" as const, provider: "OpenRouter" }, diagnosticExcerpt: `HTTP 403: ${JSON.stringify(said)}` };
  const { api } = apiFixture(rationaleSnapshot(), [trace]);
  const user = userEvent.setup();
  render(<ModelTracePanel api={api} contentEnabled />);
  await user.click(within(await screen.findByRole("list", { name: "模型调用记录列表" })).getByRole("button", { name: "详情" }));
  const reason = within(screen.getByRole("dialog")).getByRole("region", { name: "失败原因" });

  expect(reason.querySelector("h3")).toHaveTextContent("内容被服务商审核拒绝 · content_refused");
  expect(reason).toHaveTextContent("Your input was flagged for \"harassment\"");
  expect(reason).toHaveTextContent("服务商的内容审核拒绝了这次请求，不是凭据问题；可以换一个后端，或调整内容后重试。");
});

it("says a failed deletion in the confirmation it was asked from, and a failed read where the list would be", async () => {
  const { api } = apiFixture(rationaleSnapshot(), [modelTraceFixture()]);
  vi.mocked(api.deleteModelTrace).mockRejectedValueOnce(new Error("记录文件被占用"));
  const user = userEvent.setup();
  render(<ModelTracePanel api={api} contentEnabled />);
  await user.click(within(await screen.findByRole("list", { name: "模型调用记录列表" })).getByRole("button", { name: "详情" }));
  await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "删除这条记录" }));
  const confirm = within(screen.getByRole("dialog", { name: "删除这条调用记录？" }));
  await user.click(confirm.getByRole("button", { name: "删除" }));
  // Said on the card behind the details, it was a change under a darkened page.
  expect(await confirm.findByRole("alert")).toHaveTextContent("删除失败：记录文件被占用");
  expect(screen.getByRole("dialog", { name: /调用详情$/u })).toBeVisible();
  cleanup();

  const failing = apiFixture(rationaleSnapshot(), [modelTraceFixture()]).api;
  vi.mocked(failing.listModelTraces).mockRejectedValueOnce(new Error("读取超时"));
  render(<ModelTracePanel api={failing} contentEnabled />);
  // Not "目前没有模型调用记录": the reading failed, and can be tried again.
  expect(await screen.findByRole("alert")).toHaveTextContent("模型调用记录读取失败");
  expect(screen.queryByText("目前没有模型调用记录。")).toBeNull();
  await user.click(screen.getByRole("button", { name: "重试" }));
  expect(await screen.findByRole("list", { name: "模型调用记录列表" })).toBeVisible();
});

// Read once, then refreshed and failing: the rows read before stay, and the card says they may be out of date.
it("says a failed refresh over the records read before, and tries again", async () => {
  const { api } = apiFixture(rationaleSnapshot(), [modelTraceFixture()]);
  const user = userEvent.setup();
  const { rerender } = render(<ModelTracePanel api={api} contentEnabled refreshKey="a" />);
  expect(await screen.findByRole("list", { name: "模型调用记录列表" })).toBeVisible();
  vi.mocked(api.listModelTraces).mockRejectedValueOnce(new Error("读取超时"));
  rerender(<ModelTracePanel api={api} contentEnabled refreshKey="b" />);
  expect(await screen.findByRole("alert")).toHaveTextContent("记录暂时无法刷新");
  expect(screen.getByRole("list", { name: "模型调用记录列表" })).toBeVisible();
  await user.click(screen.getByRole("button", { name: "重试" }));
  await waitFor(() => expect(screen.queryByText(/记录暂时无法刷新/u)).toBeNull());
});

// R15-JEVSET-B3: jev's calls sit in the one list, filter together as 判定模型, and show what was asked and answered apart.
it("lists jev's calls with the rest, filters them as 判定模型, and shows its input and output apart", async () => {
  const user = userEvent.setup();
  const jevProfile = { ...modelTraceFixture().profile, profileId: "remote-jev", backend: "openrouter-decisions" as const, provider: "jev", model: "typesafe/jev-1.14", providerVersion: "typesafe/jev-1.14-20261014" };
  const decision = { endpoint: "https://openrouter.ai/api/alpha/decisions", dataCollection: "deny" as const, source: "r15-feature", timeoutMs: 30_000, proxyMode: "direct" as const, httpStatus: 200, responseId: "gen-dec-1", responseModel: "typesafe/jev-1.14-20261014", responseProvider: "TypeSafe" };
  const judged = { ...modelTraceFixture(), traceId: "trace-jev", attemptId: "attempt-jev", requestId: "request-jev", purpose: "structured-judgment" as const, createdAt: "2026-07-30T00:02:00.000Z",
    profile: jevProfile, decision,
    input: { systemPrompt: "{\"adopted\":{\"type\":\"noul\",\"instructions\":\"Was B adopted?\"}}", userPrompt: "User: go with B", outputSchema: {} },
    output: { visibleText: "{}", parsed: { adopted: { type: "noul", noul: 0.91 } } } };
  const tested = { ...modelTraceFixture(), traceId: "trace-jev-test", attemptId: "attempt-jev-test", requestId: "request-jev-test", purpose: "provider-health-check" as const, createdAt: "2026-07-30T00:03:00.000Z",
    profile: jevProfile, decision: { ...decision, source: "provider-health-check" } };
  const { api } = apiFixture(rationaleSnapshot(), [modelTraceFixture(), judged, tested]);
  render(<ModelTracePanel api={api} contentEnabled />);
  const filter = await screen.findByRole("group", { name: "按用途筛选" });
  await user.click(within(filter).getByRole("button", { name: "判定模型 2" }));
  const list = within(screen.getByRole("list", { name: "模型调用记录列表" }));
  expect(list.getAllByRole("button", { name: "详情" })).toHaveLength(2);

  await user.click(list.getAllByRole("button", { name: "详情" })[1]!);
  const dialog = within(screen.getByRole("dialog"));
  expect(dialog.getByText("响应 ID").nextElementSibling).toHaveTextContent("gen-dec-1");
  expect(dialog.getByText("实际模型").nextElementSibling).toHaveTextContent("typesafe/jev-1.14-20261014");
  expect(dialog.getByText("数据留存").nextElementSibling).toHaveTextContent("data_collection: deny");
  expect(dialog.getByRole("heading", { name: "输入" })).toBeVisible();
  expect(dialog.getByText("User: go with B")).toBeVisible();
  expect(dialog.getByText(/Was B adopted\?/u)).toBeVisible();
  expect(dialog.getByRole("heading", { name: "输出（answers 与概率）" }).nextElementSibling).toHaveTextContent("0.91");
});
