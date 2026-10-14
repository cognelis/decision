// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { MethodologyItem, MethodologyWorkspaceApi } from "../src/shared/renderer-api.js";
import { PageHidden } from "../src/renderer/components/ModalDialog.js";
import { MethodologyPanel } from "../src/renderer/components/pages/methodology/MethodologyPanel.js";
import { KnowledgeGraphView } from "../src/renderer/components/pages/methodology/KnowledgeGraphView.js";
import { DecisionAnalyticsView } from "../src/renderer/components/pages/methodology/DecisionAnalyticsView.js";
import { acceptedMethodologyFixture, apiFixture, methodologyQuality, rationaleSnapshot } from "./app-fixtures.js";

/**
 * A net under the largest component in the renderer.
 *
 * `MethodologyPanel` is 7000+ lines holding 120+ pieces of local state, and
 * until now nothing rendered it on purpose — it was only exercised sideways
 * through App. That is a poor position from which to change it, and the state
 * clusters inside it need to move somewhere smaller. These cases pin the
 * behaviour a reader would notice first, so a refactor that breaks it says so.
 */

/**
 * The workspace API is ~30 methods. Enumerating them all would make this file a
 * list of names rather than a test, so unknown reads answer with an empty list
 * and only the few whose shape the panel destructures are spelled out. Guessing
 * those shapes is what a stub cannot do: a wrong one crashes the render and the
 * failure reads as "element not in the document" rather than as a type error.
 */
const SHAPED_RESULTS: Record<string, unknown> = {
  getKnowledgeGraph: {
    decisions: [],
    projects: [],
    outcomes: [],
    principles: [],
    principleRelations: [],
  },
  getMethodologyBuildProgress: {
    decisions: { total: 0, reviewed: 0, pendingOutcome: 0, pendingReview: 0 },
    principles: { accepted: 0, candidate: 0 },
    practiceAssets: { accepted: 0, candidate: 0 },
  },
  // Only read once a record is selected, which nothing did until quick jump
  // could arrive on one.
  getMethodologyUsage: {
    principleId: "principle-1",
    linkedDecisionCount: 0,
    outcomeRecordedCount: 0,
    reviewedCount: 0,
    pendingOutcomeCount: 0,
    pendingReviewCount: 0,
    favorableCount: 0,
    mixedCount: 0,
    attentionCount: 0,
    unclearCount: 0,
    decisions: [],
    nextPendingDecision: null,
  },
};

const stubApi = (): MethodologyWorkspaceApi => {
  const calls = new Map<string, ReturnType<typeof vi.fn>>();
  return new Proxy({} as MethodologyWorkspaceApi, {
    get: (_target, property: string) => {
      const existing = calls.get(property);
      if (existing !== undefined) return existing;
      const method = vi.fn(async () => {
        if (property in SHAPED_RESULTS) return SHAPED_RESULTS[property];
        if (property.startsWith("list") || property.startsWith("get")) {
          return [];
        }
        return undefined;
      });
      calls.set(property, method);
      return method;
    },
  });
};

const renderPanel = () => {
  const api = stubApi();
  const onOpenDecision = vi.fn();
  render(
    <MethodologyPanel
      api={api}
      onOpenDecision={onOpenDecision}
      onBrowseDecisions={vi.fn()}
    />,
  );
  return { api, onOpenDecision };
};


afterEach(cleanup);

