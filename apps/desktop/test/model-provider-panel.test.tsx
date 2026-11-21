// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import type { DecisionApi } from "../src/shared/renderer-api.js";
import { ModelProviderPanel } from "../src/renderer/components/ModelProviderPanel.js";
import { apiFixture, rationaleSnapshot } from "./app-fixtures.js";

afterEach(cleanup);

type Statuses = Awaited<ReturnType<DecisionApi["listLocalModelClientStatuses"]>>;

it("locks profile writes for a reorder while explicit model tests remain available", async () => {
  const { api } = apiFixture(rationaleSnapshot({ current: null }));
  const first = { version: 1 as const, profileId: "remote-first", kind: "openai" as const, label: "First", enabled: true, priority: 10, model: "gpt-test", timeoutMs: 30_000, baseUrl: "https://api.openai.com", credentialConfigured: true };
  const second = { ...first, profileId: "remote-second", label: "Second", priority: 20 };
  vi.mocked(api.listModelProviderProfiles).mockResolvedValue([first, second]);
  vi.mocked(api.listLocalModelClientStatuses).mockResolvedValue([]);
  let finish!: () => void;
  vi.mocked(api.reorderModelProviderProfiles).mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
  const user = userEvent.setup();
  render(<ModelProviderPanel api={api} />);
  (await screen.findByRole("button", { name: /拖拽排序 First/u })).focus();
  await user.keyboard("{ArrowDown}");
  expect(screen.getByRole("switch", { name: "启用 Second" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "编辑 Second" })).toBeDisabled();
  const test = screen.getByRole("button", { name: "测试 Second" });
  expect(test).toBeEnabled();
  await user.click(test);
  expect(api.testModelProviderProfile).toHaveBeenCalledWith("remote-second");
  await act(async () => { finish(); });
  expect(screen.getByRole("switch", { name: "启用 Second" })).toBeEnabled();
});

it("keeps a switch save when an older full read waits for client discovery and returns afterward", async () => {
  const { api } = apiFixture(rationaleSnapshot({ current: null }));
  const backend = { version: 1 as const, profileId: "remote-openai", kind: "openai" as const, label: "OpenAI", enabled: true, priority: 10, model: "gpt-test", timeoutMs: 30_000, baseUrl: "https://api.openai.com", credentialConfigured: true };
  const cli = { ...backend, profileId: "builtin-codex", kind: "codex-cli" as const, label: "Codex CLI", priority: 20, executablePath: "/usr/local/bin/codex" };
  vi.mocked(api.listModelProviderProfiles).mockResolvedValue([backend, cli]);
  let finishDiscovery!: (value: Statuses) => void;
  let finishSave!: (value: typeof backend) => void;
  vi.mocked(api.listLocalModelClientStatuses).mockResolvedValueOnce([])
    .mockReturnValueOnce(new Promise((resolve) => { finishDiscovery = resolve; }));
  vi.mocked(api.saveModelProviderProfile).mockReturnValueOnce(new Promise((resolve) => { finishSave = resolve; }));
  const user = userEvent.setup();
  render(<ModelProviderPanel api={api} />);
  const toggle = await screen.findByRole("switch", { name: "启用 OpenAI" });
  await user.click(toggle);
  await user.click(screen.getByRole("button", { name: "配置 Codex CLI" }));
  const dialog = within(screen.getByRole("dialog", { name: "配置 Codex CLI" }));
  await user.click(dialog.getByRole("button", { name: "刷新模型候选" }));
  await act(async () => { finishSave({ ...backend, enabled: false }); });
  expect(toggle).not.toBeChecked();
  await act(async () => { finishDiscovery([]); });
  await user.click(dialog.getByRole("button", { name: "取消" }));
  expect(toggle).not.toBeChecked();
  expect(toggle).toBeEnabled();
});

