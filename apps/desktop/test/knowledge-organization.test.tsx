// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DecisionDeletionDialog } from "../src/renderer/components/pages/decisions/DecisionDeletionDialog.js";
import { DecisionLibraryPanel } from "../src/renderer/components/pages/decisions/DecisionLibraryPanel.js";
import { createOrganizationPreview } from "../src/renderer/preview-organization.js";
import { apiFixture, rationaleSnapshot } from "./app-fixtures.js";

afterEach(cleanup);

/** 知识页进入同一个整理面板：范围只来自知识页选定的项目；没选项目就先选，不替用户混合。 */
describe("知识页的整理入口", () => {
  const setup = () => {
    const { api } = apiFixture(rationaleSnapshot());
    vi.mocked(api.listDecisionProjects).mockResolvedValue([{ project: "消息服务（示例）", count: 3 }, { project: "网关", count: 2 }]);
    const preview = createOrganizationPreview(null);
    const organizationApi = Object.assign(api, {
      getOrganization: vi.fn(preview.getOrganization),
      runOrganization: vi.fn(preview.runOrganization),
      controlOrganizationRun: vi.fn(preview.controlOrganizationRun),
      decideSuggestion: vi.fn(preview.decideSuggestion),
      adoptSuggestions: vi.fn(preview.adoptSuggestions),
      saveSuggestionDraft: vi.fn(preview.saveSuggestionDraft),
      undoSuggestion: vi.fn(preview.undoSuggestion),
      regenerateSuggestion: vi.fn(preview.regenerateSuggestion),
      setOrganizationSettings: vi.fn(preview.setOrganizationSettings),
      listModelProviderProfiles: vi.fn(async () => []),
    });
    render(<DecisionLibraryPanel api={organizationApi} totalDecisions={5} initialProject="消息服务（示例）" organization={{ revision: 0, pending: 8 }} onOpenPrinciple={vi.fn()} onDistillDecision={vi.fn()} onRecorded={vi.fn()} />);
    return { api: organizationApi, user: userEvent.setup() };
  };

  it("入口徽标取服务端总量，打开后按所选项目整理，没有清单/勾选范围", async () => {
    const { api, user } = setup();
    const entry = await screen.findByRole("button", { name: /^整理/u });
    expect(entry).toHaveTextContent("8");
    await user.click(entry);
    const dialog = within(await screen.findByRole("dialog", { name: "整理与记忆" }));
    await dialog.findByRole("tab", { name: /总览/u });
    expect(api.getOrganization).toHaveBeenCalledWith({ project: null, scope: "all" });
    const scope = dialog.getByRole("combobox", { name: "范围" });
    expect(within(scope).getAllByRole("option")).toHaveLength(1);
  });

  it("换一个项目就换范围：新快照到之前，旧项目的建议不显示也不能操作", async () => {
    const { api, user } = setup();
    await user.click(await screen.findByRole("button", { name: /^整理/u }));
    const dialog = within(await screen.findByRole("dialog", { name: "整理与记忆" }));
    await dialog.findByRole("tab", { name: "待处理" });
    await user.click(dialog.getByRole("tab", { name: "待处理" }));
    let release: () => void = () => undefined;
    const real = createOrganizationPreview(null).getOrganization;
    vi.mocked(api.getOrganization).mockImplementation(async (query) => { await new Promise<void>((resolve) => { release = resolve; }); return real(query); });
    await user.selectOptions(dialog.getByRole("combobox", { name: "项目" }), "网关");
    await waitFor(() => expect(api.getOrganization).toHaveBeenCalledWith({ project: "网关", scope: "project" }));
    expect(dialog.queryByRole("button", { name: /3 条事项都在说/u })).toBeNull();
    expect(dialog.queryByRole("button", { name: /^采纳/u })).toBeNull();
    release();
    expect(await dialog.findByRole("button", { name: /3 条事项都在说/u })).toBeVisible();
  });
});

describe("删除决策时的整理联动", () => {
  const target = { id: "d1", storage: "vault" as const };
  const base = { ...target, question: "删除哪条？", contentHash: "b".repeat(64), evidencePrinciples: 0, adoptedPrinciples: 0, relations: 0, batchId: null, captured: false, deferredHeld: false, selectedAnswer: "甲", project: "p" };
  const hash = "d".repeat(64);

  it("列出会一并删除的经验、清除的建议与调用记录，确认时带回看过的哈希", async () => {
    const { api } = apiFixture(rationaleSnapshot());
    vi.mocked(api.previewDecisionDeletion).mockResolvedValue({ ...base, organization: { experiences: [{ id: "e1", title: "修复重复发送后在指定场景验证" }], suggestions: 2, modelCalls: 3, complete: true, previewHash: hash } });
    const user = userEvent.setup();
    render(<DecisionDeletionDialog api={api} target={target} onClose={vi.fn()} onDeleted={vi.fn()} />);
    expect(await screen.findByText("修复重复发送后在指定场景验证")).toBeVisible();
    expect(screen.getByText(/整理建议 2 条/u)).toBeVisible();
    expect(screen.getByText(/模型调用记录 3 条/u)).toBeVisible();
    await user.click(screen.getByRole("button", { name: "删除" }));
    expect(api.deleteDecision).toHaveBeenCalledWith({ ...target, expectedContentHash: base.contentHash, expectedOrganizationPreviewHash: hash });
  });

  it("预览不全时不能确认，并说明", async () => {
    const { api } = apiFixture(rationaleSnapshot());
    vi.mocked(api.previewDecisionDeletion).mockResolvedValue({ ...base, organization: { experiences: [], suggestions: 0, modelCalls: 0, complete: false, previewHash: hash } });
    render(<DecisionDeletionDialog api={api} target={target} onClose={vi.fn()} onDeleted={vi.fn()} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("暂不能确认删除");
    expect(screen.getByRole("button", { name: "删除" })).toBeDisabled();
  });
});
