import { useEffect, useId, useMemo, useRef, useState } from "react";

import type { DecisionApi, PromptItem } from "../../../../shared/renderer-api.js";
import { ActionIcon } from "../../IconButton.js";
import { ListWidthHandle } from "../../ListWidthHandle.js";
import { ModalDialog } from "../../ModalDialog.js";
import { TodoDeleteDialog } from "../todos/TodoDeleteDialog.js";
import "./prompts.css";

export type PromptsApi = Pick<DecisionApi, "listPrompts" | "createPrompt" | "updatePrompt" | "deletePrompt">;

const message = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause)).replace(/^Error invoking remote method '[^']+': (Error: )?/u, "");

/** Title and body, lower-cased, each holding every word typed: what a search reads. */
export const matchesPrompt = (prompt: PromptItem, query: string): boolean => {
  const haystack = `${prompt.title}\n${prompt.body}`.toLocaleLowerCase();
  return query.toLocaleLowerCase().split(/\s+/u).filter(Boolean).every((word) => haystack.includes(word));
};

type Editing = { mode: "create" } | { mode: "edit"; prompt: PromptItem };

const PromptEditor = ({ api, editing, onSaved, onSaveFailed, onClose }: { api: PromptsApi; editing: Editing; onSaved(prompt: PromptItem): void; onSaveFailed(): Promise<void>; onClose(): void }) => {
  const id = useId();
  const opened = editing.mode === "edit" ? { title: editing.prompt.title, body: editing.prompt.body } : { title: "", body: "" };
  const [title, setTitle] = useState(opened.title);
  const [body, setBody] = useState(opened.body);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);
  const dirty = title !== opened.title || body !== opened.body;
  const canSave = !busy && title.trim().length > 0 && body.trim().length > 0;

  const requestClose = (): void => {
    if (busy) return;
    if (dirty) setConfirmingDiscard(true);
    else onClose();
  };
  const save = async (): Promise<void> => {
    if (!canSave) return;
    setBusy(true);
    setError(null);
    try {
      const saved = editing.mode === "edit"
        ? await api.updatePrompt({ id: editing.prompt.id, expectedUpdatedAt: editing.prompt.updatedAt, title, body })
        : await api.createPrompt({ title, body });
      onSaved(saved);
    } catch (cause) {
      // What was typed stays in the form, to be saved again or copied out. The list is read again, so that an edit
      // refused because the prompt changed elsewhere, opened afresh, starts from what it now is.
      await onSaveFailed();
      setError(editing.mode === "edit"
        ? `保存失败：${message(cause)}。输入仍保留在这里，可以重试，或复制输入后取消、重新打开编辑。`
        : `保存失败：${message(cause)}。内容仍保留在这里，可以重试。`);
      setBusy(false);
    }
  };

  return (
    <ModalDialog
      title={editing.mode === "edit" ? "编辑提示词" : "新建提示词"}
      size="default"
      unsaved={dirty}
      dismissible={!busy}
      onClose={requestClose}
      // Every button keyed: unkeyed, React kept 继续编辑's element and made it 保存 (type submit) during the click, and
      // the click's default action then submitted the form. preventDefault stops any such action on these two.
      footer={confirmingDiscard ? (
        <>
          <span key="question" className="prompt-discard-question" role="alert">放弃未保存的修改？</span>
          <button key="keep-editing" type="button" className="secondary-button" autoFocus onClick={(event) => { event.preventDefault(); setConfirmingDiscard(false); }}>继续编辑</button>
          <button key="discard" type="button" className="primary-button danger-button" onClick={(event) => { event.preventDefault(); onClose(); }}>放弃</button>
        </>
      ) : (
        <>
          <button key="cancel" type="button" className="secondary-button" disabled={busy} onClick={requestClose}>取消</button>
          <button key="save" type="submit" form={`${id}-form`} className="primary-button" disabled={!canSave}>{busy ? "正在保存…" : "保存"}</button>
        </>
      )}
    >
      <form
        id={`${id}-form`}
        className="form-fields prompt-editor"
        onSubmit={(event) => {
          event.preventDefault();
          // Only 保存 (or Enter in the title) saves, and never while 放弃 is being asked about.
          if (!confirmingDiscard) void save();
        }}
      >
        <div className="form-field">
          <label htmlFor={`${id}-title`}>标题</label>
          <input id={`${id}-title`} autoFocus autoComplete="off" maxLength={120} value={title} disabled={busy} onChange={(event) => setTitle(event.currentTarget.value.replace(/[\r\n]+/gu, " "))} />
        </div>
        <div className="form-field">
          <label htmlFor={`${id}-body`}>正文</label>
          <textarea id={`${id}-body`} rows={12} maxLength={20_000} value={body} disabled={busy} spellCheck={false} onChange={(event) => setBody(event.currentTarget.value)} />
        </div>
        {error === null ? null : <p className="form-error" role="alert">{error}</p>}
      </form>
    </ModalDialog>
  );
};