it.each(["backend", "judge"] as const)("saves %s switches independently, without refreshing every client or losing another row's changes", async (kind) => {
  const { api } = apiFixture(rationaleSnapshot({ current: null }));
  const backend = { version: 1 as const, profileId: "remote-openai", kind: "openai" as const, label: "OpenAI", enabled: true, priority: 10, model: "gpt-test", timeoutMs: 30_000, baseUrl: "https://api.openai.com", credentialConfigured: true };
  const judge = { ...backend, profileId: "remote-jev", kind: "openrouter-decisions" as const, label: "jev", priority: 20, baseUrl: "https://openrouter.ai/api/alpha/decisions" };
  vi.mocked(api.listModelProviderProfiles).mockResolvedValue([backend, judge]);
  vi.mocked(api.listLocalModelClientStatuses).mockResolvedValue([]);
  const [first, second] = kind === "backend" ? [backend, judge] : [judge, backend];
  type Saved = Awaited<ReturnType<DecisionApi["saveModelProviderProfile"]>>;
  let finishFirst!: (profile: Saved) => void;
  let failSecond!: (error: Error) => void;
  vi.mocked(api.saveModelProviderProfile)
    .mockReturnValueOnce(new Promise<Saved>((resolve) => { finishFirst = resolve; }))
    .mockReturnValueOnce(new Promise<Saved>((_resolve, reject) => { failSecond = reject; }));
  const user = userEvent.setup();
  render(<ModelProviderPanel api={api} />);
  const enabled = await screen.findByRole("switch", { name: `启用 ${first.label}` });
  const fallback = screen.getByRole("switch", { name: `${second.label} 失败后切换` });
  await user.dblClick(enabled);
  expect(enabled).toBeDisabled();
  expect(screen.getByRole("switch", { name: `${first.label} 失败后切换` })).toBeDisabled();
  expect(screen.getByRole("button", { name: `测试 ${first.label}` })).toBeDisabled();
  expect(fallback).toBeEnabled();
  expect(screen.getByRole("button", { name: `测试 ${second.label}` })).toBeEnabled();
  expect(screen.getByRole("button", { name: "添加模型后端" })).toBeEnabled();
  expect(screen.getByRole("button", { name: new RegExp(`拖拽排序 ${second.label}`, "u") })).toBeDisabled();
  await user.click(fallback);
  expect(api.saveModelProviderProfile).toHaveBeenCalledTimes(2);
  expect(api.saveModelProviderProfile).toHaveBeenNthCalledWith(1, { profile: { ...first, enabled: false } });
  expect(api.saveModelProviderProfile).toHaveBeenNthCalledWith(2, { profile: { ...second, fallbackOnFailure: false } });
  await act(async () => { finishFirst({ ...first, enabled: false }); });
  expect(enabled).not.toBeChecked();
  expect(enabled).toBeEnabled();
  expect(fallback).toBeDisabled();
  await act(async () => { failSecond(new Error("磁盘不可写")); });
  expect(fallback).toBeEnabled();
  expect(fallback).toBeChecked();
  expect(within(fallback.closest("li")!).getByRole("alert")).toHaveTextContent("操作失败 · 磁盘不可写");
  expect(enabled).not.toBeChecked();
  expect(api.listModelProviderProfiles).toHaveBeenCalledTimes(1);
  expect(api.listLocalModelClientStatuses).toHaveBeenCalledTimes(1);
  vi.mocked(api.saveModelProviderProfile).mockResolvedValueOnce({ ...second, fallbackOnFailure: false });
  await user.click(fallback);
  expect(fallback).not.toBeChecked();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(enabled).not.toBeChecked();
});

