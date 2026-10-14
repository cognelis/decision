// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  PracticeAssetItem,
  PracticeAssetsApi,
} from "../src/shared/renderer-api.js";
import { PracticeAssetsView } from "../src/renderer/components/pages/methodology/PracticeAssetsView.js";
import { acceptedMethodologyFixture } from "./app-fixtures.js";

/**
 * A net under the second-largest component in the renderer.
 *
 * `PracticeAssetsView` is 1700 lines and, until now, nothing rendered it on
 * purpose — it was only reached sideways through App, which cannot put it in
 * the states that matter. These pin what a reader would notice first: the
 * empty case, that a draft is never presented as adopted, and that a stale
 * source says so on the row rather than only in the detail.
 */
const freshness = (
  state: PracticeAssetItem["freshness"]["state"] = "current",
): PracticeAssetItem["freshness"] => ({
  state,
  sourceCount: 1,
  updatedSourceCount: state === "sources_updated" ? 1 : 0,
  missingSourceCount: 0,
  unacceptedSourceCount: 0,
  latestSourceUpdatedAt: "2026-08-02T10:00:00.000Z",
  canRegenerate: state !== "sources_unavailable",
  message: "",
});

const asset = (
  overrides: Partial<PracticeAssetItem> = {},
): PracticeAssetItem => ({
  id: "asset-1",
  slug: "release-rollback-check",
  kind: "skill",
  status: "candidate",
  createdAt: "2026-08-01T10:00:00.000Z",
  updatedAt: "2026-08-02T10:00:00.000Z",
  acceptedAt: null,
  title: "发布前回滚检查",
  summary: "扩大发布范围前确认回滚入口与负责人。",
  trigger: "准备扩大发布范围时。",
  steps: ["确认回滚入口", "确认负责人"],
  checks: ["回滚入口可用"],
  fallback: "无法回滚时暂停发布。",
  sourcePrincipleIds: ["principle-1"],
  sourcePrinciples: [
    {
      id: "principle-1",
      updatedAt: "2026-08-02T10:00:00.000Z",
      status: "accepted",
      title: "先留回滚入口",
      principle: "不可逆的发布步骤要先有明确的回滚路径。",
      appliesWhen: "改动一旦上线就难以撤回时。",
      caution: "只影响本机的改动不适用。",
      confidence: "medium",
    },
  ],
  supersedesId: null,
  freshness: freshness(),
  sourceChanges: [],
  generation: {
    requestId: "practice:1",
    profileId: "builtin-qwen",
    provider: "Qwen 本地模型",
    model: "qwen3.5",
  },
  ...overrides,
});

/**
 * Unknown reads answer with an empty list; only the shapes this view
 * destructures are spelled out, because a wrong guess crashes the render and
 * the failure then reads as "element not in the document".
 */
const stubApi = (items: PracticeAssetItem[]): PracticeAssetsApi =>
  new Proxy({} as PracticeAssetsApi, {
    get: (_target, property: string) =>
      vi.fn(async () => {
        if (property === "listPracticeAssets") return items;
        if (property.startsWith("list") || property.startsWith("get")) return [];
        return undefined;
      }),
  });

const renderView = (items: PracticeAssetItem[] = []) => {
  const onOpenPrinciples = vi.fn();
  render(
    <PracticeAssetsView
      api={stubApi(items)}
      onOpenPrinciples={onOpenPrinciples}
    />,
  );
  return { onOpenPrinciples };
};

afterEach(cleanup);

