import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Diff, Hunk, Decoration, getChangeKey, findChangeByNewLineNumber, type ChangeData } from "react-diff-view";
import "react-diff-view/style/index.css";
import { modelKindSupportsGeneration } from "@cognelis/decision-protocol";
import type { LocalReviewAction, LocalReviewExecution, LocalReviewFiles, LocalReviewGroup, LocalReviewJob, LocalReviewReference, LocalReviewSettings, LocalReviewState, RedactedModelProviderProfile } from "@cognelis/decision-protocol";
import type { DecisionApi } from "../../../../shared/renderer-api.js";
import { IconButton, ActionIcon } from "../../IconButton.js";
import { ListWidthHandle } from "../../ListWidthHandle.js";
import { ReviewFileDirectory } from "../../ReviewFileDirectory.js";
import { ReviewFileLines } from "../../ReviewFileLines.js";
import { parsePrFileDiffs, visibleDiffHunks } from "../pr-review/pr-diff-view.js";
import { ModalDialog } from "../../ModalDialog.js";
import { LocalReviewTasks } from "./LocalReviewTasks.js";
import { InlineReviewEditor, type ReviewDraft } from "./InlineReviewEditor.js";
import type { ConversationActionInput } from "./LocalReviewConversation.js";
import { emptyDraft, executionAuthorization, insertQuote, quoteBlock, sendableReferences, type ConversationDraft } from "./conversation-model.js";
import "./local-review.css";

const chatDraftKey = (id: string) => `paraself.local-review.chat.${id}`;
const errorText = (error: unknown) => error instanceof Error ? error.message : "操作失败。";
const lineOf = (change: ChangeData, side: "old" | "new") => change.type === "normal" ? side === "old" ? change.oldLineNumber : change.newLineNumber : (change.type === "insert" && side === "new") || (change.type === "delete" && side === "old") ? change.lineNumber : null;