it("tests backends and judges concurrently and keeps each pending state, result and error on its own row", async () => {
  const { api } = apiFixture(rationaleSnapshot({ current: null }));
  const openai = { version: 1 as const, profileId: "remote-openai", kind: "openai" as const, label: "OpenAI", enabled: true, priority: 10, model: "gpt-test", timeoutMs: 30_000, baseUrl: "https://api.openai.com", credentialConfigured: true };
  const deepseek = { ...openai, profileId: "remote-deepseek", kind: "openai-compatible" as const, label: "DeepSeek", priority: 20, baseUrl: "https://api.deepseek.com" };
  const jev = { ...openai, profileId: "remote-jev", kind: "openrouter-decisions" as const, label: "jev", priority: 30, baseUrl: "https://openrouter.ai/api/alpha/decisions" };
  vi.mocked(api.listModelProviderProfiles).mockResolvedValue([openai, deepseek, jev]);
  vi.mocked(api.listLocalModelClientStatuses).mockResolvedValue([]);
  type TestResult = Awaited<ReturnType<DecisionApi["testModelProviderProfile"]>>;
  let failOpenAI!: (error: Error) => void;
  let finishDeepSeek!: (result: TestResult) => void;
  let finishJudge!: (result: TestResult) => void;
  vi.mocked(api.testModelProviderProfile)
    .mockReturnValueOnce(new Promise<TestResult>((_resolve, reject) => { failOpenAI = reject; }))
    .mockReturnValueOnce(new Promise<TestResult>((resolve) => { finishDeepSeek = resolve; }))
    .mockReturnValueOnce(new Promise<TestResult>((resolve) => { finishJudge = resolve; }));
  const user = userEvent.setup();
  render(<ModelProviderPanel api={api} />);
  const first = await screen.findByRole("button", { name: "测试 OpenAI" });
  const second = screen.getByRole("button", { name: "测试 DeepSeek" });
  const judge = screen.getByRole("button", { name: "测试 jev" });

  await user.dblClick(first);
  expect(first).toBeDisabled();
  expect(first).toHaveAttribute("aria-busy", "true");
  expect(screen.getByRole("status", { name: "OpenAI 测试中" })).toBeVisible();
  expect(screen.getByRole("button", { name: "编辑 OpenAI" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "删除 OpenAI" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "添加模型后端" })).toBeEnabled();
  await user.click(screen.getByRole("button", { name: "编辑 DeepSeek" }));
  await user.click(within(screen.getByRole("dialog", { name: "编辑 DeepSeek" })).getByRole("button", { name: "取消" }));
  expect(second).toBeEnabled();
  expect(judge).toBeEnabled();
  await user.click(second);
  await user.click(judge);
  expect(api.testModelProviderProfile).toHaveBeenCalledTimes(3);
  expect(api.testModelProviderProfile).toHaveBeenNthCalledWith(1, "remote-openai");
  expect(api.testModelProviderProfile).toHaveBeenNthCalledWith(2, "remote-deepseek");
  expect(api.testModelProviderProfile).toHaveBeenNthCalledWith(3, "remote-jev");

  await act(async () => { finishJudge({ ok: true, profileId: "remote-jev", latencyMs: 123, requestId: "judge-test" }); });
  expect(screen.getByRole("status", { name: "jev 测试通过" })).toHaveTextContent("123 ms");
  expect(judge).toBeEnabled();
  expect(first).toBeDisabled();
  expect(second).toBeDisabled();

  await act(async () => { failOpenAI(new Error("连接已断开")); });
  const firstRow = within(first.closest("li")!);
  expect(firstRow.getByRole("alert")).toHaveTextContent("连接已断开");
  expect(first).toBeEnabled();
  expect(second).toBeDisabled();
  expect(screen.getByRole("status", { name: "DeepSeek 测试中" })).toBeVisible();
  expect(screen.getByRole("status", { name: "jev 测试通过" })).toBeVisible();

  vi.mocked(api.testModelProviderProfile).mockResolvedValueOnce({ ok: true, profileId: "remote-openai", latencyMs: 456, requestId: "openai-retry" });
  await user.click(first);
  expect(firstRow.queryByRole("alert")).toBeNull();
  expect(await firstRow.findByRole("status", { name: "OpenAI 测试通过" })).toHaveTextContent("456 ms");
  expect(second).toBeDisabled();
  await act(async () => { finishDeepSeek({ ok: false, profileId: "remote-deepseek", latencyMs: 789, requestId: "deepseek-test", errorCode: "timeout" }); });
  expect(screen.getByRole("status", { name: "DeepSeek 测试失败" })).toHaveTextContent("请求超时");
  expect(screen.queryByRole("status", { name: /测试中/u })).toBeNull();
  expect(second).toBeEnabled();
});

it("keeps the candidates 刷新模型候选 read when the slower read from opening the page lands after it", async () => {
  const { api } = apiFixture(rationaleSnapshot({ current: null }));
  vi.mocked(api.listModelProviderProfiles).mockResolvedValue([
    { version: 1, profileId: "builtin-claude-code", kind: "claude-code-cli", label: "Claude Code CLI", enabled: false, priority: 30, timeoutMs: 30_000, credentialConfigured: false },
  ]);
  const client = { kind: "claude-code-cli" as const, executablePath: "/opt/homebrew/bin/claude", version: "2.1.220", authenticated: true, supported: true, availability: "available" as const, checkedAt: "2026-07-30T00:00:00.000Z" };
  let finishOpening: ((value: Statuses) => void) | undefined;
  vi.mocked(api.listLocalModelClientStatuses)
    .mockReturnValueOnce(new Promise<Statuses>((resolve) => { finishOpening = resolve; }))
    .mockResolvedValue([{ ...client, modelsSource: "server", models: [{ id: "claude-opus-test", label: "Opus" }] }]);
  const user = userEvent.setup();
  render(<ModelProviderPanel api={api} />);
  const panel = await screen.findByRole("region", { name: "模型后端" });
  await user.click(await within(panel).findByRole("button", { name: "配置 Claude Code CLI" }));
  const dialog = within(screen.getByRole("dialog", { name: "配置 Claude Code CLI" }));
  expect(dialog.getByLabelText("网络代理")).toBeVisible();
  expect(dialog.queryByRole("option", { name: "仅本机 loopback 直连" })).not.toBeInTheDocument();
  expect(dialog.getByRole("option", { name: "使用全局模型代理" })).toBeInTheDocument();
  expect(dialog.queryByLabelText("不走代理的主机（可选）")).not.toBeInTheDocument();
  await user.click(dialog.getByRole("button", { name: "刷新模型候选" }));
  expect(await dialog.findByText(/候选来源：服务端直查/u)).toBeVisible();
  const candidates = () => [...dialog.getByRole("combobox", { name: "选择候选模型" }).querySelectorAll("option")].map((option) => option.value).filter(Boolean);
  expect(candidates()).toEqual(["claude-opus-test"]);

  // The read from opening the page, its server query failed back then, comes back only now: it emptied the list.
  await act(async () => { finishOpening!([client]); await Promise.resolve(); });
  expect(dialog.getByText(/候选来源：服务端直查/u)).toBeVisible();
  expect(candidates()).toEqual(["claude-opus-test"]);
});