export const PromptsPanel = ({ api }: { api: PromptsApi }) => {
  const idPrefix = useId();
  const [prompts, setPrompts] = useState<PromptItem[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [deleting, setDeleting] = useState<PromptItem | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [copy, setCopy] = useState<{ id: string; ok: boolean } | null>(null);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const searchRef = useRef<HTMLInputElement>(null);

  const mounted = useRef(true);
  const reload = async (): Promise<void> => {
    try {
      const listed = await api.listPrompts();
      if (mounted.current) { setPrompts(listed); setLoadError(null); }
    } catch (cause) {
      if (mounted.current) setLoadError(message(cause));
    }
  };
  useEffect(() => {
    mounted.current = true;
    void reload();
    return () => { mounted.current = false; };
  }, [api]);
  useEffect(() => () => clearTimeout(copyTimer.current), []);

  const shown = useMemo(() => (prompts ?? []).filter((prompt) => matchesPrompt(prompt, query)), [prompts, query]);
  const selected = shown.find((prompt) => prompt.id === selectedId) ?? shown[0] ?? null;

  const copyBody = async (prompt: PromptItem): Promise<void> => {
    clearTimeout(copyTimer.current);
    try {
      await navigator.clipboard.writeText(prompt.body);
      setCopy({ id: prompt.id, ok: true });
      copyTimer.current = setTimeout(() => setCopy(null), 2_000);
    } catch {
      setCopy({ id: prompt.id, ok: false });
    }
  };
  const confirmDelete = async (prompt: PromptItem): Promise<void> => {
    setDeleteBusy(true);
    setDeleteError(null);
    try {
      await api.deletePrompt(prompt.id);
      setPrompts((current) => (current ?? []).filter((item) => item.id !== prompt.id));
      setDeleting(null);
    } catch (cause) {
      setDeleteError(`删除失败：${message(cause)}`);
    } finally {
      setDeleteBusy(false);
    }
  };

  const create = (
    <button type="button" className="primary-button prompt-create-button" disabled={prompts === null} onClick={() => setEditing({ mode: "create" })}>
      <ActionIcon name="plus" />新建
    </button>
  );

  return (
    <section className="prompt-panel" role="region" aria-label="提示词">
      <header className="desktop-view-header drag-region">
        <div>
          <span>常用</span>
          <h1>提示词</h1>
          <p>保存常用提示词，复制到 Codex 或 Claude Code 使用。仅保存在本机。</p>
        </div>
        <div className="prompt-header-actions no-drag">{create}</div>
      </header>

      {loadError !== null ? (
        <div className="prompt-workspace prompt-workspace-single">
          <p className="form-error prompt-load-error" role="alert">读取提示词失败：{loadError}</p>
        </div>
      ) : prompts === null ? (
        <div className="prompt-workspace prompt-workspace-single"><p className="prompt-muted" role="status">正在读取…</p></div>
      ) : prompts.length === 0 ? (
        <div className="prompt-workspace prompt-workspace-single">
          <div className="prompt-empty">
            <h2>还没有提示词</h2>
            <p>把常用的提示词存在这里，用的时候一键复制。</p>
            {create}
          </div>
        </div>
      ) : (
        <div className="prompt-workspace">
          <aside id={`${idPrefix}-list`} className="prompt-sidebar" aria-label="提示词列表">
            <div className="prompt-search">
              <ActionIcon name="search" />
              <input ref={searchRef} type="search" aria-label="搜索提示词" placeholder="搜索标题或正文" value={query} onChange={(event) => setQuery(event.currentTarget.value)} />
            </div>
            {shown.length === 0 ? (
              <div className="prompt-no-match" role="status">
                <p>没有匹配的提示词</p>
                <button type="button" className="text-button" onClick={() => { setQuery(""); searchRef.current?.focus(); }}>清除搜索</button>
              </div>
            ) : (
              <ul className="prompt-list">
                {shown.map((prompt) => (
                  <li key={prompt.id}>
                    <button type="button" className="prompt-row" aria-current={prompt.id === selected?.id ? "true" : undefined} onClick={() => setSelectedId(prompt.id)}>
                      <strong>{prompt.title}</strong>
                      <span>{prompt.body.trim().split("\n")[0]}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </aside>
          <ListWidthHandle storageKey="paraself.prompts.list-width" label="调整提示词列表宽度" controls={`${idPrefix}-list`} />
          {selected === null ? <section className="prompt-detail" aria-label="提示词详情" /> : (
            <section className="prompt-detail" aria-label="提示词详情">
              <header className="prompt-detail-head">
                <h2>{selected.title}</h2>
                <div className="prompt-detail-actions">
                  {copy?.id === selected.id ? (
                    <span className={copy.ok ? "prompt-copy-notice" : "prompt-copy-notice prompt-copy-failed"} role="status">
                      {copy.ok ? "已复制" : "复制失败，可以选中正文手动复制"}
                    </span>
                  ) : null}
                  <button type="button" className="secondary-button" onClick={() => void copyBody(selected)}>
                    <ActionIcon name={copy?.id === selected.id && copy.ok ? "check" : "copy"} />复制
                  </button>
                  <button type="button" className="secondary-button" onClick={() => setEditing({ mode: "edit", prompt: selected })}>
                    <ActionIcon name="edit" />编辑
                  </button>
                  <button type="button" className="secondary-button danger-button" onClick={() => { setDeleteError(null); setDeleting(selected); }}>
                    <ActionIcon name="trash" />删除
                  </button>
                </div>
              </header>
              <pre className="prompt-body">{selected.body}</pre>
            </section>
          )}
        </div>
      )}

      {editing === null ? null : (
        <PromptEditor
          key={editing.mode === "edit" ? editing.prompt.id : "create"}
          api={api}
          editing={editing}
          onClose={() => setEditing(null)}
          onSaveFailed={reload}
          onSaved={(saved) => {
            setPrompts((current) => {
              const list = current ?? [];
              return list.some((item) => item.id === saved.id) ? list.map((item) => (item.id === saved.id ? saved : item)) : [saved, ...list];
            });
            setSelectedId(saved.id);
            // A new prompt the search would hide is shown anyway: the search is let go of.
            if (!matchesPrompt(saved, query)) setQuery("");
            setEditing(null);
          }}
        />
      )}
      {deleting === null ? null : (
        <TodoDeleteDialog
          title={`删除提示词「${deleting.title}」？`}
          description="删除后无法恢复。"
          confirmLabel="删除"
          busy={deleteBusy}
          error={deleteError}
          onConfirm={() => void confirmDelete(deleting)}
          onClose={() => setDeleting(null)}
        >
          <p>这条提示词会从这台电脑上删除。</p>
        </TodoDeleteDialog>
      )}
    </section>
  );
};
