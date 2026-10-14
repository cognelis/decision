// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type {
  DecisionApi,
  ObsidianSearchResponse,
  ObsidianSearchStatus,
} from "../src/shared/renderer-api.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useState } from "react";

import {
  VaultNoteResults,
  type ObsidianSearchApi,
} from "../src/renderer/components/pages/decisions/VaultNoteResults.js";
import {
  INDEXING_STATUS_REFRESH_MS,
  STABLE_STATUS_REFRESH_MS,
} from "../src/renderer/components/pages/decisions/useObsidianSearchStatus.js";
import { createPreviewApi } from "../src/renderer/preview-api.js";
import { PageHidden } from "../src/renderer/components/ModalDialog.js";

const status = (
  overrides: Partial<ObsidianSearchStatus> = {},
): ObsidianSearchStatus => ({
  state: "idle",
  discoveredNotes: 0,
  indexedNotes: 0,
  chunkCount: 0,
  processedNotes: 0,
  totalNotes: 0,
  skippedNotes: 0,
  failedNotes: 0,
  synchronizedAt: null,
  semanticAvailable: false,
  message: null,
  ...overrides,
});

const apiFixture = (
  initialStatus: ObsidianSearchStatus = status(),
): ObsidianSearchApi => ({
  getObsidianSearchStatus: vi.fn(async () => initialStatus),
  searchObsidian: vi.fn(async ({ query }) => ({
    query,
    results: [],
    status: initialStatus,
  })),
  rebuildObsidianSearch: vi.fn(async () => initialStatus),
  openObsidianNote: vi.fn(async () => undefined),
});

/**
 * Notes now answer to the knowledge page's own search box rather than a form of
 * their own, so the harness plays that page: one input driving the query prop.
 */
const Harness = ({ api }: { api: ObsidianSearchApi }) => {
  const [query, setQuery] = useState("");
  return (
    <>
      <input
        type="search"
        aria-label="搜索 Obsidian 笔记"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      <VaultNoteResults api={api} query={query} />
    </>
  );
};

/** Sets the shared query and lets the notes' debounce fire, real or fake. */
const searchFor = async (value: string): Promise<void> => {
  fireEvent.change(screen.getByRole("searchbox"), { target: { value } });
  await act(async () => {
    if (vi.isFakeTimers()) vi.advanceTimersByTime(200);
    else await new Promise((resolve) => setTimeout(resolve, 200));
  });
};

const deferred = <Value,>() => {
  let resolve!: (value: Value) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<Value>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
};

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  window.history.replaceState({}, "", "/");
});