it("lists every model candidate while a model is filled in, and fills in the one picked", async () => {
  // A datalist offers only the options containing what is typed: with gpt-6-luna filled in, Codex's eight models showed as its two Luna ones.
  const { api } = apiFixture(rationaleSnapshot({ current: null }));
  vi.mocked(api.listModelProviderProfiles).mockResolvedValue([
    { version: 1, profileId: "builtin-codex", kind: "codex-cli", label: "Codex CLI", enabled: true, priority: 20, model: "gpt-6-luna", timeoutMs: 30_000, credentialConfigured: false },
    { version: 1, profileId: "remote-deepseek", kind: "openai-compatible", label: "DeepSeek", enabled: true, priority: 10, model: "deepseek-flash", timeoutMs: 30_000,
      baseUrl: "https://api.deepseek.com", apiProtocol: "chat-completions", credentialConfigured: true },
  ]);
  vi.mocked(api.listLocalModelClientStatuses).mockResolvedValue([{ kind: "codex-cli", authenticated: true, supported: true, availability: "available", checkedAt: "2026-07-30T00:00:00.000Z", modelsSource: "server",
    models: [{ id: "gpt-6.1-sol", label: "GPT-6.1-Sol" }, { id: "gpt-6-luna", label: "GPT-6-Luna" }, { id: "gpt-5.6-luna", label: "GPT-5.6-Luna" }] }]);
  const user = userEvent.setup();
  render(<ModelProviderPanel api={api} />);
  const panel = await screen.findByRole("region", { name: "模型后端" });

  await user.click(await within(panel).findByRole("button", { name: "配置 Codex CLI" }));
  const cli = within(screen.getByRole("dialog", { name: "配置 Codex CLI" }));
  const cliCandidates = await cli.findByRole("combobox", { name: "选择候选模型" });
  expect(within(cliCandidates).getAllByRole("option").map((option) => option.textContent)).toEqual(["GPT-6.1-Sol", "GPT-6-Luna", "GPT-5.6-Luna"]);
  expect(cliCandidates).toHaveValue("gpt-6-luna");
  await user.selectOptions(cliCandidates, "gpt-6.1-sol");
  expect(cli.getByLabelText("客户端模型")).toHaveValue("gpt-6.1-sol");
  await user.clear(cli.getByLabelText("客户端模型"));
  await user.type(cli.getByLabelText("客户端模型"), "gpt-custom");
  // Typed by hand, no candidate is marked as the one in use.
  expect(cliCandidates).toHaveValue("");
  await user.click(cli.getByRole("button", { name: "取消" }));

  await user.click(within(panel).getByRole("button", { name: "编辑 DeepSeek" }));
  const remote = within(screen.getByRole("dialog", { name: "编辑 DeepSeek" }));
  await user.selectOptions(remote.getByRole("combobox", { name: "选择候选模型" }), "deepseek-v4-pro");
  expect(remote.getByLabelText("模型")).toHaveValue("deepseek-v4-pro");
});

it("says a test the provider's content moderation refused is about the content, not the key", async () => {
  const { api } = apiFixture(rationaleSnapshot({ current: null }));
  vi.mocked(api.listModelProviderProfiles).mockResolvedValue([
    { version: 1, profileId: "remote-openrouter", kind: "openai-compatible", label: "OpenRouter", enabled: true, priority: 10, model: "openai/gpt-4o", timeoutMs: 30_000,
      baseUrl: "https://openrouter.ai/api/v1", apiProtocol: "chat-completions", credentialConfigured: true },
  ]);
  vi.mocked(api.testModelProviderProfile).mockResolvedValue({ ok: false, profileId: "remote-openrouter", latencyMs: 412, requestId: "health-refused", errorCode: "content_refused",
    diagnosticExcerpt: "HTTP 403: {\"error\":{\"code\":403,\"message\":\"Your input was flagged for \\\"harassment\\\".\"}}" });
  const user = userEvent.setup();
  render(<ModelProviderPanel api={api} />);
  const panel = await screen.findByRole("region", { name: "模型后端" });
  await user.click(await within(panel).findByRole("button", { name: "测试 OpenRouter" }));

  const result = await within(panel).findByRole("status", { name: "OpenRouter 测试失败" });
  // Said as 没有访问权限, it sent the reader to a key that was fine.
  expect(result).toHaveTextContent("测试失败 · 内容被服务商审核拒绝 · 412 ms");
  expect(result).toHaveTextContent("flagged for");
});

