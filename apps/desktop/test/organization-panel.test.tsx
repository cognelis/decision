// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OrganizationPanel, type OrganizationApi } from "../src/renderer/components/pages/organization/OrganizationPanel.js";
import { createOrganizationPreview } from "../src/renderer/preview-organization.js";
const profile = { version: 1 as const, profileId: "p1", kind: "openai" as const, label: "测试模型", enabled: true, priority: 1, timeoutMs: 30000, credentialConfigured: true };
const setup = (override: Partial<OrganizationApi> = {}, interaction: string | null = null) => {
  const preview = createOrganizationPreview(interaction);
  const api: OrganizationApi = {
    ...preview,
    getOrganization: vi.fn(preview.getOrganization), decideSuggestion: vi.fn(preview.decideSuggestion), saveSuggestionDraft: vi.fn(preview.saveSuggestionDraft), undoSuggestion: vi.fn(preview.undoSuggestion), setOrganizationSettings: vi.fn(preview.setOrganizationSettings),
    listModelProviderProfiles: vi.fn(async () => [profile]), openVaultDocument: vi.fn(async () => undefined), ...override,
  };
  const onClose = vi.fn();
  render(<OrganizationPanel api={api} organizationRevision={0} context={{ project: null, projects: ["消息服务（示例）", "网关"], listId: "preview-msg", listTitle: "消息清单", items: ["todo_item:preview-msg#12"] }} onClose={onClose} />);
  return { api, onClose, user: userEvent.setup() };
};
afterEach(cleanup);
const memory = async (user: ReturnType<typeof userEvent.setup>) => { await user.click(await screen.findByRole("tab", { name: "记忆" })); await user.click(await screen.findByRole("button", { name: /修复重复发送后，在指定重试场景下验证/u })); };