describe("VaultNoteResults", () => {
  it("loads idle status on mount and explains the shared search box", async () => {
    const api = apiFixture();

    render(<Harness api={api} />);

    const page = await screen.findByRole("region", {
      name: "Vault 笔记",
    });
    expect(api.getObsidianSearchStatus).toHaveBeenCalledTimes(1);
    expect(within(page).getByRole("heading", { name: "Vault 笔记" })).toBeVisible();
    expect(within(page).getByText("检索仅在本机处理")).toBeVisible();
    expect(within(page).getByRole("status")).toHaveTextContent(
      "尚未建立全库索引",
    );
    expect(
      within(page).getByText("上方的关键词同时搜索决策与笔记。"),
    ).toBeVisible();
    // The notes no longer carry a search box or a submit button of their own.
    expect(within(page).queryByRole("searchbox")).toBeNull();
    expect(within(page).queryByRole("button", { name: "搜索" })).toBeNull();
  });

  it("walks search results with the arrow keys", async () => {
    const ready = status({ state: "ready", indexedNotes: 2, discoveredNotes: 2 });
    const api = apiFixture(ready);
    vi.mocked(api.searchObsidian).mockResolvedValue({
      query: "回滚",
      status: ready,
      results: [
        {
          relativePath: "运维/发布回滚.md",
          title: "发布回滚检查清单",
          heading: null,
          snippet: "先验证回滚入口。",
          matchKind: "keyword",
        },
        {
          relativePath: "项目/检索.md",
          title: "桌面检索方案",
          heading: null,
          snippet: "本地关键词降级。",
          matchKind: "keyword",
        },
      ],
    });
    const user = userEvent.setup();
    render(<Harness api={api} />);

    await searchFor("回滚");
    const first = await screen.findByRole("button", {
      name: "在 Obsidian 中打开：发布回滚检查清单",
    });
    const second = screen.getByRole("button", {
      name: "在 Obsidian 中打开：桌面检索方案",
    });

    first.focus();
    expect(first).toHaveFocus();
    await user.keyboard("{ArrowDown}");
    expect(second).toHaveFocus();
    await user.keyboard("{End}{Home}");
    expect(first).toHaveFocus();
    // ArrowUp off the top has nowhere to go now: the search box belongs to the
    // knowledge page, so focus simply stays put rather than leaving the list.
    await user.keyboard("{ArrowUp}");
    expect(first).toHaveFocus();
    expect(api.openObsidianNote).not.toHaveBeenCalled();
  });

  it("shows an explicit loading status until the index reports in", async () => {
    const initialStatus = deferred<ObsidianSearchStatus>();
    const api = apiFixture();
    vi.mocked(api.getObsidianSearchStatus).mockReturnValue(
      initialStatus.promise,
    );
    render(<Harness api={api} />);

    expect(screen.getByRole("status")).toHaveTextContent(
      "正在读取全库索引状态…",
    );
    await act(async () => initialStatus.resolve(status({ state: "idle" })));
  });

  it.each([
    {
      label: "first indexing without content",
      searchStatus: status({ state: "indexing", totalNotes: 8 }),
      canSearch: false,
      guidance: "首次索引完成前请稍候。",
    },
    {
      label: "idle without content",
      searchStatus: status({ state: "idle" }),
      canSearch: false,
    },
    {
      label: "ready without content",
      searchStatus: status({ state: "ready" }),
      canSearch: false,
    },
    {
      label: "error without content",
      searchStatus: status({ state: "error" }),
      canSearch: false,
    },
    {
      label: "keyword fallback without content",
      searchStatus: status({ state: "unavailable" }),
      canSearch: false,
    },
    {
      label: "incremental indexing with existing content",
      searchStatus: status({
        state: "indexing",
        discoveredNotes: 7,
        indexedNotes: 3,
        processedNotes: 4,
        totalNotes: 7,
      }),
      canSearch: true,
    },
    {
      label: "error with existing content",
      searchStatus: status({
        state: "error",
        discoveredNotes: 3,
        indexedNotes: 3,
      }),
      canSearch: true,
    },
  ])(
    "derives canSearch for $label",
    async ({ searchStatus, canSearch, guidance }) => {
      const api = apiFixture(searchStatus);
      const user = userEvent.setup();
      render(<Harness api={api} />);
      const input = screen.getByRole("searchbox", {
        name: "搜索 Obsidian 笔记",
      });
      // Some of these statuses are all zeros, and the coverage line they
      // produce is the one the panel already shows before any status arrives —
      // a state in which searching is still allowed. Wait for the loading line
      // to clear, which only a delivered status does.
      await waitFor(() =>
        expect(screen.queryByText("正在读取全库索引状态…")).toBeNull(),
      );
      await screen.findByText(
        `已索引 ${searchStatus.indexedNotes} / 发现 ${searchStatus.discoveredNotes} 篇笔记`,
      );

      if (guidance !== undefined)
        expect(screen.getByText(guidance)).toBeVisible();
      await user.type(input, "可搜索线索");

      if (canSearch) {
        await waitFor(() => expect(api.searchObsidian).toHaveBeenCalled());
        return;
      }
      // An index with nothing in it must stay quiet rather than search and
      // report "no matches"; outlast the debounce before claiming it did.
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 240));
      });
      expect(api.searchObsidian).not.toHaveBeenCalled();
    },
  );

  it("polls every 800ms while indexing, then switches to stable cadence", async () => {
    vi.useFakeTimers();
    const indexing = status({
      state: "indexing",
      discoveredNotes: 12,
      indexedNotes: 0,
      chunkCount: 0,
      processedNotes: 0,
      totalNotes: 12,
    });
    const ready = status({
      state: "ready",
      discoveredNotes: 12,
      indexedNotes: 12,
      chunkCount: 37,
      processedNotes: 12,
      totalNotes: 12,
      semanticAvailable: true,
      synchronizedAt: "2026-08-18T06:00:00.000Z",
    });
    const api = apiFixture(indexing);
    vi.mocked(api.getObsidianSearchStatus)
      .mockResolvedValueOnce(indexing)
      .mockResolvedValueOnce(indexing)
      .mockResolvedValueOnce(ready);

    const view = render(<Harness api={api} />);
    await act(async () => undefined);
    expect(api.getObsidianSearchStatus).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("status")).toHaveTextContent("正在建立全库索引");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(799);
    });
    expect(api.getObsidianSearchStatus).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(api.getObsidianSearchStatus).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("status")).toHaveTextContent("正在建立全库索引");
    expect(screen.getByText("已处理 0 / 12 篇")).toBeVisible();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(800);
    });
    expect(api.getObsidianSearchStatus).toHaveBeenCalledTimes(3);
    const statusStrip = document.querySelector<HTMLElement>(
      ".obsidian-search-status-strip",
    )!;
    expect(within(statusStrip).getByRole("status")).toHaveTextContent(
      "全库索引已就绪",
    );
    expect(screen.getByText("已索引 12 / 发现 12 篇笔记")).toBeVisible();
    expect(screen.getByText("37 个片段")).toBeVisible();
    // As every other time on the knowledge page reads: it said "2026/8/18 14:00:00".
    expect(screen.getByText(/^最近同步：2026年8月1[78]日 \d{2}:\d{2}$/u)).toBeVisible();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_600);
    });
    expect(api.getObsidianSearchStatus).toHaveBeenCalledTimes(3);
    view.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stops asking for the index status while its page is kept hidden, and asks at once when shown", async () => {
    vi.useFakeTimers();
    const api = apiFixture(status({ state: "indexing", discoveredNotes: 12, totalNotes: 12 }));
    const view = render(<PageHidden.Provider value={true}><Harness api={api} /></PageHidden.Provider>);
    await act(async () => undefined);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    // Behind a capture that had the window, it went on asking every 0.8 s for a status nobody saw.
    expect(api.getObsidianSearchStatus).toHaveBeenCalledTimes(1);

    view.rerender(<PageHidden.Provider value={false}><Harness api={api} /></PageHidden.Provider>);
    await act(async () => undefined);
    expect(api.getObsidianSearchStatus).toHaveBeenCalledTimes(2);
    view.unmount();
  });

  it("retries a rejected indexing status request at the stable cadence", async () => {
    vi.useFakeTimers();
    const indexing = status({
      state: "indexing",
      processedNotes: 2,
      totalNotes: 10,
    });
    const ready = status({
      state: "ready",
      indexedNotes: 10,
      discoveredNotes: 10,
    });
    const api = apiFixture(indexing);
    vi.mocked(api.getObsidianSearchStatus)
      .mockResolvedValueOnce(indexing)
      .mockRejectedValueOnce(new Error("temporary"))
      .mockResolvedValueOnce(ready);

    render(<Harness api={api} />);
    await act(async () => undefined);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(800);
    });
    expect(api.getObsidianSearchStatus).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("alert")).toHaveTextContent(
      "暂时无法获取 Obsidian 索引状态。",
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(STABLE_STATUS_REFRESH_MS - 1);
    });
    expect(api.getObsidianSearchStatus).toHaveBeenCalledTimes(2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(api.getObsidianSearchStatus).toHaveBeenCalledTimes(3);
    expect(screen.getByRole("status")).toHaveTextContent("全库索引已就绪");
    expect(screen.queryByText("暂时无法获取 Obsidian 索引状态。")).toBeNull();
  });

  it("refreshes stable status periodically and cancels timers on unmount", async () => {
    vi.useFakeTimers();
    const stableApi = apiFixture(status({ state: "ready" }));
    const stableView = render(<Harness api={stableApi} />);
    await act(async () => undefined);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(STABLE_STATUS_REFRESH_MS - 1);
    });
    expect(stableApi.getObsidianSearchStatus).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(stableApi.getObsidianSearchStatus).toHaveBeenCalledTimes(2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(STABLE_STATUS_REFRESH_MS);
    });
    expect(stableApi.getObsidianSearchStatus).toHaveBeenCalledTimes(3);
    stableView.unmount();
    expect(vi.getTimerCount()).toBe(0);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(STABLE_STATUS_REFRESH_MS);
    });
    expect(stableApi.getObsidianSearchStatus).toHaveBeenCalledTimes(3);

    const indexingApi = apiFixture(status({ state: "indexing" }));
    const indexingView = render(<Harness api={indexingApi} />);
    await act(async () => undefined);
    expect(vi.getTimerCount()).toBe(1);
    indexingView.unmount();
    expect(vi.getTimerCount()).toBe(0);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(INDEXING_STATUS_REFRESH_MS);
    });
    expect(indexingApi.getObsidianSearchStatus).toHaveBeenCalledTimes(1);
  });

  it("discovers background indexing at 5s and switches to the 800ms cadence", async () => {
    vi.useFakeTimers();
    const ready = status({
      state: "ready",
      discoveredNotes: 6,
      indexedNotes: 6,
    });
    const indexing = status({
      state: "indexing",
      discoveredNotes: 9,
      indexedNotes: 6,
      processedNotes: 1,
      totalNotes: 9,
    });
    const progress = status({
      ...indexing,
      processedNotes: 4,
    });
    const api = apiFixture(ready);
    vi.mocked(api.getObsidianSearchStatus)
      .mockResolvedValueOnce(ready)
      .mockResolvedValueOnce(indexing)
      .mockResolvedValueOnce(progress);
    render(<Harness api={api} />);
    await act(async () => undefined);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(STABLE_STATUS_REFRESH_MS - 1);
    });
    expect(api.getObsidianSearchStatus).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(api.getObsidianSearchStatus).toHaveBeenCalledTimes(2);
    expect(screen.getByText("已处理 1 / 9 篇")).toBeVisible();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(INDEXING_STATUS_REFRESH_MS - 1);
    });
    expect(api.getObsidianSearchStatus).toHaveBeenCalledTimes(2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(api.getObsidianSearchStatus).toHaveBeenCalledTimes(3);
    expect(screen.getByText("已处理 4 / 9 篇")).toBeVisible();
  });

  it("shows a background watcher error and omission counts within 5s", async () => {
    vi.useFakeTimers();
    const ready = status({
      state: "ready",
      discoveredNotes: 6,
      indexedNotes: 6,
    });
    const watcherError = status({
      state: "error",
      discoveredNotes: 6,
      indexedNotes: 4,
      skippedNotes: 1,
      failedNotes: 1,
    });
    const api = apiFixture(ready);
    vi.mocked(api.getObsidianSearchStatus)
      .mockResolvedValueOnce(ready)
      .mockResolvedValueOnce(watcherError);
    render(<Harness api={api} />);
    await act(async () => undefined);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(STABLE_STATUS_REFRESH_MS);
    });
    expect(api.getObsidianSearchStatus).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("status")).toHaveTextContent(
      "全库索引暂时不可用，请重建后重试。",
    );
    expect(screen.getByText("1 篇笔记未纳入索引")).toBeVisible();
    expect(screen.getByText("1 篇笔记处理失败")).toBeVisible();
  });

  it("retries an initial status rejection after 5s and recovers", async () => {
    vi.useFakeTimers();
    const ready = status({
      state: "ready",
      discoveredNotes: 5,
      indexedNotes: 5,
    });
    const api = apiFixture(ready);
    vi.mocked(api.getObsidianSearchStatus)
      .mockRejectedValueOnce(new Error("temporary"))
      .mockResolvedValueOnce(ready);
    render(<Harness api={api} />);
    await act(async () => undefined);
    expect(screen.getByRole("alert")).toHaveTextContent(
      "暂时无法获取 Obsidian 索引状态。",
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(STABLE_STATUS_REFRESH_MS - 1);
    });
    expect(api.getObsidianSearchStatus).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(api.getObsidianSearchStatus).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("status")).toHaveTextContent("全库索引已就绪");
    expect(screen.queryByText("暂时无法获取 Obsidian 索引状态。")).toBeNull();
  });

  it("searches the trimmed query once and renders ordered result details", async () => {
    const initial = status({ state: "ready", indexedNotes: 2 });
    const updated = status({
      state: "ready",
      discoveredNotes: 4,
      indexedNotes: 4,
      chunkCount: 15,
      semanticAvailable: true,
      synchronizedAt: "2026-08-18T07:00:00.000Z",
    });
    const response: ObsidianSearchResponse = {
      query: "发布回滚",
      status: updated,
      results: [
        {
          relativePath: "运维/发布回滚.md",
          title: "发布回滚检查清单",
          heading: "演练步骤",
          snippet: "先验证回滚入口，再开始发布。",
          matchKind: "hybrid",
        },
        {
          relativePath: "项目/检索.md",
          title: "桌面检索方案",
          heading: null,
          snippet: "使用本地关键词作为降级路径。",
          matchKind: "keyword",
        },
        {
          relativePath: "日志/相关记录.md",
          title: "相关记录",
          heading: "上下文",
          snippet: "语义上与查询相关。",
          matchKind: "semantic",
        },
      ],
    };
    const search = deferred<ObsidianSearchResponse>();
    const api = apiFixture(initial);
    vi.mocked(api.searchObsidian).mockReturnValue(search.promise);
    render(<Harness api={api} />);
    const page = await screen.findByRole("region", { name: "Vault 笔记" });
    const input = screen.getByRole("searchbox", { name: "搜索 Obsidian 笔记" });

    fireEvent.change(input, { target: { value: "  发布回滚  " } });
    // Typing must not fire a request per keystroke.
    expect(api.searchObsidian).not.toHaveBeenCalled();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
    });
    expect(api.searchObsidian).toHaveBeenCalledWith({ query: "发布回滚" });
    expect(within(page).getByText("正在查找…")).toBeVisible();

    await act(async () => search.resolve(response));
    const list = screen.getByRole("list", { name: "Obsidian 搜索结果" });
    expect(within(page).getByText("3 篇笔记")).toBeVisible();
    const items = within(list).getAllByRole("listitem");
    expect(items).toHaveLength(3);
    expect(items[0]).toHaveTextContent(
      "发布回滚检查清单运维/发布回滚.md演练步骤先验证回滚入口，再开始发布。综合命中",
    );
    expect(items[1]).toHaveTextContent(
      "桌面检索方案项目/检索.md使用本地关键词作为降级路径。关键词命中",
    );
    expect(items[2]).toHaveTextContent(
      "相关记录日志/相关记录.md上下文语义上与查询相关。语义相关",
    );
    expect(screen.getByText("已索引 4 / 发现 4 篇笔记")).toBeVisible();

    // Clearing the shared box drops the results without another request.
    await searchFor("   ");
    expect(api.searchObsidian).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("list", { name: "Obsidian 搜索结果" })).toBeNull();
  });

  it("lets a newer query win over a slower in-flight one", async () => {
    const slow = deferred<ObsidianSearchResponse>();
    const ready = status({ state: "ready", discoveredNotes: 4, indexedNotes: 4 });
    const api = apiFixture(ready);
    vi.mocked(api.searchObsidian).mockReturnValueOnce(slow.promise);
    render(<Harness api={api} />);
    await screen.findByText("全库索引已就绪。");

    await searchFor("查询 A");
    vi.mocked(api.searchObsidian).mockResolvedValue({
      query: "查询 B",
      status: ready,
      results: [
        {
          relativePath: "测试/查询-B.md",
          title: "查询 B 的笔记",
          heading: null,
          snippet: "只属于查询 B。",
          matchKind: "semantic",
        },
      ],
    });
    await searchFor("查询 B");

    // A resolves last but is stale, so it must not overwrite B's results.
    await act(async () =>
      slow.resolve({
        query: "查询 A",
        status: ready,
        results: [
          {
            relativePath: "测试/查询-A.md",
            title: "查询 A 的笔记",
            heading: null,
            snippet: "只属于查询 A。",
            matchKind: "semantic",
          },
        ],
      }),
    );

    expect(screen.getByText("查询 B 的笔记")).toBeVisible();
    expect(screen.queryByText("查询 A 的笔记")).toBeNull();
  });

  it("prevents an older mount response from replacing newer search status", async () => {
    vi.useFakeTimers();
    const mountStatus = deferred<ObsidianSearchStatus>();
    const api = apiFixture();
    vi.mocked(api.getObsidianSearchStatus).mockReturnValueOnce(
      mountStatus.promise,
    );
    vi.mocked(api.searchObsidian).mockResolvedValue({
      query: "新查询",
      results: [],
      status: status({
        state: "ready",
        discoveredNotes: 9,
        indexedNotes: 9,
      }),
    });
    const view = render(<Harness api={api} />);
    await searchFor("新查询");
    await act(async () => undefined);
    expect(screen.getByText("已索引 9 / 发现 9 篇笔记")).toBeVisible();

    await act(async () =>
      mountStatus.resolve(status({ state: "indexing", totalNotes: 99 })),
    );
    expect(
      within(
        document.querySelector<HTMLElement>(".obsidian-search-status-strip")!,
      ).getByRole("status"),
    ).toHaveTextContent("全库索引已就绪");
    expect(screen.getByText("已索引 9 / 发现 9 篇笔记")).toBeVisible();
    expect(vi.getTimerCount()).toBe(1);
    view.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("commits deferred initial status after a fast rejected search", async () => {
    const initialStatus = deferred<ObsidianSearchStatus>();
    const api = apiFixture();
    vi.mocked(api.getObsidianSearchStatus).mockReturnValue(
      initialStatus.promise,
    );
    vi.mocked(api.searchObsidian).mockRejectedValue(new Error("search failed"));
    render(<Harness api={api} />);
    await searchFor("竞态搜索");

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "暂时无法搜索 Obsidian 笔记。",
    );
    await act(async () =>
      initialStatus.resolve(
        status({
          state: "ready",
          discoveredNotes: 5,
          indexedNotes: 5,
        }),
      ),
    );
    expect(screen.getByText("已索引 5 / 发现 5 篇笔记")).toBeVisible();
    expect(screen.getByRole("status")).toHaveTextContent("全库索引已就绪");
  });

  it("refreshes status after rebuild rejects during initial loading", async () => {
    const oldInitialStatus = deferred<ObsidianSearchStatus>();
    const recoveredStatus = deferred<ObsidianSearchStatus>();
    const api = apiFixture();
    vi.mocked(api.getObsidianSearchStatus)
      .mockReturnValueOnce(oldInitialStatus.promise)
      .mockReturnValueOnce(recoveredStatus.promise);
    vi.mocked(api.rebuildObsidianSearch).mockRejectedValue(
      new Error("rebuild failed"),
    );
    render(<Harness api={api} />);
    fireEvent.click(screen.getByRole("button", { name: "重建全库索引" }));

    expect(
      await screen.findByText("暂时无法重建 Obsidian 全库索引。"),
    ).toHaveAttribute("role", "alert");
    expect(api.getObsidianSearchStatus).toHaveBeenCalledTimes(2);
    await act(async () =>
      recoveredStatus.resolve(
        status({
          state: "ready",
          discoveredNotes: 6,
          indexedNotes: 6,
        }),
      ),
    );
    expect(screen.getByText("已索引 6 / 发现 6 篇笔记")).toBeVisible();

    await act(async () =>
      oldInitialStatus.resolve(status({ state: "indexing", totalNotes: 99 })),
    );
    expect(screen.getByRole("status")).toHaveTextContent("全库索引已就绪");
    expect(screen.getByText("已索引 6 / 发现 6 篇笔记")).toBeVisible();
  });

  it("prevents an older poll from replacing a newer rebuild status", async () => {
    vi.useFakeTimers();
    const indexing = status({ state: "indexing", totalNotes: 12 });
    const poll = deferred<ObsidianSearchStatus>();
    const api = apiFixture(indexing);
    vi.mocked(api.getObsidianSearchStatus)
      .mockResolvedValueOnce(indexing)
      .mockReturnValueOnce(poll.promise);
    vi.mocked(api.rebuildObsidianSearch).mockResolvedValue(
      status({
        state: "ready",
        discoveredNotes: 20,
        indexedNotes: 20,
      }),
    );
    render(<Harness api={api} />);
    await act(async () => undefined);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(800);
    });
    expect(api.getObsidianSearchStatus).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole("button", { name: "重建全库索引" }));
    await act(async () => undefined);
    expect(screen.getByText("已索引 20 / 发现 20 篇笔记")).toBeVisible();

    await act(async () => poll.resolve(indexing));
    expect(screen.getByRole("status")).toHaveTextContent("全库索引已就绪");
    expect(screen.getByText("已索引 20 / 发现 20 篇笔记")).toBeVisible();
  });

  it("releases search busy state when a newer rebuild owns status", async () => {
    const search = deferred<ObsidianSearchResponse>();
    const api = apiFixture(
      status({ state: "ready", discoveredNotes: 1, indexedNotes: 1 }),
    );
    vi.mocked(api.searchObsidian).mockReturnValue(search.promise);
    vi.mocked(api.rebuildObsidianSearch).mockResolvedValue(
      status({ state: "ready", indexedNotes: 4 }),
    );
    render(<Harness api={api} />);
    await screen.findByText("全库索引已就绪。");
    await searchFor("并发状态");
    fireEvent.click(screen.getByRole("button", { name: "重建全库索引" }));
    await act(async () => undefined);

    await act(async () =>
      search.resolve({
        query: "并发状态",
        results: [],
        status: status({ state: "indexing", totalNotes: 99 }),
      }),
    );
    expect(screen.queryByText("正在查找…")).toBeNull();
    expect(screen.getByText("已索引 4 / 发现 0 篇笔记")).toBeVisible();
  });

  it("surfaces a pending search rejection after rebuild starts", async () => {
    const search = deferred<ObsidianSearchResponse>();
    const rebuild = deferred<ObsidianSearchStatus>();
    const api = apiFixture(
      status({ state: "ready", discoveredNotes: 2, indexedNotes: 2 }),
    );
    vi.mocked(api.searchObsidian).mockReturnValue(search.promise);
    vi.mocked(api.rebuildObsidianSearch).mockReturnValue(rebuild.promise);
    render(<Harness api={api} />);
    await screen.findByText("全库索引已就绪。");
    await searchFor("搜索失败");
    fireEvent.click(screen.getByRole("button", { name: "重建全库索引" }));

    await act(async () => search.reject(new Error("search failed")));
    expect(screen.getByRole("alert")).toHaveTextContent(
      "暂时无法搜索 Obsidian 笔记。",
    );
    expect(screen.queryByText("正在查找…")).toBeNull();
    expect(screen.getByRole("button", { name: "正在重建…" })).toBeDisabled();
  });

  it("surfaces a pending rebuild rejection after search starts", async () => {
    const search = deferred<ObsidianSearchResponse>();
    const rebuild = deferred<ObsidianSearchStatus>();
    const api = apiFixture(
      status({ state: "ready", discoveredNotes: 2, indexedNotes: 2 }),
    );
    vi.mocked(api.searchObsidian).mockReturnValue(search.promise);
    vi.mocked(api.rebuildObsidianSearch).mockReturnValue(rebuild.promise);
    render(<Harness api={api} />);
    await screen.findByText("全库索引已就绪。");
    fireEvent.click(screen.getByRole("button", { name: "重建全库索引" }));
    await searchFor("并行搜索");

    await act(async () => rebuild.reject(new Error("rebuild failed")));
    expect(screen.getByRole("alert")).toHaveTextContent(
      "暂时无法重建 Obsidian 全库索引。",
    );
    expect(screen.getByRole("button", { name: "重建全库索引" })).toBeEnabled();
    expect(screen.getByText("正在查找…")).toBeVisible();
  });

  it("renders overlapping search results while rebuild remains status authority", async () => {
    const search = deferred<ObsidianSearchResponse>();
    const rebuild = deferred<ObsidianSearchStatus>();
    const api = apiFixture(
      status({ state: "ready", discoveredNotes: 2, indexedNotes: 2 }),
    );
    vi.mocked(api.searchObsidian).mockReturnValue(search.promise);
    vi.mocked(api.rebuildObsidianSearch).mockReturnValue(rebuild.promise);
    render(<Harness api={api} />);
    await screen.findByText("全库索引已就绪。");
    await searchFor("并行结果");
    fireEvent.click(screen.getByRole("button", { name: "重建全库索引" }));

    await act(async () =>
      search.resolve({
        query: "并行结果",
        status: status({
          state: "ready",
          discoveredNotes: 99,
          indexedNotes: 99,
        }),
        results: [
          {
            relativePath: "并行/搜索结果.md",
            title: "并行搜索结果",
            heading: null,
            snippet: "结果独立于重建状态显示。",
            matchKind: "semantic",
          },
        ],
      }),
    );
    expect(
      screen.getByRole("button", { name: "在 Obsidian 中打开：并行搜索结果" }),
    ).toBeVisible();
    expect(
      within(
        document.querySelector<HTMLElement>(".obsidian-search-status-strip")!,
      ).getByRole("status"),
    ).toHaveTextContent("正在更新全库索引");
    expect(screen.getByText("已索引 2 / 发现 2 篇笔记")).toBeVisible();

    await act(async () =>
      rebuild.resolve(
        status({
          state: "ready",
          discoveredNotes: 5,
          indexedNotes: 5,
        }),
      ),
    );
    expect(screen.getByText("已索引 5 / 发现 5 篇笔记")).toBeVisible();
    expect(
      screen.getByRole("button", { name: "在 Obsidian 中打开：并行搜索结果" }),
    ).toBeVisible();
  });

  it("ignores old API responses and search completion after unmount", async () => {
    const oldStatus = deferred<ObsidianSearchStatus>();
    const oldApi = apiFixture();
    vi.mocked(oldApi.getObsidianSearchStatus).mockReturnValue(
      oldStatus.promise,
    );
    const newApi = apiFixture(
      status({ state: "ready", discoveredNotes: 7, indexedNotes: 7 }),
    );
    const view = render(<Harness api={oldApi} />);
    view.rerender(<Harness api={newApi} />);
    expect(await screen.findByText("已索引 7 / 发现 7 篇笔记")).toBeVisible();
    await act(async () =>
      oldStatus.resolve(status({ state: "error", message: "old" })),
    );
    expect(screen.getByRole("status")).toHaveTextContent("全库索引已就绪");

    const pendingSearch = deferred<ObsidianSearchResponse>();
    vi.mocked(newApi.searchObsidian).mockReturnValue(pendingSearch.promise);
    await searchFor("卸载测试");
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    view.unmount();
    await act(async () =>
      pendingSearch.resolve({
        query: "卸载测试",
        results: [],
        status: status({ state: "error" }),
      }),
    );
    expect(consoleError).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it("opens the exact Unicode relative path once and reports a generic failure", async () => {
    const api = apiFixture(
      status({ state: "ready", discoveredNotes: 2, indexedNotes: 2 }),
    );
    vi.mocked(api.searchObsidian).mockResolvedValue({
      query: "发布",
      status: status({ state: "ready" }),
      results: [
        {
          relativePath: "项目/桌面检索方案（草案）.md",
          title: "桌面检索方案",
          heading: null,
          snippet: "本地检索。",
          matchKind: "semantic",
        },
      ],
    });
    const opening = deferred<void>();
    vi.mocked(api.openObsidianNote).mockReturnValueOnce(opening.promise);
    render(<Harness api={api} />);
    await screen.findByRole("region", { name: "Vault 笔记" });
    await searchFor("发布");
    const result = await screen.findByRole("button", {
      name: "在 Obsidian 中打开：桌面检索方案",
    });

    result.focus();
    fireEvent.click(result);
    fireEvent.click(result);
    expect(api.openObsidianNote).toHaveBeenCalledTimes(1);
    expect(api.openObsidianNote).toHaveBeenCalledWith(
      "项目/桌面检索方案（草案）.md",
    );
    // Marked busy, not disabled: it keeps focus, and the arrow keys keep working.
    expect(result).toHaveAttribute("aria-disabled", "true");
    expect(result).toBeEnabled();
    expect(result).toHaveFocus();
    await act(async () => opening.resolve());
    expect(result).toHaveAttribute("aria-disabled", "false");

    vi.mocked(api.openObsidianNote).mockRejectedValueOnce(
      new Error("secret /Users/alice/private-vault"),
    );
    fireEvent.click(result);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "暂时无法在 Obsidian 中打开这篇笔记。",
    );
    expect(document.body).not.toHaveTextContent("/Users/alice");
  });

  it("opens a focused native result button with Enter and Space", async () => {
    const relativePath = "项目/键盘检索（终稿）.md";
    const firstOpen = deferred<void>();
    const api = apiFixture(
      status({ state: "ready", discoveredNotes: 1, indexedNotes: 1 }),
    );
    vi.mocked(api.searchObsidian).mockResolvedValue({
      query: "键盘",
      status: status({ state: "ready" }),
      results: [
        {
          relativePath,
          title: "键盘检索终稿",
          heading: null,
          snippet: "可以直接用键盘打开。",
          matchKind: "hybrid",
        },
      ],
    });
    vi.mocked(api.openObsidianNote)
      .mockReturnValueOnce(firstOpen.promise)
      .mockResolvedValueOnce(undefined);
    const user = userEvent.setup();
    render(<Harness api={api} />);
    await screen.findByText("全库索引已就绪。");
    await user.type(screen.getByRole("searchbox"), "键盘");
    await user.keyboard("{Enter}");
    const result = await screen.findByRole("button", {
      name: "在 Obsidian 中打开：键盘检索终稿",
    });

    expect(result.tagName).toBe("BUTTON");
    expect(result).toHaveAttribute("type", "button");
    result.focus();
    expect(result).toHaveFocus();
    expect(result).toHaveAccessibleName("在 Obsidian 中打开：键盘检索终稿");
    await user.keyboard("{Enter}");
    expect(api.openObsidianNote).toHaveBeenCalledTimes(1);
    expect(api.openObsidianNote).toHaveBeenLastCalledWith(relativePath);
    await act(async () => firstOpen.resolve());
    expect(result).toBeEnabled();
    expect(result).toHaveFocus();
    expect(result).toHaveAccessibleName("在 Obsidian 中打开：键盘检索终稿");

    await user.keyboard(" ");
    expect(api.openObsidianNote).toHaveBeenCalledTimes(2);
    expect(vi.mocked(api.openObsidianNote).mock.calls).toEqual([
      [relativePath],
      [relativePath],
    ]);
    expect(result).toHaveFocus();
    expect(result).toHaveAccessibleName("在 Obsidian 中打开：键盘检索终稿");
  });

  it("keeps every concurrently opening result marked busy until its own call settles", async () => {
    const firstOpen = deferred<void>();
    const secondOpen = deferred<void>();
    const api = apiFixture(
      status({ state: "ready", discoveredNotes: 2, indexedNotes: 2 }),
    );
    vi.mocked(api.searchObsidian).mockResolvedValue({
      query: "并发",
      status: status({ state: "ready" }),
      results: [
        {
          relativePath: "并发/一.md",
          title: "第一篇",
          heading: null,
          snippet: "第一篇内容",
          matchKind: "keyword",
        },
        {
          relativePath: "并发/二.md",
          title: "第二篇",
          heading: null,
          snippet: "第二篇内容",
          matchKind: "semantic",
        },
      ],
    });
    vi.mocked(api.openObsidianNote).mockImplementation((relativePath) =>
      relativePath === "并发/一.md" ? firstOpen.promise : secondOpen.promise,
    );
    const user = userEvent.setup();
    render(<Harness api={api} />);
    await screen.findByRole("region", { name: "Vault 笔记" });
    await user.type(screen.getByRole("searchbox"), "并发");
    await user.keyboard("{Enter}");
    const first = await screen.findByRole("button", {
      name: "在 Obsidian 中打开：第一篇",
    });
    const second = screen.getByRole("button", {
      name: "在 Obsidian 中打开：第二篇",
    });

    await user.click(first);
    await user.click(second);
    expect(first).toHaveAttribute("aria-disabled", "true");
    expect(second).toHaveAttribute("aria-disabled", "true");
    await act(async () => firstOpen.resolve());
    expect(first).toHaveAttribute("aria-disabled", "false");
    expect(second).toHaveAttribute("aria-disabled", "true");
    await act(async () => secondOpen.resolve());
    expect(second).toHaveAttribute("aria-disabled", "false");
  });

  it("ignores an opening error from a replaced API generation", async () => {
    const opening = deferred<void>();
    const oldApi = apiFixture(status({ state: "ready" }));
    vi.mocked(oldApi.searchObsidian).mockResolvedValue({
      query: "旧接口",
      status: status({ state: "ready" }),
      results: [
        {
          relativePath: "旧/接口.md",
          title: "旧接口",
          heading: null,
          snippet: "旧结果",
          matchKind: "keyword",
        },
      ],
    });
    vi.mocked(oldApi.openObsidianNote).mockReturnValue(opening.promise);
    const newApi = apiFixture(status({ state: "ready" }));
    const view = render(<Harness api={oldApi} />);
    await searchFor("旧接口");
    const result = await screen.findByRole("button", {
      name: "在 Obsidian 中打开：旧接口",
    });
    fireEvent.click(result);
    view.rerender(<Harness api={newApi} />);

    await act(async () => opening.reject(new Error("old open failed")));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("distinguishes empty, fallback, first-index, update, and error states", async () => {
    const api = apiFixture(status({ state: "indexing", totalNotes: 8 }));
    vi.mocked(api.searchObsidian)
      .mockResolvedValueOnce({
        query: "不存在",
        results: [],
        status: status({ state: "ready", indexedNotes: 8 }),
      })
      .mockResolvedValueOnce({
        query: "回滚",
        results: [
          {
            relativePath: "运维/回滚.md",
            title: "回滚",
            heading: null,
            snippet: "只使用关键词命中。",
            matchKind: "keyword",
          },
        ],
        status: status({ state: "unavailable", indexedNotes: 8 }),
      });
    const firstIndex = render(<Harness api={api} />);
    await screen.findByText("正在建立全库索引，完成后即可搜索。");
    expect(screen.getByText("已处理 0 / 8 篇")).toBeVisible();
    expect(screen.getByText("首次索引完成前请稍候。")).toBeVisible();
    // Nothing indexed yet: a query must wait rather than report "no matches".
    await searchFor("不存在");
    expect(api.searchObsidian).not.toHaveBeenCalled();
    firstIndex.unmount();

    const view = render(
      <Harness api={{ ...api, getObsidianSearchStatus: async () => status({ state: "ready", indexedNotes: 8, discoveredNotes: 8 }) }} />,
    );
    await screen.findByText("全库索引已就绪。");
    await searchFor("不存在");
    expect(
      await screen.findByText("“不存在” 没有匹配的笔记"),
    ).toBeVisible();
    await searchFor("回滚");
    expect(await screen.findByText("只使用关键词命中。")).toBeVisible();
    expect(screen.getByText("关键词命中")).toBeVisible();
    expect(
      within(
        document.querySelector<HTMLElement>(".obsidian-search-status-strip")!,
      ).getByRole("status"),
    ).toHaveTextContent("语义检索暂不可用，当前仅使用关键词匹配。");

    view.unmount();
    const updatingApi = apiFixture(
      status({
        state: "indexing",
        indexedNotes: 5,
        processedNotes: 1,
        totalNotes: 7,
      }),
    );
    render(<Harness api={updatingApi} />);
    expect(await screen.findByRole("status")).toHaveTextContent(
      "正在更新全库索引，已有内容仍可搜索。",
    );
    expect(screen.getByText("已处理 1 / 7 篇")).toBeVisible();
    cleanup();

    const errorApi = apiFixture(
      status({ state: "error", message: "private /Users/alice/vault" }),
    );
    render(<Harness api={errorApi} />);
    expect(await screen.findByRole("status")).toHaveTextContent(
      "全库索引暂时不可用，请重建后重试。",
    );
    expect(document.body).not.toHaveTextContent("/Users/alice");
  });

  it("reports partial indexing honestly with generic omission counts", async () => {
    const api = apiFixture(
      status({
        state: "ready",
        discoveredNotes: 354,
        indexedNotes: 349,
        skippedNotes: 3,
        failedNotes: 2,
      }),
    );
    render(<Harness api={api} />);

    expect(await screen.findByRole("status")).toHaveTextContent(
      "索引已完成，部分笔记未纳入。",
    );
    expect(screen.getByText("3 篇笔记未纳入索引")).toBeVisible();
    expect(screen.getByText("2 篇笔记处理失败")).toBeVisible();
    expect(screen.queryByText("全库索引已就绪。")).toBeNull();
  });

  it("reports status, search, and rebuild API rejection separately without secrets", async () => {
    const statusApi = apiFixture();
    vi.mocked(statusApi.getObsidianSearchStatus).mockRejectedValue(
      new Error("status /secret/status"),
    );
    const first = render(<Harness api={statusApi} />);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "暂时无法获取 Obsidian 索引状态。",
    );
    first.unmount();

    const api = apiFixture(
      status({ state: "ready", discoveredNotes: 1, indexedNotes: 1 }),
    );
    vi.mocked(api.searchObsidian).mockRejectedValue(
      new Error("search /secret/search"),
    );
    vi.mocked(api.rebuildObsidianSearch).mockRejectedValue(
      new Error("rebuild /secret/rebuild"),
    );
    render(<Harness api={api} />);
    await screen.findByRole("region", { name: "Vault 笔记" });
    await searchFor("线索");
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "暂时无法搜索 Obsidian 笔记。",
    );
    fireEvent.click(screen.getByRole("button", { name: "重建全库索引" }));
    expect(
      await screen.findByText("暂时无法重建 Obsidian 全库索引。"),
    ).toHaveAttribute("role", "alert");
    expect(document.body.textContent).not.toMatch(/\/secret\//u);
  });

  it("recovers from a rejected search with an explicit successful retry", async () => {
    const recoveredStatus = status({
      state: "ready",
      discoveredNotes: 6,
      indexedNotes: 6,
      chunkCount: 18,
      semanticAvailable: true,
    });
    const api = apiFixture(
      status({ state: "ready", discoveredNotes: 1, indexedNotes: 1 }),
    );
    vi.mocked(api.searchObsidian)
      .mockRejectedValueOnce(new Error("private first failure"))
      .mockResolvedValueOnce({
        query: "恢复搜索",
        status: recoveredStatus,
        results: [
          {
            relativePath: "测试/恢复搜索.md",
            title: "恢复搜索",
            heading: "重试",
            snippet: "第二次显式提交成功。",
            matchKind: "semantic",
          },
        ],
      });
    const user = userEvent.setup();
    render(<Harness api={api} />);
    await screen.findByText("全库索引已就绪。");
    const searchbox = screen.getByRole("searchbox", {
      name: "搜索 Obsidian 笔记",
    });

    await searchFor("恢复搜索");
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "暂时无法搜索 Obsidian 笔记。",
    );
    // A failed search must leave the shared box usable so the next keystroke
    // retries rather than stranding the page.
    expect(searchbox).toBeEnabled();

    await searchFor("恢复搜索 重试");
    expect(
      await screen.findByRole("button", {
        name: "在 Obsidian 中打开：恢复搜索",
      }),
    ).toBeVisible();
    expect(screen.queryByText("暂时无法搜索 Obsidian 笔记。")).toBeNull();
    expect(
      within(
        document.querySelector<HTMLElement>(".obsidian-search-status-strip")!,
      ).getByRole("status"),
    ).toHaveTextContent("全库索引已就绪");
    expect(screen.getByText("已索引 6 / 发现 6 篇笔记")).toBeVisible();
    expect(api.searchObsidian).toHaveBeenCalledTimes(2);
    expect(vi.mocked(api.searchObsidian).mock.calls).toEqual([
      [{ query: "恢复搜索" }],
      [{ query: "恢复搜索 重试" }],
    ]);
  });

  it("rebuilds only the full-vault index and guards duplicate rebuilds", async () => {
    const rebuilding = deferred<ObsidianSearchStatus>();
    const decisionRebuild = vi.fn<DecisionApi["rebuildIndex"]>();
    const api = {
      ...apiFixture(status({ state: "ready" })),
      rebuildIndex: decisionRebuild,
    };
    vi.mocked(api.rebuildObsidianSearch).mockReturnValue(rebuilding.promise);
    render(<Harness api={api} />);
    await screen.findByRole("region", { name: "Vault 笔记" });
    const button = screen.getByRole("button", { name: "重建全库索引" });

    fireEvent.click(button);
    fireEvent.click(button);
    expect(api.rebuildObsidianSearch).toHaveBeenCalledTimes(1);
    expect(decisionRebuild).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "正在重建…" })).toBeDisabled();
    await act(async () =>
      rebuilding.resolve(
        status({ state: "indexing", indexedNotes: 4, totalNotes: 9 }),
      ),
    );
    expect(screen.getByRole("status")).toHaveTextContent("正在更新全库索引");
  });

  it("polls rebuild progress immediately from a previously ready status", async () => {
    vi.useFakeTimers();
    const initial = status({
      state: "ready",
      discoveredNotes: 4,
      indexedNotes: 4,
      chunkCount: 12,
    });
    const progress = status({
      state: "indexing",
      discoveredNotes: 10,
      indexedNotes: 4,
      chunkCount: 12,
      processedNotes: 3,
      totalNotes: 10,
    });
    const rebuilt = status({
      state: "ready",
      discoveredNotes: 10,
      indexedNotes: 10,
      chunkCount: 31,
      processedNotes: 10,
      totalNotes: 10,
    });
    const rebuild = deferred<ObsidianSearchStatus>();
    const api = apiFixture(initial);
    vi.mocked(api.getObsidianSearchStatus)
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce(progress);
    vi.mocked(api.rebuildObsidianSearch).mockReturnValue(rebuild.promise);
    render(<Harness api={api} />);
    await act(async () => undefined);

    fireEvent.click(screen.getByRole("button", { name: "重建全库索引" }));
    expect(screen.getByRole("status")).toHaveTextContent(
      "正在更新全库索引，已有内容仍可搜索。",
    );
    expect(screen.getByText("已索引 4 / 发现 4 篇笔记")).toBeVisible();
    expect(screen.getByText("已处理 0 / 4 篇")).toBeVisible();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(799);
    });
    expect(api.getObsidianSearchStatus).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(api.getObsidianSearchStatus).toHaveBeenCalledTimes(2);
    expect(screen.getByText("已处理 3 / 10 篇")).toBeVisible();
    expect(screen.getByText("已索引 4 / 发现 10 篇笔记")).toBeVisible();

    await act(async () => rebuild.resolve(rebuilt));
    expect(screen.getByRole("status")).toHaveTextContent("全库索引已就绪");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_600);
    });
    expect(api.getObsidianSearchStatus).toHaveBeenCalledTimes(2);
  });

  it("switches to stable refresh while rebuild completion is pending", async () => {
    vi.useFakeTimers();
    const ready = status({
      state: "ready",
      discoveredNotes: 3,
      indexedNotes: 3,
    });
    const rebuild = deferred<ObsidianSearchStatus>();
    const api = apiFixture(ready);
    vi.mocked(api.getObsidianSearchStatus)
      .mockResolvedValueOnce(ready)
      .mockResolvedValueOnce(ready);
    vi.mocked(api.rebuildObsidianSearch).mockReturnValue(rebuild.promise);
    const view = render(<Harness api={api} />);
    await act(async () => undefined);
    fireEvent.click(screen.getByRole("button", { name: "重建全库索引" }));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(800);
    });
    expect(api.getObsidianSearchStatus).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("status")).toHaveTextContent(
      "正在完成全库索引重建…",
    );
    expect(screen.getByRole("button", { name: "正在重建…" })).toBeDisabled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(STABLE_STATUS_REFRESH_MS - 1);
    });
    expect(api.getObsidianSearchStatus).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(1);

    await act(async () => rebuild.resolve(ready));
    expect(screen.getByRole("status")).toHaveTextContent("全库索引已就绪。");
    expect(screen.getByRole("button", { name: "重建全库索引" })).toBeEnabled();
    expect(vi.getTimerCount()).toBe(1);
    view.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps long and markup-like user content as named text controls", async () => {
    const dangerousTitle = '<img src=x onerror="alert(1)">超长标题';
    const longSegment = "synthetic".repeat(80);
    const ready = status({ state: "ready", indexedNotes: 1, discoveredNotes: 1 });
    const api = apiFixture(ready);
    vi.mocked(api.searchObsidian).mockResolvedValue({
      query: "markup",
      status: ready,
      results: [
        {
          relativePath: `测试/${longSegment}.md`,
          title: dangerousTitle,
          heading: "<script>not code</script>",
          snippet: `<b>${longSegment}</b>`,
          matchKind: "hybrid",
        },
      ],
    });
    render(<Harness api={api} />);
    await screen.findByRole("region", { name: "Vault 笔记" });
    await searchFor("markup");

    const result = await screen.findByRole("button", {
      name: `在 Obsidian 中打开：${dangerousTitle}`,
    });
    expect(result).toHaveTextContent(dangerousTitle);
    expect(result).toHaveTextContent(longSegment);
    expect(result.querySelector("img")).toBeNull();
    expect(result.querySelector("script")).toBeNull();
    for (const button of screen.getAllByRole("button")) {
      expect(button).toHaveAccessibleName();
    }
  });

  it("provides synthetic Obsidian preview states and results", async () => {
    window.history.replaceState({}, "", "/?preview=decisions");
    const readyApi = createPreviewApi();
    await expect(readyApi.getSnapshot()).resolves.toMatchObject({
      current: null,
      primarySurface: "decisions",
    });
    const previewStatus = await readyApi.getObsidianSearchStatus();
    expect(previewStatus).toMatchObject({
      state: "ready",
      discoveredNotes: 352,
      indexedNotes: 349,
      skippedNotes: 3,
      failedNotes: 0,
      semanticAvailable: true,
      synchronizedAt: "2026-08-18T08:30:00.000Z",
    });
    expect(previewStatus.discoveredNotes).toBe(
      previewStatus.indexedNotes + previewStatus.skippedNotes,
    );
    const preview = render(<Harness api={readyApi} />);
    expect(await screen.findByRole("status")).toHaveTextContent(
      "索引已完成，部分笔记未纳入。",
    );
    expect(screen.getByText("3 篇笔记未纳入索引")).toBeVisible();
    preview.unmount();
    const response = await readyApi.searchObsidian({ query: "发布回滚" });
    expect(response.results.map((result) => result.relativePath).slice(0, 3)).toEqual([
      "运维/发布回滚.md",
      "项目/桌面检索方案.md",
      "Decision Journal/索引权衡.md",
    ]);
    expect(response.results.length).toBeGreaterThanOrEqual(10);
    expect(new Set(response.results.map((result) => result.matchKind))).toEqual(
      new Set(["keyword", "semantic", "hybrid"]),
    );
    expect(
      response.results.some((result) => /synthetic/u.test(result.snippet)),
    ).toBe(true);
    const longestUnbrokenSegment = response.results
      .flatMap((result) => [result.relativePath, result.snippet])
      .flatMap((value) => value.split(/\s/u))
      .reduce((longest, value) =>
        value.length > longest.length ? value : longest,
      );
    expect(longestUnbrokenSegment.length).toBeGreaterThanOrEqual(500);

    window.history.replaceState(
      {},
      "",
      "/?preview=obsidian&interaction=indexing",
    );
    await expect(
      createPreviewApi().getObsidianSearchStatus(),
    ).resolves.toMatchObject({
      state: "indexing",
      indexedNotes: 0,
    });

    window.history.replaceState(
      {},
      "",
      "/?preview=obsidian&interaction=semantic-unavailable",
    );
    const fallbackApi = createPreviewApi();
    await expect(fallbackApi.getObsidianSearchStatus()).resolves.toMatchObject({
      state: "unavailable",
      semanticAvailable: false,
    });
    expect(
      (await fallbackApi.searchObsidian({ query: "回滚" })).results,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ matchKind: "keyword" }),
      ]),
    );
    window.history.replaceState({}, "", "/");
  });
});