// R15-JEVSET: jev sits in a section of its own, out of the ordered list generation goes down.
it("keeps jev out of the ordered list, saves its key one way only, and says what a test cost", async () => {
  const { api } = apiFixture(rationaleSnapshot({ current: null }));
  const openai = { version: 1 as const, profileId: "remote-openai", kind: "openai" as const, label: "OpenAI", enabled: true, priority: 10, model: "gpt-test", timeoutMs: 30_000, baseUrl: "https://api.openai.com", apiProtocol: "responses" as const, credentialConfigured: true };
  const qwen = { version: 1 as const, profileId: "builtin-qwen", kind: "qwen" as const, label: "Qwen", enabled: true, priority: 20, model: "qwen3.5-4b-q4-k-m", timeoutMs: 30_000, credentialConfigured: false };
  const jev = { version: 1 as const, profileId: "remote-jev", kind: "openrouter-decisions" as const, label: "jev", enabled: true, priority: 30, model: "typesafe/jev-1.14", timeoutMs: 30_000, credentialConfigured: true };
  vi.mocked(api.listModelProviderProfiles).mockResolvedValue([openai, qwen, jev]);
  vi.mocked(api.listLocalModelClientStatuses).mockResolvedValue([]);
  vi.mocked(api.testModelProviderProfile).mockResolvedValue({ ok: true, profileId: "remote-jev", latencyMs: 620, requestId: "health", tokenSource: "provider_reported", costUsd: 0.000003 });
  const user = userEvent.setup();
  render(<ModelProviderPanel api={api} />);
  const panel = await screen.findByRole("region", { name: "模型后端" });
  const judges = within(await within(panel).findByRole("region", { name: "判定模型（不参与生成）" }));

  const ordered = within(panel.querySelector("ol.model-provider-list") as HTMLElement);
  expect(ordered.queryByText("jev")).toBeNull();
  expect(ordered.getAllByRole("listitem")).toHaveLength(2);
  expect(judges.getByText("jev")).toBeVisible();

  // Moved in the ordered list, the judge keeps its place at the end: the repository takes every profile at once.
  ordered.getByRole("button", { name: /拖拽排序 OpenAI/u }).focus();
  await user.keyboard("{ArrowDown}");
  expect(api.reorderModelProviderProfiles).toHaveBeenCalledWith(["builtin-qwen", "remote-openai", "remote-jev"]);

  await user.click(judges.getByRole("button", { name: "测试 jev" }));
  expect(await judges.findByRole("status", { name: "jev 测试通过" })).toHaveTextContent("费用 $0.000003");

  await user.click(judges.getByRole("button", { name: "编辑 jev" }));
  const dialog = within(screen.getByRole("dialog", { name: "编辑 jev" }));
  const secret = dialog.getByLabelText("API 密钥");
  expect(secret).toHaveAttribute("type", "password");
  expect(secret).toHaveValue("");
  expect(dialog.getByLabelText("模型")).toHaveValue("typesafe/jev-1.14");
  // A judge saved before it had an address of its own is OpenRouter's, in the System One shape.
  expect(dialog.getByLabelText("接口地址")).toHaveValue("https://openrouter.ai/api/alpha/decisions");
  expect(dialog.getByLabelText("API 协议")).toHaveValue("systemone");
  await user.type(secret, "or-key-synthetic");
  await user.click(dialog.getByRole("button", { name: "保存" }));
  // Left as they were, the address and the shape stay unset.
  expect(api.saveModelProviderProfile).toHaveBeenCalledWith({
    profile: { version: 1, profileId: "remote-jev", kind: "openrouter-decisions", label: "jev", enabled: true, priority: 30, model: "typesafe/jev-1.14", timeoutMs: 30_000, proxy: { mode: "environment" }, credentialConfigured: true },
    secret: "or-key-synthetic",
  });
});