describe("自动维护界面", () => {
  it("默认全局总览，五个页签；输入、更新和问题分开计数，常规结果没有采纳按钮", async () => {
    const { api } = setup();
    expect(await screen.findByText("38")).toBeVisible();
    expect(screen.getAllByRole("tab")).toHaveLength(5);
    expect(api.getOrganization).toHaveBeenCalledWith({ scope: "all", project: null });
    expect(screen.getByText("安静保留，不催你")).toBeVisible();
    expect(screen.queryByRole("button", { name: /^采纳/u })).toBeNull();
  });
  it("没有待判断问题时保留安静状态，不引导逐项整理", async () => {
    const real = createOrganizationPreview(null).getOrganization;
    setup({ getOrganization: async (query) => { const view = await real(query); return { ...view, counts: { todo: 0, memory: 0, conflict: 0, pending: 0 }, suggestions: view.suggestions.filter((s) => s.type !== "judgment") }; } });
    expect(await screen.findByText(/当前没有需要你判断的事项。/u)).toBeVisible();
    expect(screen.queryByRole("button", { name: "查看并选择" })).toBeNull();
  });
  it("项目与来源筛选传回明确范围，不把项目过滤误当作全局", async () => {
    const { api, user } = setup();
    await screen.findByText("最近自动更新");
    await user.selectOptions(screen.getByRole("combobox", { name: "项目" }), "网关");
    await user.selectOptions(screen.getByRole("combobox", { name: "来源" }), "principle");
    await waitFor(() => expect(api.getOrganization).toHaveBeenLastCalledWith({ scope: "project", project: "网关", source: "principle" }));
    await user.selectOptions(screen.getByRole("combobox", { name: "范围" }), "selection");
    await waitFor(() => expect(api.getOrganization).toHaveBeenLastCalledWith({ scope: "selection", project: null, items: ["todo_item:preview-msg#12"], source: "principle" }));
  });
  it("问题明确点击确认才提交，带回用户看到的版本；建议默认选中", async () => {
    const { api, user } = setup();
    await user.click(await screen.findByRole("tab", { name: /需要你判断/u }));
    expect(await screen.findByRole("radio", { name: /先完成已承诺的修复/u })).toBeChecked();
    expect(api.decideSuggestion).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "确认选择" }));
    expect(api.decideSuggestion).toHaveBeenCalledWith({ id: "preview-org-judgment", expectedRevision: 1, expectedEvidenceVersion: 1, action: "adopt", choice: "option_a" });
  });
  it("可暂不判断，不用补理由，也不会执行业务任务", async () => {
    const { api, user } = setup();
    await user.click(await screen.findByRole("tab", { name: /需要你判断/u }));
    await user.click(await screen.findByRole("radio", { name: /暂不判断/u }));
    await user.click(screen.getByRole("button", { name: "暂不判断" }));
    expect(api.decideSuggestion).toHaveBeenCalledWith(expect.objectContaining({ choice: "hold" }));
  });
  it("自动记忆可纠正，并发冲突时保留输入", async () => {
    const { api, user } = setup({ decideSuggestion: vi.fn<OrganizationApi["decideSuggestion"]>(async (input) => ({ organizationVersion: 1, id: input.id, status: "revision_conflict", message: "版本刚更新，请核对", suggestion: null })) });
    await memory(user); await user.click(screen.getByRole("button", { name: "纠正" }));
    const field = screen.getByRole("textbox", { name: "启示（归纳，与观察分开）" });
    await user.clear(field); await user.type(field, "仅自动重试有效，网络切换仍未知");
    await user.click(screen.getByRole("button", { name: "保存纠正为新版本" }));
    expect(api.decideSuggestion).toHaveBeenCalledWith(expect.objectContaining({ expectedRevision: 1, expectedEvidenceVersion: 1, draft: { type: "experience", body: { inference: "仅自动重试有效，网络切换仍未知" } } }));
    expect(field).toHaveValue("仅自动重试有效，网络切换仍未知");
    expect(await screen.findByText("版本刚更新，请核对")).toBeVisible();
  });
  it("回退前遇到外部改动，先显示差异，确认携带差异哈希", async () => {
    const undo = vi.fn<OrganizationApi["undoSuggestion"]>(async (input) => ({ organizationVersion: 1, id: input.id, status: "needs_review", message: "请核对差异", diff: [{ target: "经验", field: "正文", current: "手动改动", restoreTo: "旧版本" }], diffHash: "a".repeat(64), suggestion: null }));
    const { user } = setup({ undoSuggestion: undo }); await memory(user);
    await user.click(screen.getByRole("button", { name: "回退" }));
    expect(await screen.findByText("手动改动")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "按这份差异恢复" }));
    expect(undo).toHaveBeenLastCalledWith({ id: "preview-org-exp", expectedRevision: 1, expectedDiffHash: "a".repeat(64) });
  });
  it("关闭前草稿存不上则保留界面和输入", async () => {
    const { onClose, user } = setup({ saveSuggestionDraft: vi.fn<OrganizationApi["saveSuggestionDraft"]>(async (input) => ({ organizationVersion: 1, id: input.id, status: "damaged", message: "无法保存草稿", suggestion: null })) });
    await memory(user); await user.click(screen.getByRole("button", { name: "纠正" }));
    await user.type(screen.getByRole("textbox", { name: "场景" }), "补充条件");
    await user.click(screen.getByRole("button", { name: "关闭整理" }));
    expect(onClose).not.toHaveBeenCalled();
    expect((screen.getByRole("textbox", { name: "场景" }) as HTMLTextAreaElement).value).toContain("补充条件");
  });
  it("首次配置明确选择模型、来源和预算，保存失败不会假装已开启", async () => {
    const { api, user } = setup({ setOrganizationSettings: vi.fn(async () => { throw new Error("保存失败"); }) }, "organization-setup");
    await user.click(await screen.findByRole("button", { name: "设置自动维护" }));
    expect(screen.getByRole("button", { name: "确认设置并开启" })).toBeDisabled();
    await user.selectOptions(screen.getByRole("combobox", { name: "维护模型" }), "p1");
    await user.click(screen.getByRole("checkbox", { name: "原则" }));
    await user.click(screen.getByRole("button", { name: "确认设置并开启" }));
    expect(api.setOrganizationSettings).toHaveBeenCalledWith(expect.objectContaining({ automatic: true, background: true, backgroundProfileId: "p1", maxCalls: 8, inputTokens: 12000 }));
    expect(await screen.findByText("保存失败")).toBeVisible();
    expect(screen.getByText("尚未开启自动维护")).toBeVisible();
  });
  it("损坏状态禁用写入，同时保留可阅读的内容", async () => {
    const { user } = setup({}, "organization-damaged");
    await memory(user); expect(screen.getByRole("button", { name: "纠正" })).toBeDisabled(); expect(screen.getByRole("button", { name: "回退" })).toBeDisabled();
  });
  it("页签支持方向键，设置页仍保留完整导航", async () => {
    const { user } = setup(); const tab = await screen.findByRole("tab", { name: "总览" }); tab.focus(); await user.keyboard("{End}");
    expect(screen.getByRole("tab", { name: "设置与状态" })).toHaveFocus();
    expect(screen.getAllByRole("tab")).toHaveLength(5);
    expect(await screen.findByText(/另有未报告用量的调用/u)).toHaveTextContent("估算");
  });
  it("暂停只关闭后台，不把未确认的来源或无效预算作为新的授权保存", async () => {
    const real = createOrganizationPreview(null).getOrganization;
    const save = vi.fn<OrganizationApi["setOrganizationSettings"]>(async (input) => input);
    const { user } = setup({ getOrganization: async (query) => ({ ...await real(query), settings: { background: true, backgroundProfileId: "p1" } }), setOrganizationSettings: save });
    await user.click(await screen.findByRole("tab", { name: "设置与状态" }));
    await user.clear(screen.getByRole("spinbutton", { name: "输入预算" }));
    await user.click(screen.getByRole("button", { name: "暂停自动维护" }));
    expect(save).toHaveBeenCalledWith({ background: false, backgroundProfileId: "p1" });
  });

});