export function LocalReviewPanel({ api, hidden = false, openJobId }: { api: DecisionApi; hidden?: boolean; openJobId?: string | null | undefined }) {
  const [data, setData] = useState<LocalReviewState | null>(null), [error, setError] = useState(""), [busy, setBusy] = useState(false);
  const [repositoryId, setRepositoryId] = useState(""), [sessionId, setSessionId] = useState(""), [jobId, setJobId] = useState<string | null>(null);
  const [files, setFiles] = useState<LocalReviewFiles | null>(null), [path, setPath] = useState(""), [content, setContent] = useState<string | null>(null), [fileError, setFileError] = useState("");
  const [view, setView] = useState<"file" | "diff">("file"), [side, setSide] = useState<"old" | "new">("new");
  const [draft, setDraft] = useState<ReviewDraft | null>(null), editorRef = useRef<HTMLTextAreaElement>(null);
  const [tab, setTab] = useState<"review" | "tasks">("review"), [settingsOpen, setSettingsOpen] = useState(false);
  const [filesCollapsed, setFilesCollapsed] = useState(false), [notesCollapsed, setNotesCollapsed] = useState(() => window.matchMedia?.("(max-width: 1350px)").matches === true);
  const [mode, setMode] = useState<"split" | "unified">("split");
  const [models, setModels] = useState<RedactedModelProviderProfile[]>([]), [profileId, setProfileId] = useState("");
  const [settings, setSettings] = useState<LocalReviewSettings>({ worker: "codex", pushRemote: "origin", baseBranch: "main", reviewers: [] }), [baseInput, setBaseInput] = useState("");
  const dependencies = settings.dependencies ?? { mode: "auto" as const, argv: [], files: [], allowScripts: true };
  const availableModels = useMemo(() => models.filter(profile => settings.worker === "pi" || (settings.worker === "codex" ? profile.kind === "codex-cli" : profile.kind === "claude-code-cli")), [models, settings.worker]);
  useEffect(() => { setProfileId(current => availableModels.some(profile => profile.profileId === current) ? current : availableModels[0]?.profileId ?? ""); }, [availableModels]);
  const handledNavigation = useRef<string | null>(null);
  const [reviewersText, setReviewersText] = useState("");
  const [approval, setApproval] = useState<{ job: LocalReviewJob; group: LocalReviewGroup } | null>(null), [diffLimit, setDiffLimit] = useState(2000);
  const [executionApproval, setExecutionApproval] = useState<{ job: LocalReviewJob; execution: LocalReviewExecution } | null>(null);
  const [chatDrafts, setChatDrafts] = useState<Record<string, ConversationDraft>>({}), [sendingJob, setSendingJob] = useState(""), [chatError, setChatError] = useState("");
  const composerRef = useRef<HTMLTextAreaElement>(null), pendingCaret = useRef<number | null>(null), sendingRef = useRef(false), draftsRef = useRef(chatDrafts);
  draftsRef.current = chatDrafts;
  const chatDraft = useCallback((id: string): ConversationDraft => {
    const known = draftsRef.current[id]; if (known) return known;
    try { const saved = JSON.parse(localStorage.getItem(chatDraftKey(id)) ?? "null"); if (saved && typeof saved.body === "string") return { body: saved.body, references: Array.isArray(saved.references) ? saved.references.filter((r: unknown): r is ConversationDraft["references"][number] => !!r && typeof r === "object" && ((r as { kind?: unknown }).kind === "annotation" || (r as { kind?: unknown }).kind === "group") && typeof (r as { id?: unknown }).id === "string" && typeof (r as { token?: unknown }).token === "string") : [] }; } catch { /* A broken saved draft is simply not restored. */ }
    return emptyDraft;
  }, []);
  const setChatDraft = useCallback((id: string, next: ConversationDraft) => {
    setChatDrafts(current => ({ ...current, [id]: next }));
    try { if (next.body) localStorage.setItem(chatDraftKey(id), JSON.stringify(next)); else localStorage.removeItem(chatDraftKey(id)); } catch { /* The in-memory draft still holds the text. */ }
  }, []);
  useEffect(() => { if (pendingCaret.current === null) return; const caret = pendingCaret.current; pendingCaret.current = null; const element = composerRef.current; if (element) { element.focus(); element.setSelectionRange?.(caret, caret); } });
  const repository = data?.repositories.find(r => r.id === repositoryId), session = data?.sessions.find(s => s.id === sessionId && s.repositoryId === repositoryId);
  const refresh = useCallback(async () => {
    const next = await api.getLocalReviewState(); setData(next);
    setRepositoryId(current => next.repositories.some(r => r.id === current) ? current : next.repositories[0]?.id ?? "");
  }, [api]);
  useEffect(() => {
    if (hidden) return;
    let disposed = false;
    void refresh().catch(e => { if (!disposed) setError(errorText(e)); });
    const timer = setInterval(() => { void refresh().catch(e => { if (!disposed) setError(errorText(e)); }); }, 2000);
    void api.listModelProviderProfiles().then(values => { if (disposed) return; const available = values.filter(p => p.enabled && modelKindSupportsGeneration(p.kind)); setModels(available); setProfileId(current => current || available[0]?.profileId || ""); }).catch(e => setError(errorText(e)));
    return () => { disposed = true; clearInterval(timer); };
  }, [api, hidden, refresh]);
  useEffect(() => { if (openJobId && handledNavigation.current !== openJobId && data?.jobs.some(j => j.id === openJobId)) { const job = data.jobs.find(j => j.id === openJobId)!; handledNavigation.current = openJobId; setRepositoryId(job.repositoryId); setJobId(job.id); setTab("tasks"); } }, [openJobId, data]);
  useEffect(() => {
    if (!data) return;
    const sessions = data.sessions.filter(s => s.repositoryId === repositoryId);
    setSessionId(current => sessions.some(s => s.id === current) ? current : sessions.at(-1)?.id ?? "");
  }, [repositoryId, data]);
  useEffect(() => {
    const resize = () => { if (window.innerWidth <= 1350) setNotesCollapsed(true); };
    window.addEventListener("resize", resize); return () => window.removeEventListener("resize", resize);
  }, []);
  const savedSettings = JSON.stringify(repository?.settings);
  useEffect(() => { if (repository) { setSettings(repository.settings); setReviewersText(repository.settings.reviewers.join(", ")); } }, [repositoryId, savedSettings]);
  useEffect(() => {
    if (!sessionId || !repositoryId || hidden) return;
    let disposed = false; setFiles(null);
    void api.loadLocalReviewFiles({ repositoryId, sessionId }).then(result => { if (!disposed) { setFiles(result); setPath(current => result.files.some(f => f.path === current) ? current : result.files[0]?.path ?? ""); } }).catch(e => { if (!disposed) setFileError(errorText(e)); });
    return () => { disposed = true; };
  }, [api, repositoryId, sessionId, savedSettings, hidden]);
  const diffs = useMemo(() => { try { return { files: parsePrFileDiffs(files?.diff ?? ""), error: "" }; } catch (e) { return { files: [], error: errorText(e) }; } }, [files?.diff]);
  const diff = diffs.files.find(f => f.newPath === path || f.oldPath === path), effectivePath = side === "old" && diff ? diff.oldPath : path;
  const entries = useMemo(() => {
    const paths = new Map((files?.files ?? []).filter(f => f.type === "blob").map(f => [f.path, { path: f.path, status: "tracked" }]));
    for (const file of diffs.files) for (const value of [file.oldPath, file.newPath]) if (value && value !== "/dev/null") paths.set(value, { path: value, status: file.type });
    return [...paths.values()];
  }, [files, diffs]);
  useEffect(() => {
    if (!sessionId || !repositoryId || !effectivePath || effectivePath === "/dev/null" || hidden) return;
    let disposed = false; setContent(null); setFileError("");
    void api.readLocalReviewFile({ repositoryId, sessionId, path: effectivePath, side }).then(value => { if (!disposed) setContent(value); }).catch(e => { if (!disposed) setFileError(errorText(e)); });
    return () => { disposed = true; };
  }, [api, repositoryId, sessionId, effectivePath, side, hidden]);
  useEffect(() => {
    setDraft(null);
    try {
      const saved = JSON.parse(localStorage.getItem(`paraself.local-review.${sessionId}`) ?? "null");
      if (saved && typeof saved.body === "string" && saved.body && typeof saved.path === "string") {
        const restored: ReviewDraft = { sessionId, path: saved.path, side: saved.side === "old" ? "old" : "new", startLine: saved.startLine ?? saved.start ?? 1, endLine: saved.endLine ?? saved.end ?? 1, anchor: saved.anchor ?? saved.startLine ?? saved.start ?? 1, body: saved.body, initialBody: saved.initialBody ?? "", view: saved.side === "old" || saved.view === "diff" ? "diff" : "file", ...(saved.annotationId ? { annotationId: saved.annotationId } : {}) };
        setDraft(restored); setPath(restored.path); setSide(restored.side); setView(restored.view);
      }
    } catch { /* Invalid local UI drafts do not prevent loading saved annotations. */ }
  }, [sessionId]);
  useEffect(() => {
    if (!sessionId || draft && draft.sessionId !== sessionId) return;
    const timer = setTimeout(() => { try { if (draft) localStorage.setItem(`paraself.local-review.${sessionId}`, JSON.stringify(draft)); else localStorage.removeItem(`paraself.local-review.${sessionId}`); } catch { /* The open editor still retains its text. */ } }, 300);
    return () => clearTimeout(timer);
  }, [sessionId, draft]);
  async function perform(work: () => Promise<unknown>) { if (busy) return; setBusy(true); setError(""); try { await work(); await refresh(); } catch (e) { setError(errorText(e)); } finally { setBusy(false); } }
  const dirty = draft !== null && draft.body !== draft.initialBody;
  function focusDraft() {
    if (!draft) return;
    setTab("review"); setPath(draft.path); setSide(draft.side); setView(draft.view);
    queueMicrotask(() => { editorRef.current?.focus(); editorRef.current?.scrollIntoView?.({ block: "center" }); });
  }
  function navigate(work: () => void) { if (busy) return; if (dirty) { focusDraft(); return; } setDraft(null); work(); }
  function selectLine(line: number, extend = false, newSide = side) {
    if (busy) return;
    const selectedPath = newSide === "old" && diff ? diff.oldPath : path;
    if (extend && draft && draft.path === selectedPath && draft.side === newSide) {
      setDraft({ ...draft, startLine: Math.min(draft.anchor, line), endLine: Math.max(draft.anchor, line) }); return;
    }
    if (dirty) { focusDraft(); return; }
    setSide(newSide); setDraft({ sessionId, view, path: selectedPath, side: newSide, startLine: line, endLine: line, anchor: line, body: "", initialBody: "" });
  }
  const annotations = session?.annotations ?? [], counts = new Map<string, number>();
  type Annotation = typeof annotations[number];
  for (const a of annotations) counts.set(a.path, (counts.get(a.path) ?? 0) + 1);
  function edit(a: Annotation) {
    if (busy) return;
    if (dirty) { focusDraft(); return; }
    const inDiff = diff?.newPath === a.path && findChangeByNewLineNumber(diff.hunks, a.endLine);
    const nextView = a.side === "old" || view === "diff" && inDiff ? "diff" : "file";
    setTab("review"); setPath(a.path); setSide(a.side); setView(nextView); setDiffLimit(Math.max(2000, a.endLine * 2));
    setDraft({ sessionId, view: nextView, path: a.path, side: a.side, startLine: a.startLine, endLine: a.endLine, anchor: a.startLine, body: a.body, initialBody: a.body, annotationId: a.id });
  }
  function saveDraft() {
    if (!draft || !draft.body.trim()) return;
    const saving = draft;
    void perform(async () => { await api.saveLocalReviewAnnotation({ repositoryId, sessionId, path: saving.path, side: saving.side, startLine: saving.startLine, endLine: saving.endLine, body: saving.body, ...(saving.annotationId ? { annotationId: saving.annotationId } : {}) }); setDraft(null); });
  }
  function removeAnnotation(id: string) {
    void perform(async () => { await api.removeLocalReviewAnnotation({ repositoryId, sessionId, annotationId: id }); if (draft?.annotationId === id) setDraft(null); });
  }
  const matches = (noteSide: "old" | "new") => draft?.sessionId === sessionId && draft.side === noteSide && draft.path === (noteSide === "old" && diff ? diff.oldPath : path);
  const selected = (line: number, noteSide: "old" | "new") => !!(matches(noteSide) && draft && line >= draft.startLine && line <= draft.endLine);
  const note = (line: number, noteSide = side) => {
    const here = annotations.filter(a => a.path === (noteSide === "old" && diff ? diff.oldPath : path) && a.side === noteSide && a.endLine === line && a.id !== draft?.annotationId);
    const editing = matches(noteSide) && draft?.endLine === line;
    if (!here.length && !editing) return null;
    return <div className="local-review-line-notes" data-note-side={noteSide} data-note-line={line}>
      {here.map(a => <aside className="local-review-inline-note" key={a.id} aria-label={`意见 L${a.startLine}–${a.endLine}`}><header><strong>L{a.startLine}{a.startLine !== a.endLine ? `–${a.endLine}` : ""}</strong><span>{a.side === "old" ? "旧版本" : "新版本"}</span></header><p>{a.body}</p><div className="local-review-inline-actions"><button type="button" className="review-note-link" disabled={busy} onClick={() => edit(a)}>编辑意见</button><button type="button" className="review-note-link" disabled={busy} onClick={() => removeAnnotation(a.id)}>删除意见</button></div></aside>)}
      {editing && draft ? <InlineReviewEditor draft={draft} busy={busy} atLimit={annotations.length >= 50} editorRef={editorRef} onChange={body => setDraft(current => current ? { ...current, body } : null)} onSave={saveDraft} onCancel={() => setDraft(null)} /> : null}
    </div>;
  };
  const visible = visibleDiffHunks(diff?.hunks ?? [], diffLimit);
  const widgets: Record<string, ReactNode> = {};
  for (const hunk of visible) for (const change of hunk.changes) {
    const oldLine = lineOf(change, "old"), newLine = lineOf(change, "new"), before = oldLine ? note(oldLine, "old") : null, after = newLine ? note(newLine, "new") : null;
    if (before || after) widgets[getChangeKey(change)] = change.type === "normal" && mode === "split" ? <div className="local-review-widget-pair"><div>{before}</div><div>{after}</div></div> : <>{before}{after}</>;
  }
  const jobs = data?.jobs.filter(j => j.repositoryId === repositoryId).slice().reverse() ?? [];
  const runningCount = jobs.filter(job => ["queued", "evaluating", "running_groups"].includes(job.state)).length;
  const attentionCount = jobs.filter(job => ["failed", "interrupted"].includes(job.state) || job.groups.some(group => ["blocked", "failed", "interrupted", "pushed_no_pr"].includes(group.state))).length;
  function quote(job: LocalReviewJob, reference: LocalReviewReference) {
    const block = quoteBlock(job, reference); if (!block) return;
    const current = chatDraft(job.id), element = composerRef.current;
    const result = insertQuote(current, block, reference, element && document.activeElement === element ? element.selectionStart : element?.selectionStart ?? null);
    pendingCaret.current = result.caret; setChatDraft(job.id, result.draft);
  }
  async function sendMessage(job: LocalReviewJob) {
    const sent = chatDraft(job.id), body = sent.body.trim(); if (!body || sendingRef.current) return;
    sendingRef.current = true; setSendingJob(job.id); setChatError("");
    try {
      await api.sendLocalReviewMessage({ repositoryId: job.repositoryId, jobId: job.id, body, references: sendableReferences(sent) });
      // Text typed while the request was in flight stays; only the sent draft is cleared.
      const now = draftsRef.current[job.id] ?? sent; if (now.body === sent.body) setChatDraft(job.id, emptyDraft);
      await refresh();
    } catch (e) { setChatError(errorText(e)); } finally { sendingRef.current = false; setSendingJob(""); }
  }
  const markRead = useCallback(async (job: LocalReviewJob, seq: number) => { await api.markLocalReviewRead({ repositoryId: job.repositoryId, jobId: job.id, seq }); await refresh(); }, [api, refresh]);
  const action = (job: LocalReviewJob, group: LocalReviewGroup | null, name: LocalReviewAction["action"]) => perform(() => api.actOnLocalReview({ repositoryId: job.repositoryId, jobId: job.id, ...(group ? { groupId: group.id } : {}), action: name }));
  return <section className="page-panel local-review-panel" hidden={hidden} aria-label="本地审阅">
    <header className="local-review-toolbar">
      <h1 tabIndex={-1}>本地审阅</h1>
      <button className="secondary-button" disabled={busy || dirty} onClick={() => void perform(async () => {
        const id = await api.chooseLocalReviewRepository(baseInput ? { baseBranch: baseInput } : {});
        if (id) { const next = await api.getLocalReviewState(); const selected = next.sessions.find(session => session.id === id); if (selected) setRepositoryId(selected.repositoryId); setSessionId(id); setJobId(null); setTab("review"); }
      })}>选择工程目录</button>
      <select aria-label="工程" value={repositoryId} disabled={busy || !data?.repositories.length} onChange={event => navigate(() => { setRepositoryId(event.target.value); setJobId(null); })}>
        {data?.repositories.length ? data.repositories.map(repository => <option key={repository.id} value={repository.id}>{repository.name}</option>) : <option value="">未选择工程</option>}
      </select>
      {session ? <span className="local-review-revision" title={`HEAD ${session.snapshot.headSha} · 基线 ${session.snapshot.baseSha}`}>HEAD {session.snapshot.headSha.slice(0, 8)} · 基线 {session.snapshot.baseSha.slice(0, 8)}</span> : null}
      {session?.snapshot.dirty ? <span className="local-review-dirty" title="工作区有未提交改动，不在审阅范围内">工作区有未提交改动，不在审阅范围内</span> : null}
      <button className="secondary-button local-review-settings-button" disabled={busy} onClick={() => setSettingsOpen(true)}>工程设置</button>
    </header>
    {error ? <p className="load-failure local-review-banner" role="alert">{error}</p> : null}
    {!data ? <p role="status">正在读取审阅草稿和任务…</p> : <>
      <div className="local-review-tabs" role="tablist" aria-label="本地审阅工作区" onKeyDown={event => {
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
        event.preventDefault(); const next = event.key === "Home" ? "review" : event.key === "End" ? "tasks" : tab === "review" ? "tasks" : "review";
        setTab(next); document.getElementById(next === "review" ? "local-review-review-tab" : "local-review-tasks-tab")?.focus();
      }}>
        <button role="tab" id="local-review-review-tab" aria-controls="local-review-review" tabIndex={tab === "review" ? 0 : -1} aria-selected={tab === "review"} onClick={() => setTab("review")}>审阅</button>
        <button role="tab" id="local-review-tasks-tab" aria-controls="local-review-background" tabIndex={tab === "tasks" ? 0 : -1} aria-selected={tab === "tasks"} onClick={() => setTab("tasks")}>后台任务（{jobs.length}）<span className="local-review-task-count" aria-live="polite">{runningCount ? `进行中 ${runningCount}` : attentionCount ? `待处理 ${attentionCount}` : jobs.length ? `已结束 ${jobs.length}` : ""}</span></button>
      </div>
      <section className="local-review-review" id="local-review-review" role="tabpanel" aria-labelledby="local-review-review-tab" hidden={tab !== "review"}>
        {repository && session ? <div className="local-review-workspace" data-files-collapsed={filesCollapsed} data-notes-collapsed={notesCollapsed}>
          <nav className="pr-diff-files local-review-directory" aria-label="工程文件">
            <header><h2 hidden={filesCollapsed}>文件</h2><IconButton className="local-review-panel-toggle" aria-label={filesCollapsed ? "展开文件树" : "收起文件树"} title={filesCollapsed ? "展开文件树" : "收起文件树"} aria-expanded={!filesCollapsed} aria-controls="local-review-files" onClick={() => setFilesCollapsed(value => !value)}><ActionIcon name="panel" /></IconButton></header>
            <div id="local-review-files" hidden={filesCollapsed}><ReviewFileDirectory countLabel="条意见" files={entries} selected={path} counts={counts} onSelect={value => navigate(() => { setPath(value); const deleted = entries.find(file => file.path === value)?.status === "delete"; setSide(deleted ? "old" : "new"); if (deleted) setView("diff"); setDiffLimit(2000); })} /></div>
          </nav>
          {!filesCollapsed ? <ListWidthHandle storageKey="paraself.local-review.file-list-width" label="调整文件栏宽度" controls="local-review-files" defaultWidth={300} maximumWidth={560} minContentWidth={420 + (notesCollapsed ? 36 : 280) + 8} /> : null}
          <section className="pr-diff-content" aria-label="审阅代码"><div className="pr-diff-toolbar"><strong title={path}>{path || "选择文件"}</strong><div className="pr-diff-modes"><button aria-pressed={view === "file"} disabled={diff?.type === "delete"} onClick={() => navigate(() => { setView("file"); setSide("new"); })}>文件</button><button aria-pressed={view === "diff"} onClick={() => navigate(() => setView("diff"))}>变更</button></div>{view === "diff" ? <div className="pr-diff-modes" role="group" aria-label="变更展示方式"><button aria-pressed={mode === "split"} onClick={() => setMode("split")}>并排</button><button aria-pressed={mode === "unified"} onClick={() => setMode("unified")}>单栏</button></div> : null}</div><div className="pr-diff-code local-review-code">
          {view === "file" ? fileError ? <p role="alert">{fileError}</p> : content === null ? <p role="status">正在读取固定提交内容…</p> : <ReviewFileLines key={`${path}:${side}`} content={content} focusLine={matches(side) ? draft?.endLine : undefined} selection={matches(side) && draft ? { start: draft.startLine, end: draft.endLine } : undefined} onSelect={selectLine} note={note} /> : diffs.error ? <p role="alert">{diffs.error}</p> : !diff || !diff.hunks.length ? <p className="pr-diff-notice">此文件没有文本变更；可在文件视图中标注意见。</p> : <>
            <Diff viewType={mode} className="local-review-diff" codeEvents={{ onClick: ({ change, side: clickedSide }, event) => { if (!change) return; const targetSide = clickedSide ?? (change.type === "delete" ? "old" : "new"), line = lineOf(change, targetSide); if (line) selectLine(line, event.shiftKey, targetSide); } }} diffType={diff.type} hunks={visible} widgets={widgets} renderGutter={({ change, side: gutterSide, renderDefault }) => { const line = change ? lineOf(change, gutterSide) : null; return line ? <div className="local-review-diff-gutter"><button data-side={gutterSide} data-selected={selected(line, gutterSide) ? "" : undefined} className="local-review-gutter" aria-label={`标注${gutterSide === "old" ? "旧" : "新"}版本第 ${line} 行`} onClick={event => selectLine(line, event.shiftKey, gutterSide)}>{line}</button><button className="local-review-add" aria-label={`在${gutterSide === "old" ? "旧" : "新"}版本第 ${line} 行新增意见`} onClick={event => selectLine(line, event.shiftKey, gutterSide)}>+</button></div> : renderDefault(); }}>{hunks => hunks.map((hunk, index) => <Fragment key={index}><Decoration>{hunk.content}</Decoration><Hunk hunk={hunk} /></Fragment>)}</Diff>
            {(diff.hunks.reduce((n, h) => n + h.changes.length, 0) > diffLimit) ? <button className="secondary-button" onClick={() => setDiffLimit(n => n + 2000)}>显示更多变更</button> : null}
          </>}
        </div><p className="pr-diff-footnote">点击行号或 + 写意见，Shift 连选。</p></section>
          <aside className="local-review-opinions" aria-label="意见">
            <header><h2 hidden={notesCollapsed}>意见 <small>{annotations.length}/50</small></h2><IconButton className="local-review-panel-toggle local-review-panel-toggle-right" aria-label={notesCollapsed ? "展开意见栏" : "收起意见栏"} title={notesCollapsed ? "展开意见栏" : "收起意见栏"} aria-expanded={!notesCollapsed} aria-controls="local-review-opinion-content" onClick={() => setNotesCollapsed(value => !value)}><ActionIcon name="panel" /></IconButton></header>
            <div id="local-review-opinion-content" hidden={notesCollapsed}><div className="local-review-draft">{annotations.length ? <ul>{annotations.map(a => <li key={a.id}><button className="review-note-link" onClick={() => edit(a)}>{a.path}:{a.startLine}–{a.endLine}</button><p>{a.body}</p><button disabled={busy} className="secondary-button" onClick={() => removeAnnotation(a.id)}>删除意见</button></li>)}</ul> : <p>还没有意见。点击代码行后写下审阅意见。</p>}</div>
        <div className="local-review-submit">{draft ? <p role="status">请先保存或取消行内意见。</p> : null}<h3>审阅代理</h3><label>执行方式<select aria-label="执行方式" value={settings.worker} disabled={busy} onChange={event => { const worker = event.target.value as LocalReviewSettings["worker"]; void perform(() => api.saveLocalReviewSettings({ repositoryId, settings: { ...repository!.settings, worker } })); }}><option value="codex">Codex CLI</option><option value="claude-code">Claude Code CLI</option><option value="pi">Pi agent</option></select></label><p>{settings.worker === "pi" ? "Pi 由 Paraself 执行工具；命令沙箱探测不通过时仍可编辑文件，但不会提供命令工具或执行测试。" : settings.worker === "claude-code" ? "使用 Claude Code 自带工具；钥匙串服务可达、隔离未验证，建议只用于信任的工程。CLI 拦截直接 security 调用；Node 等间接执行风险已接受。" : "CLI 原生使用自己的工具和沙箱；能力探测失败会禁止提交。"}</p><label>模型档案<select value={profileId} onChange={e => setProfileId(e.target.value)} disabled={busy}>{availableModels.map(p => <option value={p.profileId} key={p.profileId}>{p.label} · {p.model ?? "未指定模型"}</option>)}</select></label>{!availableModels.length ? <p>请先在“模型”中启用适用的模型档案。</p> : null}<p>相关源码、完整 Git 历史和意见会发给所选档案对应的模型服务。推送会触发远端 CI，draft PR 也会触发。</p><p>{files?.pushUrl ? `推送目标：${files.pushUrl}` : "尚无有效推送目标，请检查工程设置。"}</p>{files?.prUnavailable ? <p role="status">{files.prUnavailable}</p> : null}<button disabled={busy || !!draft || !annotations.length || !profileId || !files?.pushUrl} onClick={() => void perform(async () => { const id = await api.submitLocalReview({ repositoryId, sessionId, profileId, worker: settings.worker }); setJobId(id); setTab("tasks"); })}>{busy ? "正在处理…" : `提交 ${annotations.length} 条意见`}</button></div></div>
          </aside>
        </div> : <p>选择本地 Git 工程以开始审阅。审阅不会修改当前工作区。</p>}
      </section>
      <section className="local-review-task-tab" id="local-review-background" role="tabpanel" aria-labelledby="local-review-tasks-tab" hidden={tab !== "tasks"}>
        <LocalReviewTasks jobs={jobs} jobId={jobId} busy={busy} active={tab === "tasks" && !hidden} draft={chatDraft} composerRef={composerRef} sending={sendingJob !== ""} chatError={chatError} onSelect={id => { setJobId(id); setChatError(""); }} onDraft={(job, body) => { const current = chatDraft(job.id); setChatDraft(job.id, { ...current, body }); }} onSend={job => void sendMessage(job)} onExecute={(job, messageId) => void perform(() => api.executeLocalReviewPlan({ repositoryId: job.repositoryId, jobId: job.id, messageId }))} onConversationAction={(job, input: ConversationActionInput) => void perform(() => api.actOnLocalReviewConversation({ repositoryId: job.repositoryId, jobId: job.id, ...input }))} onReviewExecutionRisk={(job, execution) => setExecutionApproval({ job, execution })} onMarkRead={markRead} onQuote={quote} onAction={(job, group, actionName) => void action(job, group, actionName)} onReviewRisk={(job, group) => setApproval({ job, group })} onOpenLink={url => void perform(() => api.openPrLink(url))} />
      </section>
    </>}
    {settingsOpen ? <ModalDialog title="工程设置" size="compact" onClose={() => setSettingsOpen(false)}>
      <div className="local-review-settings">
        <label>会话<select value={sessionId} disabled={busy || dirty} onChange={event => navigate(() => setSessionId(event.target.value))}>{data?.sessions.filter(session => session.repositoryId === repositoryId).map((session, index) => <option key={session.id} value={session.id}>#{index + 1} · {session.snapshot.headSha.slice(0, 8)}</option>)}</select></label>
        <label>基线分支（detached HEAD 必填）<input value={baseInput} onChange={event => setBaseInput(event.target.value)} placeholder="默认使用默认分支" /></label>
        <button className="secondary-button" disabled={!repositoryId || busy || dirty} onClick={() => void perform(async () => { setSessionId(await api.startLocalReviewSession({ repositoryId, ...(baseInput ? { baseBranch: baseInput } : {}) })); setJobId(null); setTab("review"); setSettingsOpen(false); })}>开始新会话</button>
        {repository ? <div className="local-review-controls"><label>推送远端<input value={settings.pushRemote} disabled={busy} onChange={e => setSettings({ ...settings, pushRemote: e.target.value })} /></label><label>目标分支<input value={settings.baseBranch} disabled={busy} onChange={e => setSettings({ ...settings, baseBranch: e.target.value })} /></label><label>审阅人（逗号分隔）<input value={reviewersText} disabled={busy} onChange={e => setReviewersText(e.target.value)} /></label><label>依赖安装<select aria-label="依赖安装" value={dependencies.mode} disabled={busy} onChange={e => setSettings({ ...settings, dependencies: { ...dependencies, mode: e.target.value as typeof dependencies.mode } })}><option value="auto">自动识别 lockfile</option><option value="custom">自定义 argv</option><option value="off">关闭</option></select></label>{dependencies.mode === "custom" ? <><label>安装 argv（一行一个参数）<textarea value={dependencies.argv.join("\n")} disabled={busy} onChange={e => setSettings({ ...settings, dependencies: { ...dependencies, argv: e.target.value.split("\n") } })} /></label><label>缓存键文件（一行一个相对路径）<textarea value={dependencies.files.join("\n")} disabled={busy} onChange={e => setSettings({ ...settings, dependencies: { ...dependencies, files: e.target.value.split("\n") } })} /></label></> : null}<label><input type="checkbox" checked={dependencies.allowScripts} disabled={busy} onChange={e => setSettings({ ...settings, dependencies: { ...dependencies, allowScripts: e.target.checked } })} />允许安装脚本</label><p>目前仅支持 Node 工程，custom 用于自定义安装命令，产物须为根 node_modules；Yarn PnP 和其它语言不支持，会记录原因并继续任务。安装阶段允许出站网络，依赖可读取并外传本工程源码和历史。使用独立缓存与 HOME，不读取个人 .npmrc；私有 registry 令牌暂不支持。</p><button disabled={busy} className="secondary-button" onClick={() => void perform(() => api.clearLocalReviewDependencies({ repositoryId }))}>清除依赖缓存</button><button disabled={busy} className="secondary-button" onClick={() => void perform(async () => { await api.saveLocalReviewSettings({ repositoryId, settings: { ...settings, reviewers: reviewersText.split(/[,，]/u).map(v => v.trim()).filter(Boolean) } }); setSettingsOpen(false); })}>保存工程设置</button></div> : <p>选择工程后可以设置推送目标和审阅人。</p>}
      </div>
    </ModalDialog> : null}
    {approval?.group.artifact && !approval.group.artifact.secretFindings?.length ? <ModalDialog title="高风险改动" onClose={() => setApproval(null)}><div className="local-review-approval"><p>这些改动可能影响 CI、Git 行为或文件权限。普通代码也可能被现有 CI 执行。</p><p>固定提交：{approval.group.artifact.commitOid}</p><p>推送地址：{approval.job.pushUrl}</p><ul>{approval.group.artifact.risks.map(path => <li key={path}>{path}</li>)}</ul><pre>{approval.group.artifact.diff}</pre><button disabled={busy} onClick={() => void perform(async () => { await api.actOnLocalReview({ repositoryId: approval.job.repositoryId, jobId: approval.job.id, groupId: approval.group.id, action: "approve", authorization: { groupId: approval.group.id, commitOid: approval.group.artifact!.commitOid, risks: approval.group.artifact!.risks, pushUrl: approval.job.pushUrl } }); setApproval(null); })}>仍然推送</button></div></ModalDialog> : null}
    {(() => {
      if (!executionApproval) return null;
      const job = data?.jobs.find(j => j.id === executionApproval.job.id) ?? executionApproval.job, execution = job.executions.find(e => e.id === executionApproval.execution.id) ?? executionApproval.execution, grant = executionAuthorization(job, execution);
      if (!grant || execution.state !== "blocked") return null;
      return <ModalDialog title="高风险改动" onClose={() => setExecutionApproval(null)}><div className="local-review-approval"><p>这次追加会让这些改动进入已有分支或新分支。普通代码也可能被现有 CI 执行。</p><p>本次新提交：{grant.authorization.commitOid}</p><p>基于：{grant.authorization.planBaseOid}</p><p>推送地址：{job.pushUrl}</p><ul>{grant.artifact.risks.map(path => <li key={path}>{path}</li>)}</ul><pre>{grant.artifact.diff}</pre><button disabled={busy} onClick={() => void perform(async () => { await api.actOnLocalReviewConversation({ repositoryId: job.repositoryId, jobId: job.id, action: "approve_execution", executionId: execution.id, authorization: grant.authorization }); setExecutionApproval(null); })}>仍然推送</button></div></ModalDialog>;
    })()}
  </section>;
}
