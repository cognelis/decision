import { Fragment, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { Diff, Hunk, Decoration, findChangeByNewLineNumber, findChangeByOldLineNumber, getChangeKey, type ChangeData, type FileData, type HunkData } from "react-diff-view";
import "react-diff-view/style/index.css";
import type { PrReviewFinding, PrReviewSnapshot, PrReviewFileRequest, PrReviewFileResponse } from "@cognelis/decision-protocol";
import type { DecisionApi } from "../../../../shared/renderer-api.js";
import { ModalDialog } from "../../ModalDialog.js";
import { ListWidthHandle } from "../../ListWidthHandle.js";
import { ActionIcon, IconButton } from "../../IconButton.js";
import { parsePrFileDiffs, visibleDiffHunks } from "./pr-diff-view.js";
import { platformMessage } from "./platform-message.js";

type FileEntry = PrReviewSnapshot["files"][number];
const STATUS: Record<string, string> = { added: "新增", add: "新增", ADD: "新增", deleted: "删除", delete: "删除", DELETE: "删除", removed: "删除", modified: "修改", modify: "修改", MODIFY: "修改", renamed: "重命名", rename: "重命名", MOVE: "重命名", copied: "复制", copy: "复制", COPY: "复制" };

function FileDirectory({ files, prefix = "", selected, counts, onSelect }: { files: FileEntry[]; prefix?: string; selected: string; counts: Map<string, number>; onSelect(path: string): void }) {
  const directories = new Map<string, FileEntry[]>();
  const leaves: FileEntry[] = [];
  for (const file of files) {
    const remainder = file.path.slice(prefix.length);
    const slash = remainder.indexOf("/");
    if (slash < 0) leaves.push(file);
    else {
      const name = remainder.slice(0, slash);
      const group = directories.get(name) ?? [];
      group.push(file); directories.set(name, group);
    }
  }
  return <ul>{[...directories].sort(([a], [b]) => a.localeCompare(b)).map(([name, children]) => <li key={`${prefix}${name}/`}><details open><summary aria-label={`${name}，${children.length} 个文件`}>{name}<small>{children.length}</small></summary><FileDirectory files={children} prefix={`${prefix}${name}/`} selected={selected} counts={counts} onSelect={onSelect} /></details></li>)}
    {leaves.sort((a, b) => a.path.localeCompare(b.path)).map(file => { const count = counts.get(file.path) ?? 0; return <li key={file.path}><button title={file.path} aria-label={count ? `${file.path}（${count} 个问题）` : file.path} aria-current={file.path === selected ? "true" : undefined} onClick={() => onSelect(file.path)}><span>{file.path.slice(prefix.length)}</span>{count ? <em className="pr-diff-file-findings">{count} 个问题</em> : null}<small>{STATUS[file.status] ?? file.status}</small></button></li>; })}</ul>;
}

/** The directory's order: folders before files at each level, then by name. */
const treeOrder = (left: string, right: string): number => {
  if (left === right) return 0;
  const a = left.split("/"), b = right.split("/");
  let index = 0;
  while (a[index] === b[index]) index++;
  const folderA = index < a.length - 1, folderB = index < b.length - 1;
  return folderA !== folderB ? (folderA ? -1 : 1) : (a[index] ?? "").localeCompare(b[index] ?? "");
};

const changeOf = (hunks: HunkData[], place: { side: "old" | "new"; line: number }) =>
  place.side === "new" ? findChangeByNewLineNumber(hunks, place.line) : findChangeByOldLineNumber(hunks, place.line);
/** How many changes the diff must show for this one to be among them. */
const changesThrough = (hunks: HunkData[], target: ChangeData) => {
  let count = 0;
  for (const hunk of hunks) for (const change of hunk.changes) { count++; if (change === target) return count; }
  return count;
};

/** A review finding under the diff line it is about, the way a platform shows a line comment. */
function FindingNote({ finding }: { finding: PrReviewFinding }) {
  return <article className="pr-diff-finding" aria-label={`评审问题：${finding.title}`}>
    <header><span className="pr-diff-finding-priority" data-priority={finding.priority}>{finding.priority}</span><strong>{finding.title}</strong><span>第 {finding.line} 行 · {finding.side === "new" ? "新版本" : "旧版本"}</span></header>
    <p>{finding.body}</p>
  </article>;
}

function FileContent({ api, request, focusLine }: { api: Pick<DecisionApi, "loadPrReviewFile">; request: PrReviewFileRequest; focusLine?: number | undefined }) {
  const [result, setResult] = useState<PrReviewFileResponse | null>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [limit, setLimit] = useState(2000);
  const focused = useRef<HTMLLIElement>(null);
  // A finding's line outside the diff is found here instead: shown, marked and scrolled to.
  useEffect(() => { focused.current?.scrollIntoView?.({ block: "center" }); }, [result, focusLine]);
  const { connectionId, reference, sourceCommit, destinationCommit, path, side } = request;
  useEffect(() => {
    let disposed = false;
    setResult(null); setError(""); setLimit(2000);
    void api.loadPrReviewFile({ connectionId, reference, sourceCommit, destinationCommit, path, side })
      .then(value => { if (!disposed) setResult(value); })
      .catch(cause => { if (!disposed) setError(platformMessage(cause, "读取文件失败。")); });
    return () => { disposed = true; };
  }, [api, connectionId, reference, sourceCommit, destinationCommit, path, side, attempt]);
  if (error) return <div className="pr-diff-notice" role="alert"><p>{error}</p><button className="secondary-button" onClick={() => setAttempt(value => value + 1)}>重试读取文件</button></div>;
  if (!result) return <p className="pr-diff-notice" role="status">正在读取文件内容…</p>;
  if (result.binary) return <p className="pr-diff-notice">二进制文件，无法展示文本内容。</p>;
  if (!result.content) return <p className="pr-diff-notice">这是一个空文件。</p>;
  const lines = result.content.split("\n");
  if (result.content.endsWith("\n")) lines.pop();
  const shown = Math.max(limit, focusLine ?? 0);
  return <><ol className="pr-file-lines" aria-label="文件内容">{lines.slice(0, shown).map((line, index) => <li key={index} {...(index + 1 === focusLine ? { ref: focused, "aria-current": "true" as const, "data-focus": "" } : {})}><code>{line || " "}</code></li>)}</ol>{lines.length > shown ? <div className="pr-diff-notice"><p>已显示前 {shown} / {lines.length} 行。</p><button className="secondary-button" onClick={() => setLimit(value => value + 2000)}>显示更多内容</button></div> : null}</>;
}

/** Where a finding lands: the dialog opens on its file and highlights its line. */
/** A line to open the dialog at; `view` "file" opens the whole file there (a review step that read the source). */
export interface DiffFocus { path: string; side: "old" | "new"; line: number; view?: "diff" | "file" }

export function PrDiffDialog({ api, snapshot, connectionId, reviewModel, focus, findings = [], onClose }: { api: Pick<DecisionApi, "loadPrReviewDiff" | "loadPrReviewFile">; snapshot: PrReviewSnapshot; connectionId?: string | undefined; reviewModel?: string | undefined; focus?: DiffFocus | undefined;
  /** The review's findings on these commits, shown on their lines. */
  findings?: PrReviewFinding[] | undefined; onClose(): void }) {
  const [files, setFiles] = useState<FileData[] | null>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [selectedPath, setSelectedPath] = useState(() => focus && snapshot.files.some(file => file.path === focus.path) ? focus.path : snapshot.files[0]?.path ?? "");
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<"unified" | "split">(() => {
    try { return localStorage.getItem("decision.pr-review.diff-mode") === "split" ? "split" : "unified"; } catch { return "unified"; }
  });
  const [view, setView] = useState<"diff" | "file">(() => focus?.view ?? "diff");
  // An old-side finding's line numbers belong to the target commit's file.
  const [side, setSide] = useState<"old" | "new">(() => focus?.side ?? "new");
  const [limit, setLimit] = useState(2000);
  // The line to find: the finding the dialog was opened on, then any finding outside the diff picked here.
  const [target, setTarget] = useState(focus);
  useEffect(() => {
    if (!connectionId) return;
    let disposed = false;
    setFiles(null); setError("");
    void api.loadPrReviewDiff({ connectionId, reference: snapshot.reference, sourceCommit: snapshot.sourceCommit, destinationCommit: snapshot.destinationCommit })
      .then(result => { if (!disposed) setFiles(parsePrFileDiffs(result.diff)); })
      .catch(cause => { if (!disposed) setError(platformMessage(cause, "读取变更失败，请重试。")); });
    return () => { disposed = true; };
  }, [api, snapshot, connectionId, attempt]);
  const selected = snapshot.files.find(file => file.path === selectedPath);
  const diff = files?.find(file => (file.type === "delete" ? file.oldPath : file.newPath) === selectedPath);
  const effectiveSide = diff?.type === "add" ? "new" : diff?.type === "delete" ? "old" : side;
  const filePath = (effectiveSide === "old" ? diff?.oldPath : diff?.newPath) ?? selectedPath;
  const visible = useMemo(() => visibleDiffHunks(diff?.hunks ?? [], limit), [diff, limit]);
  const total = diff?.hunks.reduce((count, hunk) => count + hunk.changes.length, 0) ?? 0;
  // The finding's own line, when this file is the finding's file and the line is in the shown diff.
  const focusing = target !== undefined && target.path === selectedPath;
  const focused = useMemo(() => {
    if (!target || target.path !== selectedPath) return [];
    const change = target.side === "new" ? findChangeByNewLineNumber(visible, target.line) : findChangeByOldLineNumber(visible, target.line);
    return change ? [getChangeKey(change)] : [];
  }, [target, selectedPath, visible]);
  // A line further down than the diff shows so far is shown, rather than called outside the diff.
  useEffect(() => {
    if (!target || target.path !== selectedPath || !diff) return;
    const change = changeOf(diff.hunks, target);
    if (change) setLimit(value => Math.max(value, changesThrough(diff.hunks, change) + 20));
  }, [target, selectedPath, diff]);
  const counts = useMemo(() => {
    const byPath = new Map<string, number>();
    for (const finding of findings) byPath.set(finding.path, (byPath.get(finding.path) ?? 0) + 1);
    return byPath;
  }, [findings]);
  // Every finding on this file: under its line when the shown diff has it, listed above the diff when not —
  // either outside the diff altogether, or further down than the diff shows so far. A line listed there is not named
  // again in the toolbar; only a line nothing lists (a dropped finding's, say) is.
  const placed = useMemo(() => {
    const byChange = new Map<string, PrReviewFinding[]>();
    const outside: { finding: PrReviewFinding; later?: ChangeData | undefined }[] = [];
    for (const finding of findings.filter(item => item.path === selectedPath)) {
      const change = changeOf(visible, finding);
      if (!change) { outside.push({ finding, later: changeOf(diff?.hunks ?? [], finding) }); continue; }
      const key = getChangeKey(change);
      byChange.set(key, [...byChange.get(key) ?? [], finding]);
    }
    const widgets: Record<string, ReactNode> = Object.fromEntries([...byChange].map(([key, items]) => [key, <div className="pr-diff-findings">{items.map((finding, index) => <FindingNote key={index} finding={finding} />)}</div>]));
    return { widgets, outside, lines: new Set(byChange.keys()) };
  }, [findings, selectedPath, visible, diff]);
  // Findings as the directory lists them, the order "上一个/下一个问题" walks.
  const ordered = useMemo(() => [...findings].sort((a, b) => treeOrder(a.path, b.path) || a.line - b.line), [findings]);
  // Two findings on one line share a place, so which one the walk is on is kept, not looked up from the place.
  const [walked, setWalked] = useState<number | null>(null);
  const samePlace = (item: PrReviewFinding, place: DiffFocus) => item.path === place.path && item.side === place.side && item.line === place.line;
  const at = !target ? -1 : walked !== null && ordered[walked] && samePlace(ordered[walked]!, target) ? walked : ordered.findIndex(item => samePlace(item, target));
  const step = (by: number) => {
    const next = at < 0 ? (by > 0 ? 0 : ordered.length - 1) : (at + by + ordered.length) % ordered.length;
    const to = ordered[next];
    if (!to) return;
    setWalked(next);
    if (to.path !== selectedPath) { setSelectedPath(to.path); setLimit(2000); }
    setTarget({ path: to.path, side: to.side, line: to.line });
    setSide(to.side);
  };
  const fileFindings = counts.get(selectedPath) ?? 0;
  const outsideCount = placed.outside.filter(item => !item.later).length;
  const code = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (focused.length) code.current?.querySelector(".diff-code-selected")?.scrollIntoView?.({ block: "center" });
  }, [focused, mode, view]);
  // In a large PR, the files the review found something in are the ones to go through.
  const [onlyFindings, setOnlyFindings] = useState(false);
  const filtered = snapshot.files.filter(file => (!onlyFindings || counts.has(file.path)) && file.path.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const setDiffMode = (value: typeof mode) => { setMode(value); try { localStorage.setItem("decision.pr-review.diff-mode", value); } catch { /* The current view still works. */ } };

  // N / P walk the findings as the arrows do, from anywhere in the dialog (it opens on its close button);
  // typing in the search box or choosing in a select is left alone.
  const walkByKey = (event: ReactKeyboardEvent<HTMLElement>) => {
    const key = event.key.toLowerCase();
    if ((key !== "n" && key !== "p") || !ordered.length || event.metaKey || event.ctrlKey || event.altKey || event.nativeEvent.isComposing) return;
    if ((event.target as HTMLElement).closest("input:not([type=checkbox]), textarea, select, [contenteditable]")) return;
    event.preventDefault();
    step(key === "n" ? 1 : -1);
  };

  return <ModalDialog title="PR 详情" size="workspace" onClose={onClose} onKeyDown={walkByKey}>
    <div className="pr-diff-dialog">
      <header className="pr-diff-summary"><h3>{snapshot.title}</h3><p>{snapshot.reference} · {snapshot.files.length} 个文件</p>
        <details><summary>说明与提交信息</summary><p>项目：{snapshot.project}</p>{reviewModel ? <p>评审模型：{reviewModel}</p> : null}<p className="review-text">{snapshot.description || "未填写说明"}</p><p>源提交 <code>{snapshot.sourceCommit}</code></p><p>目标提交 <code>{snapshot.destinationCommit}</code></p>{snapshot.baseCommit ? <p>分叉点 <code>{snapshot.baseCommit}</code></p> : null}{snapshot.warnings.map(warning => <p key={warning}>{warning}</p>)}</details>
      </header>
      <div className="pr-diff-workspace">
        <aside id="pr-diff-files" className="pr-diff-files" aria-label="变更目录"><input type="search" aria-label="搜索变更文件" placeholder="搜索文件路径…" value={query} onChange={event => setQuery(event.target.value)} />{counts.size ? <label className="pr-diff-only-findings"><input type="checkbox" checked={onlyFindings} onChange={event => setOnlyFindings(event.currentTarget.checked)} />只看有问题的文件（{counts.size}）</label> : null}<nav aria-label="变更文件"><FileDirectory files={filtered} selected={selectedPath} counts={counts} onSelect={path => { setSelectedPath(path); setLimit(2000); }} />{!filtered.length ? <p>没有匹配的文件。</p> : null}</nav></aside>
        <ListWidthHandle storageKey="decision.pr-review.file-list-width" label="调整变更目录宽度" controls="pr-diff-files" />
        <section className="pr-diff-content" aria-label="文件变更">
          <div className="pr-diff-toolbar"><div><strong>{selectedPath || "没有变更文件"}</strong><span>{selected ? STATUS[selected.status] ?? selected.status : ""}{diff?.type === "rename" ? ` · 原路径 ${diff.oldPath}` : ""}{fileFindings ? ` · 本文件 ${fileFindings} 个问题${files && outsideCount ? `，${outsideCount} 个在 diff 之外` : ""}` : ""}{focusing && view === "diff" && diff && files ? focused.length ? ` · 已定位到第 ${target.line} 行` : placed.outside.some(({ finding }) => samePlace(finding, target)) ? "" : ` · 第 ${target.line} 行不在 diff 中，可切到“文件内容”查看` : ""}</span></div>
            <div className="pr-diff-view-controls">{ordered.length ? <div className="pr-diff-finding-nav" role="group" aria-label="评审问题">
              <IconButton aria-label="上一个问题" aria-keyshortcuts="P" disabled={ordered.length < 2 && at === 0} onClick={() => step(-1)}><ActionIcon name="previous" /></IconButton>
              <span>{at < 0 ? `${ordered.length} 个问题` : `问题 ${at + 1} / ${ordered.length}`}</span>
              <IconButton aria-label="下一个问题" aria-keyshortcuts="N" disabled={ordered.length < 2 && at === 0} onClick={() => step(1)}><ActionIcon name="next" /></IconButton>
            </div> : null}<div className="pr-diff-modes" role="group" aria-label="文件查看方式"><button aria-pressed={view === "diff"} onClick={() => setView("diff")}>变更</button><button aria-pressed={view === "file"} onClick={() => setView("file")}>文件内容</button></div>
            {view === "file" ? <select aria-label="文件提交版本" value={effectiveSide} onChange={event => setSide(event.target.value as typeof side)}><option value="new" disabled={diff?.type === "delete"}>源提交 · {snapshot.sourceCommit.slice(0, 8)}</option><option value="old" disabled={diff?.type === "add"}>{snapshot.baseCommit ? "分叉点" : "目标提交"} · {(snapshot.baseCommit ?? snapshot.destinationCommit).slice(0, 8)}</option></select> : <div className="pr-diff-modes" role="group" aria-label="Diff 展示方式"><button aria-pressed={mode === "unified"} onClick={() => setDiffMode("unified")}>Unified</button><button aria-pressed={mode === "split"} onClick={() => setDiffMode("split")}>Side-by-Side</button></div>}</div>
          </div>
          {view === "diff" && files && placed.outside.length ? <ul className="pr-diff-outside" aria-label="未显示在 diff 中的评审问题">{placed.outside.map(({ finding, later }, index) => <li key={index}>
            <span>{later ? "后面尚未显示" : "diff 之外"}</span><span className="pr-diff-finding-priority" data-priority={finding.priority}>{finding.priority}</span><strong>第 {finding.line} 行 · {finding.title}</strong>
            {later
              ? <button type="button" className="review-note-link" onClick={() => setTarget({ path: finding.path, side: finding.side, line: finding.line })}>显示到这一行</button>
              : <button type="button" className="review-note-link" onClick={() => { setTarget({ path: finding.path, side: finding.side, line: finding.line }); setSide(finding.side); setView("file"); }}>在文件内容中查看</button>}
          </li>)}</ul> : null}
          <div className="pr-diff-code" key={selectedPath} ref={code} tabIndex={0} aria-label={`${selectedPath || "PR"} 变更内容`}>
            {!connectionId ? <p className="pr-diff-notice">这条历史记录未保存平台连接。请从 PR 列表重新选择，查看最新变更。</p> : error ? <div className="pr-diff-notice" role="alert"><p>{error}</p><button className="secondary-button" onClick={() => setAttempt(value => value + 1)}>重试读取变更</button></div> : files === null ? <p className="pr-diff-notice" role="status">正在读取文件变更…</p> : !selected ? <p className="pr-diff-notice">此 PR 没有变更文件。</p> : view === "file" ? diff?.isBinary ? <p className="pr-diff-notice">二进制文件，无法展示文本内容。</p> : <FileContent key={`${filePath}:${effectiveSide}`} api={api} focusLine={focusing && effectiveSide === target.side ? target.line : undefined} request={{ connectionId, reference: snapshot.reference, sourceCommit: snapshot.sourceCommit, destinationCommit: snapshot.destinationCommit, path: filePath, side: effectiveSide }} /> : !diff ? <p className="pr-diff-notice">平台未返回此文件的可展示 diff，可能是二进制文件、仅元数据变更或内容被截断。</p> : diff.isBinary ? <p className="pr-diff-notice">二进制文件，无法展示文本差异。</p> : !total ? <p className="pr-diff-notice">此文件没有文本差异（可能仅重命名、权限变化或空文件变更）。</p> : <>
              <div className="pr-diff-side-labels" data-mode={mode}><span>变更前</span><span>变更后</span></div>
              <Diff viewType={mode} diffType={diff.type} hunks={visible} selectedChanges={focused} optimizeSelection widgets={placed.widgets}
                // Split rows pass a missing side as null despite the type.
                generateLineClassName={({ changes }) => changes.some(change => change && placed.lines.has(getChangeKey(change))) ? "pr-diff-line-finding" : undefined}>{hunks => hunks.map((hunk, index) => <Fragment key={`${hunk.oldStart}-${hunk.newStart}-${index}`}><Decoration>{hunk.content}</Decoration><Hunk hunk={hunk} /></Fragment>)}</Diff>
              {total > limit ? <div className="pr-diff-notice"><p>已显示前 {limit} / {total} 行变更及上下文。</p><button className="secondary-button" onClick={() => setLimit(value => value + 2000)}>显示更多变更</button></div> : null}
              {!diff.oldEndingNewLine || !diff.newEndingNewLine ? <p className="pr-diff-notice">{!diff.oldEndingNewLine ? "变更前文件末尾没有换行。" : ""}{!diff.newEndingNewLine ? "变更后文件末尾没有换行。" : ""}</p> : null}
            </>}
          </div>
          <p className="pr-diff-footnote">{view === "diff" ? "展示本次 PR diff 与平台提供的上下文；可切换到文件内容查看完整文本。" : `文件内容固定在${effectiveSide === "new" ? "源提交" : snapshot.baseCommit ? "分叉点（PR 分支与目标分支的共同祖先）" : "目标提交"}，不跟随分支后续更新。`}</p>
        </section>
      </div>
    </div>
  </ModalDialog>;
}
