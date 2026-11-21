import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import {
  modelKindSupportsGeneration,
  organizationSourceKindSchema,
  type HandledSuggestionView,
  type OrganizationQuery,
  type OrganizationScope,
  type OrganizationSnapshot,
  type RedactedModelProviderProfile,
  type SuggestionDecisionResult,
  type SuggestionDraft,
  type SuggestionUndoResult,
  type SuggestionView,
} from "@cognelis/decision-protocol";

import type { DecisionApi } from "../../../../shared/renderer-api.js";
import { ActionIcon } from "../../IconButton.js";
import { OrganizationStatus } from "./OrganizationStatus.js";
import { SuggestionDetail, type DetailActions, type Notice } from "./SuggestionDetail.js";
import { ACTIVE_STATES, STATE_LABEL, runResultText, TAB_LABEL, TAB_ORDER, TYPE_LABEL, runSummary, shortDate, SOURCE_KIND_LABEL, type OrganizationTab } from "./organization-text.js";
import "./organization.css";

export type OrganizationApi = Pick<
  DecisionApi,
  | "getOrganization" | "runOrganization" | "controlOrganizationRun" | "decideSuggestion" | "adoptSuggestions" | "saveSuggestionDraft"
  | "undoSuggestion" | "regenerateSuggestion" | "setOrganizationSettings" | "listModelProviderProfiles" | "openVaultDocument"
>;

/** 宿主页（待办或知识）此刻看到的东西：整理的范围只能来自这里，不自行放大。 */
export interface OrganizationContext {
  /** 当前项目；清单没设项目就是 null，这时不提供「项目」范围，也不和别的项目混合。 */
  project: string | null;
  /** 可选的项目（知识页没有当前清单时从这里选）。 */
  projects: readonly string[];
  listId: string | null;
  listTitle: string | null;
  /** 待办页里勾选的事项（todo_item 来源）。 */
  items: readonly string[];
}

interface OrganizationPanelProps {
  api: OrganizationApi;
  /** DashboardSnapshot.organizationRevision：变了就重新读。 */
  organizationRevision: number;
  context: OrganizationContext;
  onClose(): void;
  /** 待办页：在清单里定位一个事项（todo_item 来源）。 */
  onOpenTodoItem?: ((key: string) => void) | undefined;
  /** 有已复盘决策时，点进原有方法论流程。 */
  onOpenMethodology?: (() => void) | undefined;
  /** 采纳、撤销等写入后，宿主重新读自己的数据。 */
  onChanged?: (() => void) | undefined;
  /** 有没存下的编辑时为 true：宿主据此别让一次误触的 Esc 把弹窗关掉。 */
  onDirtyChange?: ((dirty: boolean) => void) | undefined;
}

const errorText = (caught: unknown): string => (caught instanceof Error ? caught.message : String(caught));

const RESULT_TEXT: Record<SuggestionDecisionResult["status"], string> = {
  saved: "",
  revision_conflict: "这条建议刚刚有更新，已重新读取。你的编辑还在，核对后再操作。",
  stale: "来源已经变化，没有写入任何内容。你的编辑还在，请重新核对。",
  source_unavailable: "这次没能读到来源，没有写入任何内容；稍后再试。",
  busy: "这条建议正在处理，请稍候。",
  partially_applied: "只写入了一部分，下面逐步列出，没有写入的不会生效。",
  damaged: "整理记录读不出来，已停止写入。",
  not_allowed: "现在不能这样处理这条建议。",
  not_found: "这条建议已经不在了。",
};

const UNDO_TEXT: Record<SuggestionUndoResult["status"], string> = {
  saved: "",
  needs_review: "撤销前请先看恢复差异。",
  revision_conflict: "这条建议刚刚有更新，已重新读取，请再试一次。",
  source_unavailable: "这次没能读到来源，没有恢复任何内容。",
  not_allowed: "现在不能撤销。",
  not_found: "这条建议已经不在了。",
  damaged: "整理记录读不出来，已停止写入。",
  partially_applied: "只恢复了一部分，下面逐步列出。",
};