describe("PracticeAssetsView", () => {
  it("offers both ways out of an empty workspace", async () => {
    const user = userEvent.setup();
    const { onOpenPrinciples } = renderView();

    const page = await screen.findByRole("region", { name: "技能与流程" });
    expect(within(page).getByText("没有待确认草案")).toBeVisible();

    await user.click(within(page).getByRole("button", { name: "查看原则" }));
    expect(onOpenPrinciples).toHaveBeenCalled();
  });

  it("reads the publication cards again after a publish fails, offering what the client now needs", async () => {
    const accepted = asset({ status: "accepted", acceptedAt: "2026-08-03T10:00:00.000Z" });
    let changedInClient = false;
    const codex = () => ({
      target: "codex" as const, targetLabel: "Codex", version: 1, publishedAt: "2026-08-04T10:00:00.000Z", canPublish: true, canRollback: true,
      ...(changedInClient
        ? { state: "occupied" as const, requiresOverwriteConfirmation: true, message: "客户端里的内容已被改动，覆盖前需要确认" }
        : { state: "update_available" as const, requiresOverwriteConfirmation: false, message: "Obsidian 中的内容已有更新" }),
    });
    const api = new Proxy({} as PracticeAssetsApi, {
      get: (_target, property: string) => vi.fn(async () => {
        if (property === "listPracticeAssets") return [accepted];
        if (property === "listPracticePublicationStatuses") return [codex()];
        if (property === "publishPracticeAsset") {
          // The client file was changed by hand after the card was read.
          changedInClient = true;
          throw new Error("目标已有内容，请确认覆盖后再发布");
        }
        if (property.startsWith("list") || property.startsWith("get")) return [];
        return undefined;
      }),
    });
    const user = userEvent.setup();
    render(<PracticeAssetsView api={api} onOpenPrinciples={vi.fn()} />);
    await user.click((await screen.findAllByRole("button", { name: "已采纳" }))[0]!);
    await user.click(await screen.findByRole("button", { name: /发布前回滚检查/u }));
    const dialog = within(await screen.findByRole("dialog", { name: "技能与流程详情" }));

    await user.click(await dialog.findByRole("button", { name: "更新" }));

    expect(await dialog.findByText(/发布操作失败：目标已有内容/u)).toBeVisible();
    // Left as it was read, the card offered only the update that had just failed, and no way to confirm.
    expect(await dialog.findByRole("button", { name: "处理冲突" })).toBeVisible();
  });

  it("offers the rollback of a copy still in a client for an asset no longer adopted", async () => {
    const dismissed = asset({ status: "dismissed", acceptedAt: null });
    const rollbackPracticeAssetPublication = vi.fn(async () => undefined);
    const api = new Proxy({} as PracticeAssetsApi, {
      get: (_target, property: string) => {
        if (property === "rollbackPracticeAssetPublication") return rollbackPracticeAssetPublication;
        return vi.fn(async () => {
          if (property === "listPracticeAssets") return [dismissed];
          if (property === "listPracticePublicationStatuses") {
            return [{
              target: "codex" as const, targetLabel: "Codex", version: 1, publishedAt: "2026-08-04T10:00:00.000Z",
              state: "up_to_date" as const, canPublish: false, canRollback: true, requiresOverwriteConfirmation: false,
              message: "这份资产已不是已采纳状态，不再发布；客户端里的副本可以回滚撤下",
            }];
          }
          if (property.startsWith("list") || property.startsWith("get")) return [];
          return undefined;
        });
      },
    });
    const user = userEvent.setup();
    render(<PracticeAssetsView api={api} onOpenPrinciples={vi.fn()} />);
    await user.click((await screen.findAllByRole("button", { name: "已忽略" }))[0]!);
    await user.click(await screen.findByRole("button", { name: /发布前回滚检查/u }));
    const dialog = within(await screen.findByRole("dialog", { name: "技能与流程详情" }));

    // Read and shown for adopted assets alone, the copy the main process lets go could not be reached from here.
    await user.click(await dialog.findByRole("button", { name: "回滚" }));
    await user.click(await dialog.findByRole("button", { name: "确认回滚" }));
    expect(rollbackPracticeAssetPublication).toHaveBeenCalledWith(dismissed.id, "codex");
  });

  it("keeps a manual draft open when it cannot be stored as it is left, and lets it go when left again", async () => {
    const principle = acceptedMethodologyFixture({ title: "先验证再扩大" });
    const save = vi.fn(async () => {
      throw new Error("ENOSPC: no space left on device");
    });
    const api = new Proxy({} as PracticeAssetsApi, {
      get: (_target, property: string) =>
        property === "saveManualFormDraft"
          ? save
          : vi.fn(async () => {
              if (property === "listMethodologies") return [principle];
              if (property.startsWith("list") || property.startsWith("get")) return [];
              return undefined;
            }),
    });
    const user = userEvent.setup();
    render(<PracticeAssetsView api={api} onOpenPrinciples={vi.fn()} />);
    const page = await screen.findByRole("region", { name: "技能与流程" });
    await user.click(within(page).getAllByRole("button", { name: "新建草案" })[0]!);
    const chooser = within(screen.getByRole("dialog", { name: "新建技能或工作流" }));
    await user.click(await chooser.findByRole("checkbox", { name: /先验证再扩大/u }));
    await user.click(chooser.getByRole("button", { name: "手动编写" }));
    const editor = within(screen.getByRole("dialog", { name: "人工编写技能草案" }));
    await user.type(editor.getByRole("textbox", { name: "简介" }), "扩大发布前先确认回滚入口");

    // The disk full, the draft could not be stored: left anyway, what was written in it was gone without a word.
    await user.click(editor.getByRole("button", { name: "返回选择" }));
    expect(await editor.findByText(/ENOSPC.*再关闭一次会放弃它/u)).toBeVisible();
    expect(editor.getByRole("textbox", { name: "简介" })).toHaveValue("扩大发布前先确认回滚入口");
    // Left again as it is, it goes, as it said it would.
    await user.click(editor.getByRole("button", { name: "返回选择" }));
    expect(await screen.findByRole("dialog", { name: "新建技能或工作流" })).toBeVisible();
  });

  it("never presents a draft as adopted", async () => {
    renderView([asset()]);

    const page = await screen.findByRole("region", { name: "技能与流程" });
    // A draft that reads as adopted is one a reader may publish to a client
    // without ever confirming it.
    const row = within(page).getByRole("button", { name: /发布前回滚检查/u });
    expect(row).toHaveTextContent("待确认");
    expect(row).not.toHaveTextContent("已采纳");
  });

  it("says on the row when a source principle has moved on", async () => {
    renderView([
      asset({ freshness: freshness("sources_updated") }),
    ]);

    const page = await screen.findByRole("region", { name: "技能与流程" });
    // Opening every row to find out which ones went stale is the work this
    // label exists to remove.
    expect(within(page).getByText("发布前回滚检查")).toBeVisible();
    expect(
      within(page).getByRole("button", { name: /发布前回滚检查/u }),
    ).toHaveTextContent("来源已更新");
  });

  it("lists what generating returned under its own status, not under 待确认 when it is adopted", async () => {
    const user = userEvent.setup();
    const principle = acceptedMethodologyFixture({ title: "先验证再扩大" });
    const adopted = asset({ status: "accepted", acceptedAt: "2026-08-03T10:00:00.000Z", sourcePrincipleIds: [principle.id] });
    const api = new Proxy({} as PracticeAssetsApi, {
      get: (_target, property: string) => vi.fn(async (status?: string) => {
        if (property === "generatePracticeAsset") return adopted;
        if (property === "listMethodologies") return [principle];
        if (property === "listPracticeAssets") return status === "candidate" ? [] : [adopted];
        if (property.startsWith("list") || property.startsWith("get")) return [];
        return undefined;
      }),
    });
    render(<PracticeAssetsView api={api} onOpenPrinciples={vi.fn()} />);
    const page = await screen.findByRole("region", { name: "技能与流程" });
    await user.click(within(page).getAllByRole("button", { name: "新建草案" })[0]!);
    const chooser = within(screen.getByRole("dialog", { name: "新建技能或工作流" }));
    await user.click(await chooser.findByRole("checkbox", { name: /先验证再扩大/u }));
    await user.click(chooser.getByRole("button", { name: "调用模型生成技能" }));

    // Switched to 待确认, the asset opened stood behind a list saying no draft waits.
    expect(within(page).getByRole("button", { name: "已采纳" })).toHaveAttribute("aria-pressed", "true");
  });

  it("says on the new draft that its unfinished form could not be cleared, and on that draft alone", async () => {
    const user = userEvent.setup();
    const principle = acceptedMethodologyFixture({ title: "先验证再扩大" });
    const other = asset({ id: "asset-other", title: "另一份草案" });
    const created = asset({ id: "asset-new", title: "手写技能", sourcePrincipleIds: [principle.id] });
    const api = new Proxy({} as PracticeAssetsApi, {
      get: (_target, property: string) => vi.fn(async () => {
        if (property === "deleteManualFormDraft") throw new Error("EACCES: permission denied");
        if (property === "createManualPracticeAsset") return created;
        if (property === "listMethodologies") return [principle];
        if (property === "listPracticeAssets") return [created, other];
        if (property === "saveManualFormDraft") return { key: "practice_asset_manual", updatedAt: "2026-08-08T10:00:00.000Z" };
        if (property.startsWith("list") || property.startsWith("get")) return [];
        return undefined;
      }),
    });
    render(<PracticeAssetsView api={api} onOpenPrinciples={vi.fn()} />);
    const page = await screen.findByRole("region", { name: "技能与流程" });
    await user.click(within(page).getAllByRole("button", { name: "新建草案" })[0]!);
    const chooser = within(screen.getByRole("dialog", { name: "新建技能或工作流" }));
    await user.click(await chooser.findByRole("checkbox", { name: /先验证再扩大/u }));
    await user.click(chooser.getByRole("button", { name: "手动编写" }));
    const editor = within(screen.getByRole("dialog", { name: "人工编写技能草案" }));
    await user.type(editor.getByRole("textbox", { name: "简介" }), "扩大发布前先确认回滚入口");
    await user.type(editor.getByRole("textbox", { name: /操作步骤/u }), "确认入口{Enter}确认负责人");
    await user.type(editor.getByRole("textbox", { name: /验收检查/u }), "入口可用");
    await user.click(editor.getByRole("button", { name: "保存为待确认草案" }));

    // Set, then cleared at once as the new draft became the one shown: the reader never heard the form was left.
    const detail = await screen.findByRole("dialog", { name: "审核技能与流程草案" });
    expect(await within(detail).findByText(/未完成表单未能清除：EACCES/u)).toBeVisible();

    // Another draft opened from the list does not show it as its own.
    await user.click(screen.getByRole("button", { name: "关闭审核技能与流程草案" }));
    await user.click(within(page).getByRole("button", { name: /另一份草案/u }));
    const second = await screen.findByRole("dialog", { name: "审核技能与流程草案" });
    expect(within(second).queryByText(/未完成表单未能清除/u)).toBeNull();
  });

  it("says a source-migration draft replaces the asset's content when adopted", async () => {
    const user = userEvent.setup();
    renderView([asset({ id: "asset-migration", supersedesId: "asset-0", migrationSourcePrincipleIds: ["principle-0"] })]);
    const page = await screen.findByRole("region", { name: "技能与流程" });
    await user.click(within(page).getByRole("button", { name: /发布前回滚检查/u }));
    const dialog = within(screen.getByRole("dialog", { name: "审核技能与流程草案" }));

    // Adopting it copies the draft's title, steps and checks over the asset's; it said the content stayed as it was.
    expect(dialog.getByText(/用这份草案的内容替换原资产的内容/u)).toBeVisible();
    expect(dialog.queryByText(/当前内容和客户端发布均保持不变/u)).toBeNull();
  });

  it("keeps Enter and spaces as they are typed into steps and checks, one item per line", async () => {
    const user = userEvent.setup();
    const revise = vi.fn(async () => asset());
    const api = new Proxy({} as PracticeAssetsApi, {
      get: (_target, property: string) =>
        property === "revisePracticeAsset"
          ? revise
          : vi.fn(async () => {
              if (property === "listPracticeAssets") return [asset()];
              if (property.startsWith("list") || property.startsWith("get")) return [];
              return undefined;
            }),
    });
    render(<PracticeAssetsView api={api} onOpenPrinciples={vi.fn()} />);
    const page = await screen.findByRole("region", { name: "技能与流程" });
    await user.click(within(page).getByRole("button", { name: /发布前回滚检查/u }));
    const dialog = within(screen.getByRole("dialog", { name: "审核技能与流程草案" }));
    await user.click(dialog.getByRole("button", { name: "编辑" }));

    // Typed key by key, as anyone does: tidied on every key, Enter and a trailing space vanished.
    await user.type(dialog.getByRole("textbox", { name: "操作步骤（每行一项，2–12 项）" }), "{End}{Enter}回滚演练");
    await user.type(dialog.getByRole("textbox", { name: "验收检查（每行一项，1–8 项）" }), "{End} 与 npm test 通过");
    await user.click(dialog.getByRole("button", { name: "保存修改" }));

    expect(revise).toHaveBeenCalledWith("asset-1", expect.objectContaining({
      steps: ["确认回滚入口", "确认负责人", "回滚演练"],
      checks: ["回滚入口可用 与 npm test 通过"],
    }), expect.any(String));
  });
});