// A judge can be any decisions API: its whole endpoint, path included, and the shape it takes.
it("adds a judge at another service from a preset, refuses an address a key could ride in, and asks for a new key when the site changes", async () => {
  const { api } = apiFixture(rationaleSnapshot({ current: null }));
  const jev = { version: 1 as const, profileId: "remote-jev", kind: "openrouter-decisions" as const, label: "jev", enabled: true, priority: 30, model: "typesafe/jev-1.14", timeoutMs: 30_000, credentialConfigured: true };
  vi.mocked(api.listModelProviderProfiles).mockResolvedValue([jev]);
  vi.mocked(api.listLocalModelClientStatuses).mockResolvedValue([]);
  const user = userEvent.setup();
  render(<ModelProviderPanel api={api} />);
  const judges = within(await screen.findByRole("region", { name: "判定模型（不参与生成）" }));
  // The row says where it sends.
  expect(judges.getByText(/openrouter\.ai · typesafe\/jev-1\.14/u)).toBeVisible();

  await user.click(judges.getByRole("button", { name: "添加判定模型" }));
  const adding = within(screen.getByRole("dialog", { name: "添加判定模型" }));
  // A key typed for OpenRouter does not go along to another site.
  await user.type(adding.getByLabelText("API 密钥"), "or-key-SYNTHETIC-000001");
  await user.click(adding.getByRole("button", { name: "OpenAI" }));
  expect(adding.getByLabelText("API 密钥")).toHaveValue("");
  expect(adding.getByLabelText("接口地址")).toHaveValue("https://api.openai.com/v1/decisions");
  expect(adding.getByLabelText("API 协议")).toHaveValue("openai");
  expect(adding.getByLabelText("模型")).toHaveValue("gpt-6-luna");
  const endpoint = adding.getByLabelText("接口地址");
  await user.clear(endpoint);
  await user.type(endpoint, "https://api.openai.com/v1/decisions?key=abc");
  await user.type(adding.getByLabelText("API 密钥"), "openai-key-SYNTHETIC-0001");
  await user.click(adding.getByRole("button", { name: "保存" }));
  expect(await adding.findByText(/接口地址必须使用 HTTPS.*不含账号密码、查询参数或片段/u)).toBeVisible();
  expect(api.saveModelProviderProfile).not.toHaveBeenCalled();
  // Another path at the same site keeps the key typed for it.
  await user.clear(endpoint);
  await user.type(endpoint, "https://api.openai.com/v1/decisions");
  await user.clear(adding.getByLabelText("API 密钥"));
  await user.type(adding.getByLabelText("API 密钥"), "openai-key-SYNTHETIC-0001");
  await user.type(endpoint, "/");
  expect(adding.getByLabelText("API 密钥")).toHaveValue("openai-key-SYNTHETIC-0001");
  await user.type(endpoint, "{Backspace}");
  await user.click(adding.getByRole("button", { name: "保存" }));
  expect(api.saveModelProviderProfile).toHaveBeenCalledWith({
    profile: expect.objectContaining({ kind: "openrouter-decisions", label: "OpenAI", baseUrl: "https://api.openai.com/v1/decisions", decisionsProtocol: "openai", model: "gpt-6-luna" }),
    secret: "openai-key-SYNTHETIC-0001",
  });

  await waitFor(() => expect(judges.getByRole("button", { name: "编辑 jev" })).toBeEnabled());
  await user.click(judges.getByRole("button", { name: "编辑 jev" }));
  const editing = within(screen.getByRole("dialog", { name: "编辑 jev" }));
  expect(editing.getByText("已安全保存，留空则不更换")).toBeVisible();
  await user.click(editing.getByRole("button", { name: "OpenAI" }));
  expect(editing.getByText("地址换到了另一个站点，需要填写这个站点的 API 密钥")).toBeVisible();
});

it("drops a key typed for a backend when its address moves to another site", async () => {
  const { api } = apiFixture(rationaleSnapshot({ current: null }));
  vi.mocked(api.listModelProviderProfiles).mockResolvedValue([]);
  vi.mocked(api.listLocalModelClientStatuses).mockResolvedValue([]);
  const user = userEvent.setup();
  render(<ModelProviderPanel api={api} />);
  const panel = await screen.findByRole("region", { name: "模型后端" });
  await user.click(within(panel).getByRole("button", { name: "添加模型后端" }));
  const dialog = within(screen.getByRole("dialog", { name: "添加模型后端" }));
  await user.type(dialog.getByLabelText("API 密钥"), "openai-key-SYNTHETIC-0001");
  const address = dialog.getByLabelText("服务地址");
  await user.clear(address);
  await user.type(address, "https://relay.example");
  expect(dialog.getByLabelText("API 密钥")).toHaveValue("");
});