describe("MethodologyPanel", () => {
  it("renders its workspace without the API answering anything useful", async () => {
    renderPanel();

    // An empty vault is the first thing a new reader sees; it must not crash.
    await screen.findByRole("tablist", { name: "方法论视图" });
    // Re-queried rather than held: the panel replaces nodes as its loads
    // settle, and a reference taken before that is a detached one.
    expect(screen.getByRole("region", { name: "方法论" })).toBeInTheDocument();
    expect(screen.getByRole("tablist", { name: "方法论视图" })).toBeVisible();
  });

  it("reads a principle's use again when the page is shown again, keeping the filter the reader set", async () => {
    const api = stubApi();
    const principle = acceptedMethodologyFixture();
    vi.mocked(api.listMethodologies).mockResolvedValue([principle]);
    vi.mocked(api.getMethodologyUsage).mockResolvedValue({
      ...(SHAPED_RESULTS.getMethodologyUsage as object),
      principleId: principle.id,
      linkedDecisionCount: 1,
      outcomeRecordedCount: 1,
      reviewedCount: 1,
      attentionCount: 1,
      decisions: [{
        id: "decision-1", created: "2026-08-03T10:00:00.000Z", project: "decision", question: "缓存层放在哪一侧？",
        selectedAnswer: "读取端", outcome: "命中率 80%",
        outcomeReview: { verdict: "worse", lesson: "写入端失效太慢", reviewedAt: "2026-08-10T10:00:00.000Z" },
      }],
    } as never);
    const panel = (hidden: boolean) => (
      <PageHidden.Provider value={hidden}>
        <MethodologyPanel api={api} onOpenDecision={vi.fn()} onBrowseDecisions={vi.fn()} />
      </PageHidden.Provider>
    );
    const user = userEvent.setup();
    const view = render(panel(false));
    await user.click(await screen.findByText(principle.title));
    await user.click(await screen.findByRole("button", { name: /需关注/u }));

    // Away and back: what was done meanwhile is read again, and the page is not set back to 全部.
    view.rerender(panel(true));
    view.rerender(panel(false));
    await waitFor(() => expect(api.getMethodologyUsage).toHaveBeenCalledTimes(2));
    expect(await screen.findByRole("button", { name: /需关注/u })).toHaveAttribute("aria-pressed", "true");
  });

  it("offers every view of the workspace", async () => {
    renderPanel();
    const views = within(
      await screen.findByRole("tablist", { name: "方法论视图" }),
    ).getAllByRole("tab");

    expect(views.length).toBeGreaterThanOrEqual(4);
    // Exactly one tab is current at a time; two would mean the tablist and the
    // rendered panel can disagree about what the reader is looking at.
    expect(
      views.filter((view) => view.getAttribute("aria-selected") === "true"),
    ).toHaveLength(1);
  });

  it("keeps one view selected after switching", async () => {
    const user = userEvent.setup();
    renderPanel();
    await screen.findByRole("tablist", { name: "方法论视图" });
    // The graph view states its own empty case; the analysis view wants a
    // shaped payload that this stub deliberately does not guess at.
    const target = screen.getByRole("tab", { name: "图谱" });
    const label = target.textContent;

    await user.click(target);

    const after = within(
      screen.getByRole("tablist", { name: "方法论视图" }),
    ).getAllByRole("tab");
    const selected = after.filter(
      (view) => view.getAttribute("aria-selected") === "true",
    );
    expect(selected).toHaveLength(1);
    expect(selected[0]?.textContent).toBe(label);
  });

  it("names what the header counts after the status shown", async () => {
    const user = userEvent.setup();
    renderPanel();
    const header = (await screen.findByRole("heading", { name: "方法论", level: 1 })).closest("header")!;

    expect(header).toHaveTextContent("待确认原则");
    await user.click(within(screen.getByRole("group", { name: "方法论状态" })).getByRole("button", { name: "全部" }));
    expect(header).toHaveTextContent("全部原则");
  });

  it("asks the workspace for its records on mount", async () => {
    const { api } = renderPanel();

    await screen.findByRole("region", { name: "方法论" });

    expect(api.listMethodologies).toHaveBeenCalled();
  });

  it("opens the principle quick jump asked for, whatever tab was showing", async () => {
    const api = stubApi();
    const accepted = acceptedMethodologyFixture({
      id: "principle-1",
      title: "先验证边界再扩大投入",
    });
    vi.mocked(api.listMethodologies).mockResolvedValue([accepted]);
    const consumed = vi.fn();

    render(
      <MethodologyPanel
        api={api}
        initialPrincipleId="principle-1"
        onOpenDecision={vi.fn()}
        onBrowseDecisions={vi.fn()}
        onInitialNavigationConsumed={consumed}
      />,
    );

    expect(
      await screen.findByRole("heading", {
        level: 3,
        name: "先验证边界再扩大投入",
      }),
    ).toBeVisible();
    // The panel opens on 待确认; an accepted principle would be absent from
    // that list, so the arriving record has to move the filter itself.
    expect(screen.getByRole("button", { name: "已采纳" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await waitFor(() => expect(consumed).toHaveBeenCalled());
  });

  it("opens the quick jump once its read lands, however often the app re-renders meanwhile", async () => {
    const api = stubApi();
    const accepted = acceptedMethodologyFixture({ id: "principle-1", title: "先验证边界再扩大投入" });
    const pending: Array<(records: MethodologyItem[]) => void> = [];
    vi.mocked(api.listMethodologies).mockImplementation((status?: string) =>
      status === undefined ? new Promise<MethodologyItem[]>((resolve) => pending.push(resolve)) : Promise.resolve([]));
    // As App passes it: a new function on every render of the app, each snapshot it pushes.
    const panel = () => (
      <MethodologyPanel api={api} initialPrincipleId="principle-1" onInitialNavigationConsumed={() => undefined}
        onOpenDecision={vi.fn()} onBrowseDecisions={vi.fn()} />
    );
    const view = render(panel());
    await act(async () => {});
    const jumpReads = () => vi.mocked(api.listMethodologies).mock.calls.filter(([status]) => status === undefined).length;
    const afterMount = jumpReads();
    for (let push = 0; push < 3; push += 1) {
      view.rerender(panel());
      await act(async () => {});
    }

    // Each push dropped the read under way and began another, and the record never opened.
    expect(jumpReads()).toBe(afterMount);
    await act(async () => { for (const resolve of pending) resolve([accepted]); });
    expect(await screen.findByRole("heading", { level: 3, name: "先验证边界再扩大投入" })).toBeVisible();
  });

  it("hands focus to the row that takes an ignored candidate's place, not to the page", async () => {
    const api = stubApi();
    const candidate = (id: string, title: string) =>
      acceptedMethodologyFixture({ id, title, status: "candidate", confirmedAt: null });
    let ignored = false;
    vi.mocked(api.listMethodologies).mockImplementation(async () =>
      [candidate("c-1", "候选一"), candidate("c-2", "候选二")].filter((item) => !(ignored && item.id === "c-1")),
    );
    vi.mocked(api.setMethodologyStatus).mockImplementation(async () => {
      ignored = true;
      return { ...candidate("c-1", "候选一"), status: "dismissed" };
    });
    const user = userEvent.setup();
    render(<MethodologyPanel api={api} onOpenDecision={vi.fn()} onBrowseDecisions={vi.fn()} />);

    (await screen.findByRole("button", { name: /候选一/u })).focus();
    await user.keyboard("{Enter}");
    const dialog = within(await screen.findByRole("dialog", { name: "审核方法论候选" }));
    dialog.getByRole("button", { name: "忽略" }).focus();
    await user.keyboard("{Enter}");

    await waitFor(() => expect(screen.getByRole("button", { name: /候选二/u })).toHaveFocus());
  });

  it("does not show one record's failure in another opened from elsewhere", async () => {
    const api = stubApi();
    const candidate = (id: string, title: string) =>
      acceptedMethodologyFixture({ id, title, status: "candidate", confirmedAt: null, quality: methodologyQuality({ relations: [], flags: [] }) });
    vi.mocked(api.listMethodologies).mockResolvedValue([candidate("c-1", "候选一"), candidate("c-2", "候选二")]);
    vi.mocked(api.setMethodologyStatus).mockRejectedValue(new Error("候选原则的来源证据不完整，不能采纳。"));
    const user = userEvent.setup();
    const view = render(<MethodologyPanel api={api} onOpenDecision={vi.fn()} onBrowseDecisions={vi.fn()} />);
    await user.click(await screen.findByRole("button", { name: /候选一/u }));
    const first = await screen.findByRole("dialog", { name: "审核方法论候选" });
    await user.click(within(first).getByRole("button", { name: "采纳原则" }));
    expect(await within(first).findByRole("alert")).toHaveTextContent("来源证据不完整");
    await user.keyboard("{Escape}");

    // Quick jump arrives on the other one.
    view.rerender(<MethodologyPanel api={api} initialPrincipleId="c-2" onOpenDecision={vi.fn()} onBrowseDecisions={vi.fn()} />);

    const second = await screen.findByRole("dialog", { name: "审核方法论候选" });
    expect(await within(second).findByRole("heading", { level: 3, name: "候选二" })).toBeVisible();
    expect(within(second).queryByRole("alert")).toBeNull();
  });

  it("says in the graph why a merge or a principle it opens did not come through", async () => {
    const api = stubApi();
    const node = (id: string, title: string) => ({
      id, title, principle: `${title} 的正文`, confidence: "low" as const, confirmedAt: "2026-08-02T10:00:00.000Z", sourceDecisionIds: [], projectIds: [],
    });
    vi.mocked(api.getKnowledgeGraph).mockResolvedValue({
      projects: [], decisions: [], outcomes: [], edges: [], missingSourceDecisionIds: [],
      principles: [node("p1", "人工原则一"), node("p2", "人工原则二")],
      principleRelations: [{ id: "rel-1", sourcePrincipleId: "p1", targetPrincipleId: "p2", disposition: "duplicate", note: null, updatedAt: "2026-08-03T10:00:00.000Z" }],
    });
    // Two principles adopted as hypotheses, with no reviewed evidence to merge from.
    const manual = (id: string, title: string) =>
      acceptedMethodologyFixture({ id, title, origin: "manual_entry", sourceDecisionIds: [], sourceDecisions: [], quality: methodologyQuality({ evidenceCount: 0, relations: [] }) });
    vi.mocked(api.listMethodologies).mockResolvedValue([manual("p1", "人工原则一"), manual("p2", "人工原则二")]);
    const user = userEvent.setup();
    render(<MethodologyPanel api={api} initialView="graph" onOpenDecision={vi.fn()} onBrowseDecisions={vi.fn()} />);

    await user.click(await screen.findByRole("button", { name: /确认重复/u }));
    await user.click(screen.getByRole("button", { name: "建立合并草案" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("无法建立合并草案");
    await user.click(screen.getByRole("button", { name: "关闭" }));

    // Gone from the vault since the graph was read.
    vi.mocked(api.listMethodologies).mockResolvedValue([]);
    const cluster = screen.getByText("人工原则一").closest("li")!;
    await user.click(within(cluster).getByRole("button", { name: "查看详情" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("关联原则已不存在");
  });

  it("words a principle in the graph by the decisions behind it, not 单点证据 for none or for three", () => {
    const node = (id: string, confidence: "low" | "medium" | "high", sourceDecisionIds: string[]) => ({
      id, title: `原则 ${id}`, principle: "先验证关键边界。", confidence, confirmedAt: "2026-08-02T10:00:00.000Z", sourceDecisionIds, projectIds: [],
    });
    render(<KnowledgeGraphView
      graph={{ projects: [], decisions: [], outcomes: [], edges: [], missingSourceDecisionIds: [], principleRelations: [], principles: [
        node("none", "low", []), node("one", "high", ["d1"]), node("three", "low", ["d1", "d2", "d3"]), node("two", "medium", ["d1", "d2"]),
      ] }}
      loading={false} error={null} mergeLoading={false} onOpenPrinciples={vi.fn()} onOpenPrinciple={vi.fn()} onMergePrinciples={vi.fn()}
    />);

    const badge = (id: string) => within(screen.getByText(`原则 ${id}`).closest("header")!).getByText(/待验证|单点证据|多条印证|稳定模式|低可信/u);
    expect(["none", "one", "three", "two"].map((id) => badge(id).textContent)).toEqual(["待验证", "单点证据", "低可信", "多条印证"]);
  });

  it("words a principle in the list by the evidence behind it too, not 单点证据 for three at low confidence", async () => {
    const api = stubApi();
    const low = (id: string, evidenceCount: number) =>
      acceptedMethodologyFixture({ id, title: `原则 ${id}`, confidence: "low", quality: methodologyQuality({ recommendedConfidence: "low", evidenceCount }) });
    vi.mocked(api.listMethodologies).mockResolvedValue([low("one", 1), low("three", 3)]);
    const user = userEvent.setup();
    render(<MethodologyPanel api={api} onOpenDecision={vi.fn()} onBrowseDecisions={vi.fn()} />);
    await user.click(await screen.findByRole("button", { name: "已采纳" }));

    // The same principle read 单点证据 here, 低可信 in the graph and in consult_decision_principles.
    const badge = (id: string) => within(screen.getByText(`原则 ${id}`, { selector: "strong" }).closest("li")!).getByText(/待验证|单点证据|多条印证|稳定模式|低可信/u);
    expect([badge("one").textContent, badge("three").textContent]).toEqual(["单点证据", "低可信"]);
  });

  it("offers no evidence linking on a dismissed principle, which the service refuses at the end of the chooser", async () => {
    const api = stubApi();
    const manual = (id: string, status: "candidate" | "dismissed") => acceptedMethodologyFixture({
      id, title: `原则 ${id}`, origin: "manual_entry", status, sourceDecisionIds: [], sourceDecisions: [],
      quality: methodologyQuality({ evidenceCount: 0, relations: [] }),
    });
    vi.mocked(api.listMethodologies).mockResolvedValue([manual("open", "candidate"), manual("dropped", "dismissed")]);
    const user = userEvent.setup();
    render(<MethodologyPanel api={api} onOpenDecision={vi.fn()} onBrowseDecisions={vi.fn()} />);

    await user.click(await screen.findByRole("button", { name: "已忽略" }));
    await user.click(await screen.findByRole("button", { name: /原则 dropped/u }));
    const dropped = within(await screen.findByRole("dialog", { name: "方法论详情" }));
    // Offered, the chooser took the reader through picking decisions to 「已归档或已忽略的原则不能调整关联证据」.
    expect(dropped.queryByRole("button", { name: "关联复盘证据" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "关闭方法论详情" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "方法论详情" })).toBeNull());

    await user.click(screen.getByRole("button", { name: "待确认" }));
    await user.click(await screen.findByRole("button", { name: /原则 open/u }));
    expect(within(await screen.findByRole("dialog", { name: "审核方法论候选" })).getByRole("button", { name: "关联复盘证据" })).toBeVisible();
  });

  it("reads the review material again when setting a group aside finds it changed", async () => {
    const api = stubApi();
    const stale = {
      id: "suggestion:stale", title: "过期的证据组合", summary: "两条复盘", readiness: "ready" as const, direction: "favorable" as const,
      evidenceCount: 2, projectCount: 1, sourceDecisionIds: ["d1", "d2"], sources: [],
    };
    vi.mocked(api.getMethodologySuggestions).mockResolvedValueOnce([stale]).mockResolvedValue([]);
    vi.mocked(api.deferMethodologySuggestion).mockRejectedValue(new Error("这组复盘素材已变化，请刷新后再操作。"));
    const user = userEvent.setup();
    render(<MethodologyPanel api={api} onOpenDecision={vi.fn()} onBrowseDecisions={vi.fn()} />);
    await user.click(await screen.findByRole("button", { name: "管理素材" }));
    const inbox = await screen.findByRole("dialog", { name: "复盘素材" });

    await user.click(within(inbox).getByRole("button", { name: "稍后再看" }));

    // Left as it was, the changed group could only be tried again, and failed again.
    await waitFor(() => expect(api.getMethodologySuggestions).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByText("过期的证据组合")).toBeNull());
  });

  it("promises the batch it generates, and says how many groups wait for the next", async () => {
    const api = stubApi();
    vi.mocked(api.getMethodologySuggestions).mockResolvedValue(Array.from({ length: 8 }, (_, index) => ({
      id: `suggestion:${index}`, title: `证据组合 ${index}`, summary: "两条复盘", readiness: "ready" as const, direction: "favorable" as const,
      evidenceCount: 2, projectCount: 1, sourceDecisionIds: [`d${index}a`, `d${index}b`], sources: [],
    })));
    const user = userEvent.setup();
    render(<MethodologyPanel api={api} onOpenDecision={vi.fn()} onBrowseDecisions={vi.fn()} />);
    await user.click(await screen.findByRole("button", { name: "批量生成" }));
    const dialog = await screen.findByRole("dialog", { name: "批量提炼方法论" });

    // It promised all eight and generated six, the notice silent on the two left out.
    expect(dialog).toHaveTextContent("6 组复盘建议将依次生成候选，其余 2 组留到下一批。");
    await user.click(within(dialog).getByRole("button", { name: "生成 6 条候选" }));
    expect(await screen.findByText("已生成 6 条候选，等待逐条审核。还有 2 组可以再批量生成。")).toBeVisible();
    expect(api.generateMethodology).toHaveBeenCalledTimes(6);
  });

  it("says of an import with nothing new both the duplicates skipped and the files not read", async () => {
    const api = stubApi();
    vi.mocked(api.importMethodologyMarkdown).mockResolvedValue({
      cancelled: false, batchId: null, candidates: [],
      duplicates: [{ fileName: "a.md", title: "缓存放在读取端", existingTitle: "缓存放在读取端" }],
      failures: [
        { fileName: "b.md", message: "文件不是 UTF-8 编码。" },
        { fileName: "c.md", message: "文件超过 512 KiB 限制。" },
        { fileName: "d.md", message: "只支持普通文件。" },
        { fileName: "e.md", message: "只支持普通文件。" },
      ],
    });
    const user = userEvent.setup();
    render(<MethodologyPanel api={api} onOpenDecision={vi.fn()} onBrowseDecisions={vi.fn()} />);
    await user.click((await screen.findAllByRole("button", { name: "新建原则" }))[0]!);
    await user.click(within(await screen.findByRole("dialog", { name: "新建原则" })).getByRole("button", { name: /导入 Markdown/u }));

    // The duplicate alone was spoken of; the four files that could not be read went unmentioned.
    expect(await screen.findByText(
      "没有新增候选；已识别并跳过 1 条重复内容；4 个文件没能导入：b.md（文件不是 UTF-8 编码）、c.md（文件超过 512 KiB 限制）、d.md（只支持普通文件）等。",
    )).toBeVisible();
  });

  it("keeps the count while the principles are read again, rather than flicker to reading", async () => {
    const api = stubApi();
    const candidate = (id: string, title: string) =>
      acceptedMethodologyFixture({ id, title, status: "candidate", confirmedAt: null });
    // After the first read, every read again stays pending: the page is caught mid-refresh.
    let hold = false;
    vi.mocked(api.listMethodologies).mockImplementation(async () => {
      if (hold) await new Promise<never>(() => undefined);
      return [candidate("c-1", "候选一"), candidate("c-2", "候选二")];
    });
    vi.mocked(api.setMethodologyStatus).mockImplementation(async () => ({ ...candidate("c-1", "候选一"), status: "dismissed" }));
    const user = userEvent.setup();
    render(<MethodologyPanel api={api} onOpenDecision={vi.fn()} onBrowseDecisions={vi.fn()} />);

    await user.click(await screen.findByRole("button", { name: /候选一/u }));
    hold = true;
    await user.click(within(await screen.findByRole("dialog", { name: "审核方法论候选" })).getByRole("button", { name: "忽略" }));
    await waitFor(() => expect(api.setMethodologyStatus).toHaveBeenCalled());

    expect(await screen.findByText("2 条")).toBeVisible();
    expect(screen.queryByText("正在读取…")).toBeNull();
  });

  it("counts the relations to check as the queue holds them, whatever tab shows, and after each one saved", async () => {
    const api = stubApi();
    // One conclusion per pair, seen from both sides on the next read, as the relation store keeps it.
    const concluded = new Set<string>();
    const pair = (a: string, b: string) => [a, b].sort().join("|");
    const principle = (id: string, title: string, status: "accepted" | "candidate") =>
      acceptedMethodologyFixture({ id, title, status, ...(status === "candidate" ? { confirmedAt: null } : {}) });
    const partner: Record<string, string> = { "p-x": "p-y", "p-y": "p-x", "p-z": "p-w", "p-w": "p-z" };
    const records = (): MethodologyItem[] => {
      const all = [
        // Two adopted principles in conflict: not on the 待确认 tab the page opens on.
        principle("p-x", "一次性重构", "accepted"),
        principle("p-y", "分步重构", "accepted"),
        principle("p-z", "统一入口", "candidate"),
        principle("p-w", "拆分入口", "candidate"),
      ];
      return all.map((item) => {
        const other = all.find((candidate) => candidate.id === partner[item.id])!;
        return {
          ...item,
          quality: methodologyQuality({
            relations: [{
              id: other.id, title: other.title, status: other.status, kind: "potential_conflict", score: 40,
              sharedEvidenceCount: 0, reason: "行动信号相反。",
              resolution: concluded.has(pair(item.id, other.id)) ? "conflict" : null,
              resolutionNote: null, resolutionUpdatedAt: null,
            }],
          }),
        };
      });
    };
    vi.mocked(api.listMethodologies).mockImplementation(async (status) =>
      records().filter((item) => status === undefined || item.status === status),
    );
    vi.mocked(api.setMethodologyRelation).mockImplementation(async (id, relatedId) => {
      concluded.add(pair(id, relatedId));
      return records().find((item) => item.id === id)!;
    });
    const user = userEvent.setup();
    render(<MethodologyPanel api={api} onOpenDecision={vi.fn()} onBrowseDecisions={vi.fn()} />);

    await user.click(await screen.findByRole("button", { name: "方法论工作箱 2" }));
    await user.click(within(screen.getByRole("dialog", { name: "方法论工作箱" })).getByRole("button", { name: "关系核对 2" }));
    const queue = within(await screen.findByRole("dialog", { name: "批量核对原则关系" }));
    await user.click(queue.getByRole("radio", { name: /冲突/u }));
    await user.click(queue.getByRole("button", { name: "保存并继续" }));
    await waitFor(() => expect(api.setMethodologyRelation).toHaveBeenCalledTimes(1));
    await user.click(within(await screen.findByRole("dialog", { name: "批量核对原则关系" })).getByRole("button", { name: "稍后处理" }));

    await waitFor(() => expect(screen.getByRole("button", { name: /^方法论工作箱/u })).toHaveAccessibleName("方法论工作箱 1"));
  });

  it("leaves the principle the reader opened while one opened from the graph was still being read", async () => {
    const api = stubApi();
    const a = acceptedMethodologyFixture({ id: "principle-a", title: "原则甲：先验证" });
    const b = acceptedMethodologyFixture({ id: "principle-b", title: "原则乙：小步走" });
    let release: (records: MethodologyItem[]) => void = () => undefined;
    let holding = false;
    vi.mocked(api.listMethodologies).mockImplementation((status?: string) => {
      // The graph's own read for the principle it opens: held back.
      if (holding && status === undefined) {
        holding = false;
        return new Promise<MethodologyItem[]>((resolve) => { release = resolve; });
      }
      return Promise.resolve(status === undefined || status === "accepted" ? [a, b] : []);
    });
    vi.mocked(api.getKnowledgeGraph).mockResolvedValue({
      projects: [], decisions: [], outcomes: [], principleRelations: [], edges: [], missingSourceDecisionIds: [],
      principles: [{ id: a.id, title: a.title, principle: a.principle, confidence: "medium", confirmedAt: "2026-08-03T10:00:00.000Z", sourceDecisionIds: [], projectIds: [] }],
    } as never);
    const user = userEvent.setup();
    render(<MethodologyPanel api={api} initialView="graph" onOpenDecision={vi.fn()} onBrowseDecisions={vi.fn()} />);

    holding = true;
    await user.click(await screen.findByRole("button", { name: "查看详情" }));
    // The list is there before that read answers: the reader opens 原则乙 themselves.
    await user.click(await screen.findByText(b.title));
    expect(within(await screen.findByRole("dialog")).getAllByText(b.title).length).toBeGreaterThan(0);

    // Landing now, the graph's read put 原则甲 in the dialog the reader had opened on 原则乙.
    release([a, b]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const dialog = within(screen.getByRole("dialog"));
    expect(dialog.getAllByText(b.title).length).toBeGreaterThan(0);
    expect(dialog.queryAllByText(a.title)).toHaveLength(0);
  });

  it("shows the latest analysis read, not an older 重试 that answered last", async () => {
    const { api } = apiFixture(rationaleSnapshot());
    const empty = await api.getDecisionAnalytics();
    const answers: Array<{ resolve: (value: unknown) => void; reject: (error: unknown) => void }> = [];
    vi.mocked(api.getDecisionAnalytics).mockImplementation(() => new Promise((resolve, reject) => answers.push({ resolve, reject })) as never);
    const user = userEvent.setup();
    render(<DecisionAnalyticsView api={api} onOpenDecisions={vi.fn()} onOpenDecision={vi.fn()}
      onBrowseDecisions={vi.fn()} onOpenPrinciple={vi.fn()} onOpenReviews={vi.fn()} />);
    await act(async () => { answers[0]!.reject(new Error("索引忙")); });
    const retry = await screen.findByRole("button", { name: "重试" });

    // Pressed twice: the second read answers first, the first one after it.
    await user.click(retry);
    await user.click(retry);
    await act(async () => { answers[2]!.resolve(empty); });
    expect(await screen.findByText("还没有可分析的决策")).toBeVisible();
    await act(async () => { answers[1]!.reject(new Error("索引忙")); });

    // Taken, the older failure replaced the newer answer.
    expect(screen.getByText("还没有可分析的决策")).toBeVisible();
    expect(screen.queryByText("决策分析暂时不可用")).toBeNull();
  });

  it("reports arrival even when the id no longer exists", async () => {
    const api = stubApi();
    const consumed = vi.fn();

    render(
      <MethodologyPanel
        api={api}
        initialPrincipleId="principle-gone"
        onOpenDecision={vi.fn()}
        onBrowseDecisions={vi.fn()}
        onInitialNavigationConsumed={consumed}
      />,
    );

    // Without this the id stays pending and every later render refetches it.
    await waitFor(() => expect(consumed).toHaveBeenCalled());
    await screen.findByRole("region", { name: "方法论" });
  });
});