export const OrganizationPanel = ({ api, organizationRevision, context, onClose, onOpenTodoItem, onOpenMethodology, onChanged, onDirtyChange }: OrganizationPanelProps) => {
  const headingId = useId();
  const [project, setProject] = useState<string | null>(null);
  const [source, setSource] = useState<(typeof organizationSourceKindSchema.options)[number] | "">("");
  const [chosenScope, setChosenScope] = useState<OrganizationScope>("all");
  const scope = chosenScope;
  const scopes: OrganizationScope[] = ["all", ...(project === null ? [] : ["project" as const]), ...(context.listId === null ? [] : ["list" as const]), ...(context.items.length === 0 ? [] : ["selection" as const])];
  const query: OrganizationQuery = useMemo(() => ({
    project: scope === "all" ? null : scope === "list" || scope === "selection" ? context.project : project,
    scope,
    ...(scope === "list" ? { listId: context.listId! } : {}),
    ...(scope === "selection" ? { items: [...context.items] } : {}),
    ...(source === "" ? {} : { source }),
  }), [scope, project, source, context.project, context.items, context.listId]);
  const queryKey = JSON.stringify(query);

  // 每份快照记着它是为哪个范围读的：范围换了、新快照还没到，旧范围的建议不显示也不能操作。
  const [stored, setStored] = useState<{ key: string; data: OrganizationSnapshot } | null>(null);
  const snapshot = stored !== null && stored.key === queryKey ? stored.data : null;
  const storedRef = useRef(stored);
  storedRef.current = stored;
  const [loadError, setLoadError] = useState<string | null>(null);
  const [tab, setTab] = useState<OrganizationTab>("overview");
  const [page, setPage] = useState<"suggestions" | "status">("suggestions");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busy, setBusy] = useState<ReadonlySet<string>>(() => new Set());
  const [notices, setNotices] = useState<Readonly<Record<string, Notice>>>({});
  const [flash, setFlash] = useState<Notice | null>(null);
  const [profiles, setProfiles] = useState<RedactedModelProviderProfile[]>([]);
  const [profilesError, setProfilesError] = useState<string | null>(null);
  // 用户编辑过、还没采纳的内容：离开、重新读取、冲突都不丢。
  const [edits, setEdits] = useState<Readonly<Record<string, SuggestionDraft>>>({});
  const editsRef = useRef(edits);
  editsRef.current = edits;
  const generation = useRef(0);
  // 同步的占用表：连点两次、批量与单条同时点，第二个在 React 重渲染前就被挡住。
  const busyRef = useRef(new Set<string>());
  const queryRef = useRef(query);
  queryRef.current = query;

  const dirty = Object.keys(edits).length > 0;
  useEffect(() => { onDirtyChange?.(dirty); }, [dirty]); // eslint-disable-line react-hooks/exhaustive-deps

  // 把没存的编辑存成草稿：存不上的留在本页，并说明；不丢、不拿旧修订去硬写。
  const flushEdits = async (): Promise<boolean> => {
    const views = storedRef.current?.data.suggestions ?? [];
    let ok = true;
    for (const [id, draft] of Object.entries(editsRef.current)) {
      const view = views.find((candidate) => candidate.id === id);
      if (view === undefined || busyRef.current.has(id)) { ok = ok && view === undefined; continue; }
      busyRef.current.add(id);
      try {
        const result = await api.saveSuggestionDraft({ id, expectedRevision: view.revision, draft });
        if (result.status === "saved") setEdits((current) => { const { [id]: _saved, ...rest } = current; return rest; });
        else { ok = false; setFlash({ tone: "error", text: `「${view.title}」的草稿没存上（${result.message ?? RESULT_TEXT[result.status]}），仍保留在这一页。` }); }
      } catch (caught) {
        ok = false;
        setFlash({ tone: "error", text: `「${view.title}」的草稿没存上：${errorText(caught)}，仍保留在这一页。` });
      } finally { busyRef.current.delete(id); }
    }
    return ok;
  };
  // 范围换了（项目、清单、勾选变了）：旧范围里没存的编辑先存草稿，再读新范围。
  useEffect(() => { void flushEdits(); }, [queryKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const close = (): void => { void flushEdits().then((saved) => { if (saved) onClose(); else setFlash((current) => current ?? { tone: "error", text: "还有没存下的编辑，先不关闭；处理后再关，或点「保存草稿」。" }); }); };

  const load = useCallback(async (): Promise<OrganizationSnapshot | null> => {
    const asked = queryRef.current;
    if (asked === null) { setStored(null); return null; }
    const token = ++generation.current;
    try {
      const next = await api.getOrganization(asked);
      if (token !== generation.current) return null;
      setStored({ key: JSON.stringify(asked), data: next });
      setLoadError(null);
      return next;
    } catch (caught) {
      if (token === generation.current) setLoadError(errorText(caught));
      return null;
    }
  }, [api]);

  useEffect(() => { void load(); }, [load, queryKey, organizationRevision]);
  // 一轮在进行时，进度由本面板自己读；用不着等主进程推送。
  const running = snapshot?.activeRun !== null && snapshot?.activeRun !== undefined && ACTIVE_STATES.includes(snapshot.activeRun.state);
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => void load(), 2_000);
    return () => clearInterval(timer);
  }, [running, load]);
  useEffect(() => {
    let alive = true;
    api.listModelProviderProfiles().then(
      (list) => { if (alive) setProfiles(list.filter((profile) => profile.enabled && modelKindSupportsGeneration(profile.kind))); },
      (caught: unknown) => { if (alive) setProfilesError(errorText(caught)); },
    );
    return () => { alive = false; };
  }, [api]);

  const suggestions = snapshot?.suggestions ?? [];
  const listed = (view: SuggestionView): boolean => view.state === "pending" || view.state === "applying" || view.state === "partially_applied";
  const inTab = suggestions.filter((view) => !view.redacted && (tab === "overview" ? view.state === "applied" : tab === "conflict" ? view.type === "judgment" && view.stale === null && listed(view) : tab === "memory" ? view.type === "experience" && !suggestions.some((other) => other.revises === view.id && other.state === "applied" && !other.redacted) : view.tab === "todo"));
  const handledHere = (snapshot?.handled ?? []).filter((item) => item.state !== "applied" && (tab === "overview" || item.tab === tab));
  const selected = inTab.find((view) => view.id === selectedId) ?? null;
  const damaged = snapshot?.damaged ?? null;

  // 选中的建议不在了（处理掉了）就落到同页签的下一条，别让详情空着或指到别页签。
  useEffect(() => {
    if (snapshot === null) return;
    const current = inTab.find((view) => view.id === selectedId);
    if (current !== undefined && (tab === "overview" || current.tab === tab)) return;
    setSelectedId(inTab[0]?.id ?? null);
  }, [snapshot, tab, selectedId]); // eslint-disable-line react-hooks/exhaustive-deps
  const setNotice = (id: string, notice: Notice | null): void => setNotices((current) => {
    const { [id]: _gone, ...rest } = current;
    return notice === null ? rest : { ...rest, [id]: notice };
  });
  const withBusy = async (id: string, work: () => Promise<void>): Promise<void> => {
    if (busyRef.current.has(id)) return;
    busyRef.current.add(id);
    setBusy((current) => new Set(current).add(id));
    try { await work(); } catch (caught) { setNotice(id, { tone: "error", text: errorText(caught) }); } finally {
      busyRef.current.delete(id);
      setBusy((current) => { const next = new Set(current); next.delete(id); return next; });
    }
  };

  const decided = async (view: SuggestionView, result: SuggestionDecisionResult, done: string): Promise<boolean> => {
    const ok = result.status === "saved";
    setNotice(view.id, ok ? (done === "" ? null : { tone: "ok", text: done }) : { tone: result.status === "partially_applied" ? "warn" : "error", text: result.message ?? RESULT_TEXT[result.status] });
    await load();
    onChanged?.();
    return ok;
  };

  const saveEdit = async (view: SuggestionView): Promise<void> => {
    const draft = editsRef.current[view.id];
    if (draft === undefined) return;
    await withBusy(view.id, async () => {
      const result = await api.saveSuggestionDraft({ id: view.id, expectedRevision: view.revision, draft });
      if (result.status === "saved") {
        setEdits((current) => { const { [view.id]: _kept, ...rest } = current; return rest; });
        setNotice(view.id, { tone: "ok", text: "草稿已保存，重新整理不会覆盖。" });
        await load();
      } else await decided(view, result, "");
    });
  };

  const actions: DetailActions = {
    edits,
    setEdit: (id, draft) => setEdits((current) => {
      if (draft === null) { const { [id]: _gone, ...rest } = current; return rest; }
      return { ...current, [id]: draft };
    }),
    saveEdit,
    adopt: (view, choice) => withBusy(view.id, async () => {
      const draft = editsRef.current[view.id] ?? view.draft ?? undefined;
      const result = await api.decideSuggestion({
        id: view.id, expectedRevision: view.revision, expectedEvidenceVersion: view.evidenceVersion, action: "adopt",
        ...(draft === undefined ? {} : { draft }), ...(choice === undefined ? {} : { choice }),
      });
      if (result.suggestion !== null) setSelectedId(result.suggestion.id);
      if (await decided(view, result, choice === "hold" ? "已保留待判断，有新证据时再提示。" : "已保存。")) {
        setEdits((current) => { const { [view.id]: _gone, ...rest } = current; return rest; });
      }
    }),
    defer: (view, day) => withBusy(view.id, async () => {
      const result = await api.decideSuggestion({ id: view.id, expectedRevision: view.revision, expectedEvidenceVersion: view.evidenceVersion, action: "defer", deferUntil: day });
      await decided(view, result, `已稍后：${shortDate(day)}再提示，之前不会出现。`);
    }),
    reject: (view) => withBusy(view.id, async () => {
      const result = await api.decideSuggestion({ id: view.id, expectedRevision: view.revision, expectedEvidenceVersion: view.evidenceVersion, action: "reject" });
      await decided(view, result, "已不采纳，同样的问题不会再提示；有实质新证据时会说明原因再出现。");
    }),
    undo: (view, diffHash) => withBusy(view.id, async () => {
      const result = await api.undoSuggestion({ id: view.id, expectedRevision: view.revision, ...(diffHash === undefined ? {} : { expectedDiffHash: diffHash }) });
      if (result.status === "needs_review") { setNotice(view.id, { tone: "warn", text: result.message ?? UNDO_TEXT.needs_review, undo: result }); return; }
      setNotice(view.id, result.status === "saved" ? { tone: "ok", text: "已撤销。" } : { tone: result.status === "partially_applied" ? "warn" : "error", text: result.message ?? UNDO_TEXT[result.status] });
      await load();
      onChanged?.();
    }),
    regenerate: (view, profileId) => withBusy(view.id, async () => {
      const result = await api.regenerateSuggestion({ id: view.id, profileId });
      setNotice(view.id, result.status === "started" ? { tone: "ok", text: "已开始重新整理，你的草稿不会被覆盖。" } : { tone: "error", text: runResultText(result.status) });
      await load();
    }),
    openSource: (key, relativePath) => {
      if (relativePath !== null) {
        api.openVaultDocument(relativePath).catch((caught: unknown) => setFlash({ tone: "error", text: `没能打开原文：${errorText(caught)}` }));
      } else if (key.startsWith("todo_item:") && onOpenTodoItem !== undefined) onOpenTodoItem(key);
    },
    canOpen: (key, relativePath) => relativePath !== null || (key.startsWith("todo_item:") && onOpenTodoItem !== undefined),
    notices,
    busy,
    profiles,
    readOnly: damaged !== null,
  };

  const reopen = async (item: HandledSuggestionView): Promise<void> => {
    await withBusy(item.id, async () => {
      const result = await api.decideSuggestion({ id: item.id, expectedRevision: item.revision, expectedEvidenceVersion: item.evidenceVersion, action: "reopen" });
      setFlash(result.status === "saved" ? { tone: "ok", text: "已重新打开。" } : { tone: "error", text: result.message ?? RESULT_TEXT[result.status] });
      await load();
      if (result.status === "saved") setSelectedId(item.id);
    });
  };

  const changeTab = async (next: OrganizationTab): Promise<void> => {
    // 离开时把没保存的编辑存成草稿；存不了就留在原页，不吞输入。
    if (selected !== null && editsRef.current[selected.id] !== undefined && selected.tab !== next) await saveEdit(selected);
    setTab(next);
    setPage("suggestions");
  };

  const counts = snapshot?.counts ?? { todo: 0, memory: 0, conflict: 0, pending: 0 };
  const scopeLabel: Record<OrganizationScope, string> = { all: "全部已授权内容", selection: `所选 ${context.items.length} 条事项`, list: context.listTitle ?? "当前清单", project: "当前项目" };
  const activeRun = snapshot?.activeRun ?? null;

  const automatic = snapshot?.settings.automatic === true;
  const active = automatic && snapshot?.settings.background === true;
  const questions = suggestions.filter((view) => view.type === "judgment" && view.stale === null && listed(view));
  const stats = snapshot?.maintenance;
  const open = (view: SuggestionView) => { setTab(view.tab); setSelectedId(view.id); };
  const nav = [...TAB_ORDER, "status"] as const;
  return (
    <section className="org-panel" role="region" aria-labelledby={headingId} onKeyDown={(event) => { if (event.key === "Escape" && !event.defaultPrevented && event.target instanceof Element && event.target.closest("input, textarea, select") === null) { event.preventDefault(); close(); } }}>
      <header className="org-header"><h2 id={headingId}>整理与记忆</h2><p className="org-last-run" role="status">{snapshot === null ? "正在读取…" : runSummary(activeRun ?? snapshot.run)}</p><button type="button" className="icon-button org-icon" aria-label="关闭整理" onClick={close}><ActionIcon name="close" /></button></header>
      <div className="org-tabs" role="tablist" aria-label="整理类别">
        {nav.map((item) => <button key={item} type="button" role="tab" id={`org-tab-${item}`} aria-selected={item === "status" ? page === "status" : page !== "status" && tab === item} aria-controls="org-body" className="org-tab"
          tabIndex={(item === "status" ? page === "status" : page !== "status" && tab === item) ? 0 : -1}
          onClick={() => item === "status" ? setPage("status") : void changeTab(item)} onKeyDown={(event) => {
            if (!["ArrowRight", "ArrowLeft", "Home", "End"].includes(event.key)) return;
            event.preventDefault();
            const at = event.key === "Home" ? 0 : event.key === "End" ? nav.length - 1 : (nav.indexOf(item) + (event.key === "ArrowRight" ? 1 : nav.length - 1)) % nav.length;
            const next = nav[at]!;
            if (next === "status") setPage("status"); else void changeTab(next);
            queueMicrotask(() => document.getElementById(`org-tab-${next}`)?.focus());
          }}>{item === "status" ? "设置与状态" : TAB_LABEL[item]}{item === "conflict" && counts.pending > 0 ? <span className="org-count">{counts.pending}</span> : null}</button>)}
      </div>
      <div className="org-maintenance-toolbar">
        <span className={`org-badge${active ? " org-badge-ok" : ""}`}>{active ? "自动维护已开启" : automatic ? "自动维护已暂停" : "尚未开启自动维护"}</span>
        <label className="org-field">范围<select aria-label="范围" value={scope} onChange={(event) => setChosenScope(event.currentTarget.value as OrganizationScope)}>{scopes.map((item) => <option key={item} value={item}>{scopeLabel[item]}</option>)}</select></label>
        <label className="org-field">项目<select aria-label="项目" value={project ?? ""} onChange={(event) => { setProject(event.currentTarget.value || null); setChosenScope(event.currentTarget.value ? "project" : "all"); }}><option value="">全部</option>{[...new Set([...(context.project === null ? [] : [context.project]), ...context.projects, ...(snapshot?.projects ?? [])])].map((name) => <option key={name}>{name}</option>)}</select></label>
        <label className="org-field">来源<select aria-label="来源" value={source} onChange={(event) => setSource(event.currentTarget.value as typeof source)}><option value="">全部</option>{organizationSourceKindSchema.options.map((kind) => <option key={kind} value={kind}>{SOURCE_KIND_LABEL[kind]}</option>)}</select></label>
        <span className="org-muted">有新内容时，空闲后继续</span>
      </div>
      {damaged === null ? null : <p className="org-banner org-banner-error" role="alert">{damaged}</p>}
      {loadError === null ? null : <p className="org-banner org-banner-error" role="alert">读取失败：{loadError}<button type="button" className="text-button" onClick={() => void load()}>重试读取</button></p>}
      {snapshot !== null && !snapshot.coverage.complete ? <p className="org-banner org-banner-warn" role="status">部分来源暂不可读，相关记忆暂停使用；原记录保留，后续会重试。</p> : null}
      {flash === null ? null : <p className={`org-banner org-banner-${flash.tone}`} role={flash.tone === "error" ? "alert" : "status"}>{flash.text}</p>}
      {suggestions.length === 500 ? <p className="org-note">正在显示最近 500 条记录；可按项目、来源缩小范围，更早的记忆仍保留在资料库中。</p> : null}
      <div id="org-body" role="tabpanel" aria-labelledby={`org-tab-${page === "status" ? "status" : tab}`} className="org-maintenance-content">
      {page === "status" ? <OrganizationStatus api={api} snapshot={snapshot} query={query} scopeText={scopeLabel[scope]} profiles={profiles} profilesError={profilesError} readOnly={damaged !== null} reload={load} onBack={() => setPage("suggestions")} onViewSuggestions={() => setPage("suggestions")} /> : tab === "overview" ? <>
        {!automatic ? <div className="org-banner org-banner-accent"><strong>设置一次，之后自动维护</strong><p>选择来源、模型和每轮预算。常规整理自动完成，只有真正影响当前行动的取舍才交给你。</p><button type="button" className="primary-button" onClick={() => setPage("status")}>设置自动维护</button></div> : null}
        <div className="org-metrics"><div><span>当前范围</span><strong>{stats?.inputs ?? 0} <small>条来源记录</small></strong><p>全局查看，按项目维护</p></div><div><span>自动更新</span><strong>{stats?.automaticUpdates ?? 0} <small>处</small></strong><p>可查看、纠正和回退</p></div><div><span>需要你判断</span><strong>{questions.length} <small>个问题</small></strong><p>{questions.length === 0 ? "当前没有需要你判断的事项" : "只保留影响当前行动的取舍"}</p></div></div>
        <div className="org-overview-grid"><section className="org-card"><h3>最近自动更新</h3>{inTab.length === 0 ? <p className="org-muted">{active ? "等待新增或变化的内容，空闲后自动检查。" : "完成设置后，自动更新会显示在这里。"}</p> : <ul className="org-update-list">{inTab.slice().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 12).map((view) => <li key={view.id}><span className="org-badge">{TYPE_LABEL[view.type]}</span><div><strong>{view.title}</strong><p className="org-muted">{view.sources[0]?.label} · {view.stale === null ? view.content?.type === "triage" ? view.content.explanation : "已生效" : "来源变化，暂停使用"}</p></div><button type="button" className="text-button" onClick={() => open(view)}>查看</button></li>)}</ul>}</section>
        <aside><section className="org-card"><h3>需要你判断</h3>{questions.length === 0 ? <p>当前没有需要你判断的事项。{active ? "自动维护仍在继续。" : ""}</p> : questions.slice(0, 3).map((view) => <div key={view.id}><strong>{view.title}</strong><p>{view.why}</p><button type="button" className="secondary-button" onClick={() => open(view)}>查看并选择</button></div>)}</section><section className="org-card"><h3>安静保留，不催你</h3><p>保留未知 {stats?.unknown ?? 0} 项，等待后续证据 {stats?.waiting ?? 0} 项。有新证据时再自动更新。</p><button type="button" className="text-button" onClick={() => void changeTab("todo")}>查看待处理</button></section></aside></div>
      </> : <div className="org-body"><div className="org-list"><div className="org-list-head">{inTab.length} 条{tab === "conflict" ? "问题" : "记录"}</div>{inTab.length === 0 ? <p className="org-empty">{tab === "conflict" ? "当前没有需要你判断的事项。自动维护无需逐条确认。" : "暂无记录；新增和变化的内容会在维护时检查。"}</p> : null}<ul aria-label={`${TAB_LABEL[tab]}记录`}>{inTab.map((view) => <li key={view.id}><button type="button" className="org-row-main" data-org-row={view.id} aria-pressed={selectedId === view.id} onClick={() => setSelectedId(view.id)}><strong>{view.title}</strong><span className="org-muted">{TYPE_LABEL[view.type]} · {view.automatic && view.state === "applied" ? "已自动更新" : STATE_LABEL[view.state]}</span></button></li>)}</ul>
        {handledHere.length === 0 ? null : <details className="org-handled"><summary>已处理记录与回退 {handledHere.length}</summary>{handledHere.map((item) => <div key={item.id}><span>{item.title} · {STATE_LABEL[item.state]}</span><button type="button" className="text-button" onClick={() => void reopen(item)}>重新打开</button></div>)}</details>}
        </div><div className="org-detail">{selected === null ? <p className="org-empty">选择一条查看来源、边界和处理记录。</p> : <SuggestionDetail key={selected.id} view={selected} actions={actions} versions={suggestions.filter((entry) => entry.id !== selected.id && entry.id.split("~r")[0] === selected.id.split("~r")[0])} />}</div></div>}
      </div>
    </section>
  );
};