// Judges are ordered and fail over as backends do, each list within itself.
it("orders the judges among themselves, fails over between them, and offers to add another", async () => {
  const { api } = apiFixture(rationaleSnapshot({ current: null }));
  const openai = { version: 1 as const, profileId: "remote-openai", kind: "openai" as const, label: "OpenAI", enabled: true, priority: 10, model: "gpt-test", timeoutMs: 30_000, baseUrl: "https://api.openai.com", apiProtocol: "responses" as const, credentialConfigured: true };
  const jev = { version: 1 as const, profileId: "remote-jev", kind: "openrouter-decisions" as const, label: "jev", enabled: true, priority: 30, model: "typesafe/jev-1.14", timeoutMs: 30_000, credentialConfigured: true };
  const luna = { ...jev, profileId: "remote-luna", label: "Luna", priority: 40, model: "openai/gpt-6-luna-decisions" };
  vi.mocked(api.listModelProviderProfiles).mockResolvedValue([openai, jev, luna]);
  vi.mocked(api.listLocalModelClientStatuses).mockResolvedValue([]);
  const user = userEvent.setup();
  render(<ModelProviderPanel api={api} />);
  const judges = within(await screen.findByRole("region", { name: "判定模型（不参与生成）" }));
  expect(judges.getAllByRole("listitem")).toHaveLength(2);

  // The judges move among themselves, after the backends.
  judges.getByRole("button", { name: /拖拽排序 jev/u }).focus();
  await user.keyboard("{ArrowDown}");
  expect(api.reorderModelProviderProfiles).toHaveBeenCalledWith(["remote-openai", "remote-luna", "remote-jev"]);

  // The first judge goes no higher.
  vi.mocked(api.reorderModelProviderProfiles).mockClear();
  const firstHandle = judges.getByRole("button", { name: /拖拽排序 jev/u });
  await waitFor(() => expect(firstHandle).toBeEnabled());
  firstHandle.focus();
  await user.keyboard("{ArrowUp}");
  expect(api.reorderModelProviderProfiles).not.toHaveBeenCalled();

  // Dragged by its handle and let go over the second row (its lower half, as jsdom's rows have no height), the
  // first judge goes after it.
  const secondRow = judges.getAllByRole("listitem")[1]!;
  const carried = new Map<string, string>();
  const dragging = { effectAllowed: "", dropEffect: "", setData: vi.fn((type: string, value: string) => { carried.set(type, value); }), getData: vi.fn((type: string) => carried.get(type) ?? "") };
  fireEvent.dragStart(firstHandle, { dataTransfer: dragging });
  fireEvent.dragOver(secondRow, { clientY: 10, dataTransfer: dragging });
  fireEvent.drop(secondRow, { clientY: 10, dataTransfer: dragging });
  await waitFor(() => expect(api.reorderModelProviderProfiles).toHaveBeenCalledWith(["remote-openai", "remote-luna", "remote-jev"]));

  // A backend let go over a judge stays where it was: neither list takes the other's rows.
  const dataTransfer = { effectAllowed: "", dropEffect: "", setData: vi.fn(), getData: vi.fn(() => "remote-openai") };
  vi.mocked(api.reorderModelProviderProfiles).mockClear();
  fireEvent.drop(judges.getAllByRole("listitem")[0]!, { clientY: 10, dataTransfer });
  expect(api.reorderModelProviderProfiles).not.toHaveBeenCalled();

  await waitFor(() => expect(judges.getByRole("switch", { name: "jev 失败后切换" })).toBeEnabled());
  await user.click(judges.getByRole("switch", { name: "jev 失败后切换" }));
  expect(api.saveModelProviderProfile).toHaveBeenCalledWith({ profile: { ...jev, fallbackOnFailure: false } });

  await user.click(judges.getByRole("button", { name: "添加判定模型" }));
  expect(screen.getByRole("dialog", { name: "添加判定模型" })).toBeInTheDocument();
});

it("keeps a judge's 失败后切换 off when it is edited and saved", async () => {
  const { api } = apiFixture(rationaleSnapshot({ current: null }));
  const jev = { version: 1 as const, profileId: "remote-jev", kind: "openrouter-decisions" as const, label: "jev", enabled: true, priority: 30, model: "typesafe/jev-1.14", timeoutMs: 30_000, proxy: { mode: "environment" as const }, fallbackOnFailure: false, credentialConfigured: true };
  vi.mocked(api.listModelProviderProfiles).mockResolvedValue([jev]);
  vi.mocked(api.listLocalModelClientStatuses).mockResolvedValue([]);
  const user = userEvent.setup();
  render(<ModelProviderPanel api={api} />);
  const judges = within(await screen.findByRole("region", { name: "判定模型（不参与生成）" }));
  await user.click(judges.getByRole("button", { name: "编辑 jev" }));
  await user.click(within(screen.getByRole("dialog", { name: "编辑 jev" })).getByRole("button", { name: "保存" }));
  expect(api.saveModelProviderProfile).toHaveBeenCalledWith({ profile: jev });
});

