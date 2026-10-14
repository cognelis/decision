import { useEffect, useMemo, useRef, useState } from "react";
import { estimatePrReviewUnits, prReviewOrder, type PrReviewSnapshot } from "@cognelis/decision-protocol";
import { ModalDialog } from "../../ModalDialog.js";

/**
 * About how many groups a review of these files (null: every one) takes with a model that reads `unitChars` of diff at a
 * time. A snapshot read before sizes were kept falls back on its per-file batches.
 */
export const plannedGroups = (snapshot: PrReviewSnapshot, paths: string[] | null, unitChars: number): number | undefined => {
  if (!snapshot.fileHunks) return paths ? paths.reduce((sum, path) => sum + (snapshot.fileBatches?.[path] ?? 0), 0) : snapshot.batchCount;
  const chosen = paths ? new Set(paths) : undefined;
  const hunks = snapshot.fileHunks;
  // In the order the review packs a selection: a test whose source was not picked goes last, as it does there.
  return estimatePrReviewUnits(prReviewOrder(Object.keys(hunks).filter((path) => !chosen || chosen.has(path))).map((path) => [path, hunks[path]!] as const), unitChars);
};

/**
 * Which files a review covers. The rest wait for another review rather than counting as missed;
 * a file without a text diff to review (binary, a lockfile) cannot be picked.
 */
export function PrReviewScopeDialog({ snapshot, chosen, unitChars, onClose, onConfirm }: {
  snapshot: PrReviewSnapshot;
  /** Diff characters one review group holds with the chosen model. */
  unitChars: number;
  /** The current choice; null is every file. */
  chosen: string[] | null;
  onClose(): void;
  /** Every reviewable file picked comes back as null, so the review is not narrowed for nothing. */
  onConfirm(paths: string[] | null): void;
}) {
  const batches = snapshot.fileBatches ?? {};
  const reviewable = snapshot.files.map(file => file.path).filter(path => (batches[path] ?? 0) > 0);
  const skipped = new Set(snapshot.skippedFiles);
  const [selected, setSelected] = useState(() => new Set(chosen ?? reviewable));
  // What the reader opened the dialog on, and what a refresh added to it: a change of theirs keeps it open on Escape.
  const opened = useRef(new Set(selected));
  // A newer snapshot read while the dialog is open (the PR moved on) brings its new files in picked: left out, 确定
  // narrowed the review to the files the reader had seen, though they had left nothing out.
  const seen = useRef(new Set(reviewable));
  useEffect(() => {
    const added = reviewable.filter((path) => !seen.current.has(path));
    seen.current = new Set(reviewable);
    if (!added.length) return;
    for (const path of added) opened.current.add(path);
    setSelected((current) => new Set([...current, ...added]));
  }, [snapshot]);
  const [query, setQuery] = useState("");
  const groups = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    const byDirectory = new Map<string, string[]>();
    for (const { path } of snapshot.files) {
      if (!path.toLocaleLowerCase().includes(needle)) continue;
      const directory = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
      byDirectory.set(directory, [...byDirectory.get(directory) ?? [], path]);
    }
    return [...byDirectory].sort(([left], [right]) => left.localeCompare(right));
  }, [snapshot.files, query]);
  const toggle = (paths: string[], on: boolean) => setSelected(current => {
    const next = new Set(current);
    for (const path of paths) { if (on) next.add(path); else next.delete(path); }
    return next;
  });
  const picked = reviewable.filter(path => selected.has(path));
  // 全选 / 全不选 act on the files the filter shows, as each directory's box does: on the whole PR, narrowed to two
  // files and 全选 confirmed all of them.
  const shown = groups.flatMap(([, paths]) => paths).filter(path => (batches[path] ?? 0) > 0);
  const changed = selected.size !== opened.current.size || [...selected].some((path) => !opened.current.has(path));
  const cost = (paths: string[]) => plannedGroups(snapshot, paths, unitChars) ?? 0;
  // A file alone takes more than one group only when it is larger than a group holds.
  const alone = (path: string) => plannedGroups(snapshot, [path], unitChars) ?? 0;

  // A changed selection is not thrown away by Escape out of habit; 取消 still leaves it.
  return <ModalDialog title="选择评审文件" description="只评审勾选的文件；PR 概览和改进建议仍看整个 PR。" onClose={onClose} dismissible={!changed}>
    <div className="review-scope-dialog">
      <div className="review-scope-tools">
        <input type="search" aria-label="筛选文件路径" placeholder="筛选文件路径…" value={query} onChange={event => setQuery(event.target.value)} />
        <button type="button" className="secondary-button" onClick={() => toggle(shown, true)}>全选</button>
        <button type="button" className="secondary-button" onClick={() => toggle(shown, false)}>全不选</button>
      </div>
      <ul className="review-scope-files" aria-label="变更文件">
        {groups.map(([directory, paths]) => {
          const open = paths.filter(path => (batches[path] ?? 0) > 0);
          const on = open.filter(path => selected.has(path));
          return <li key={directory}>
            <label className="review-scope-directory">
              <input type="checkbox" disabled={!open.length} checked={open.length > 0 && on.length === open.length}
                ref={box => { if (box) box.indeterminate = on.length > 0 && on.length < open.length; }}
                onChange={() => toggle(open, on.length < open.length)} />
              <span>{directory || "根目录"}</span><small>{paths.length} 个文件{open.length ? ` · 约 ${cost(open)} 组` : ""}</small>
            </label>
            <ul>{paths.map(path => {
              const count = batches[path] ?? 0;
              return <li key={path}><label className="review-scope-file" data-disabled={count ? undefined : ""}>
                <input type="checkbox" aria-label={path} disabled={!count} checked={count > 0 && selected.has(path)} onChange={() => toggle([path], !selected.has(path))} />
                <code>{path.slice(directory ? directory.length + 1 : 0)}</code>
                <small>{count ? (alone(path) > 1 ? `大文件 · 约 ${alone(path)} 组` : "") : skipped.has(path) ? "锁定或生成文件 · 不送模型" : "没有可评审的文本 diff"}</small>
              </label></li>;
            })}</ul>
          </li>;
        })}
      </ul>
      {!groups.length ? <p className="review-history-note">没有匹配的文件。</p> : null}
      <div className="review-scope-footer">
        <span role="status">已选 {picked.length} / {reviewable.length} 个文件 · 约 {cost(picked)} 组</span>
        <div className="modal-form-actions">
          <button type="button" className="secondary-button" onClick={onClose}>取消</button>
          <button type="button" className="primary-button" disabled={!picked.length} onClick={() => onConfirm(picked.length === reviewable.length ? null : picked)}>确定</button>
        </div>
      </div>
    </div>
  </ModalDialog>;
}