it("offers to add jev with the default model when there is none", async () => {
  const { api } = apiFixture(rationaleSnapshot({ current: null }));
  vi.mocked(api.listModelProviderProfiles).mockResolvedValue([]);
  vi.mocked(api.listLocalModelClientStatuses).mockResolvedValue([]);
  const user = userEvent.setup();
  render(<ModelProviderPanel api={api} />);
  const judges = within(await screen.findByRole("region", { name: "判定模型（不参与生成）" }));
  // Optional, said in neutral words: nothing added is not something to fix.
  expect(judges.getByText("可选，仅用于判断与评分，按本组顺序调用。")).toBeVisible();
  expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  const help = judges.getByRole("button", { name: "判定模型使用说明" });
  await user.hover(help);
  expect(screen.getByRole("tooltip")).toHaveClass("action-tooltip");
  expect(screen.getByRole("tooltip")).toHaveTextContent("调用内容保留90天");
  await user.unhover(help);
  expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  fireEvent.keyDown(document.body, { key: "Tab" });
  act(() => help.focus());
  expect(screen.getByRole("tooltip")).toHaveTextContent("System One");
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  const empty = judges.getByText("未添加（可选）");
  expect(empty).toHaveClass("empty-copy");
  expect(empty.closest(".provider-status-attention, [role='alert']")).toBeNull();
  expect(judges.queryByText("尚未配置凭据")).toBeNull();
  await user.click(await screen.findByRole("button", { name: "添加判定模型" }));
  const dialog = within(screen.getByRole("dialog", { name: "添加判定模型" }));
  expect(dialog.getByLabelText("模型")).toHaveValue("typesafe/jev-1.14");
  await user.click(dialog.getByRole("button", { name: "保存" }));
  expect(await dialog.findByText("请输入 API 密钥。")).toBeVisible();
  expect(api.saveModelProviderProfile).not.toHaveBeenCalled();
});

it("shows and saves the global proxy in the model page without requiring environment variables", async () => {
  const { api } = apiFixture(rationaleSnapshot({ current: null, modelProxyUrl: "http://127.0.0.1:7890" }));
  const user = userEvent.setup(); render(<ModelProviderPanel api={api} />);
  const field = await screen.findByLabelText("全局模型代理地址");
  await waitFor(() => expect(field).toHaveValue("http://127.0.0.1:7890"));
  expect(field).toBeEnabled();
  const proxyCard = screen.getByRole("region", { name: "全局模型代理" });
  const backendCard = screen.getByRole("region", { name: "模型后端" });
  expect(backendCard).not.toContainElement(proxyCard);
  expect(proxyCard.parentElement).toBe(backendCard.parentElement);
  expect(proxyCard.compareDocumentPosition(backendCard) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(within(proxyCard).getByText(/模型后端和判定模型/u)).toBeVisible();
  await user.clear(field); await user.type(field, "socks5://127.0.0.1:1080");
  await user.click(screen.getByRole("button", { name: "保存全局代理" }));
  expect(screen.getByRole("alert")).toHaveTextContent("HTTP/HTTPS"); expect(api.setModelProxyUrl).not.toHaveBeenCalled();
  await user.clear(field); await user.type(field, "http://127.0.0.1:8888");
  await user.click(screen.getByRole("button", { name: "保存全局代理" }));
  expect(api.setModelProxyUrl).toHaveBeenCalledWith("http://127.0.0.1:8888");
  expect(await screen.findByText("全局模型代理已保存，客户端状态已刷新。")).toBeVisible();
  await user.clear(field); await user.click(screen.getByRole("button", { name: "保存全局代理" }));
  expect(api.setModelProxyUrl).toHaveBeenLastCalledWith(null);
});
it("distinguishes missing proxy configuration from failed CLI checks", async () => {
  const { api } = apiFixture(rationaleSnapshot({ current: null }));
  vi.mocked(api.listModelProviderProfiles).mockResolvedValue([{ version: 1, profileId: "builtin-codex", kind: "codex-cli", label: "Codex CLI", enabled: true, priority: 20, timeoutMs: 30000, credentialConfigured: false }]);
  vi.mocked(api.listLocalModelClientStatuses).mockResolvedValue([{ kind: "codex-cli", executablePath: "/bin/client", authenticated: false, supported: false, availability: "proxy_required", checkedAt: "2026-11-02T00:00:00.000Z" }]);
  render(<ModelProviderPanel api={api} />);
  expect(await screen.findByText("需要配置网络代理")).toBeVisible();
  expect(screen.queryByText("客户端检查失败")).not.toBeInTheDocument();
});
