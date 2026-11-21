import { TODO_LIMITS, type TodoRecordResult } from "@cognelis/decision-protocol";
import { useId, useState } from "react";

import type { DecisionApi } from "../../../../shared/renderer-api.js";
import { isSubmitShortcut } from "../../../keyboard.js";
import { ModalDialog } from "../../ModalDialog.js";
import { typedItems } from "./todo-text.js";

interface TodoCreateDialogProps {
  api: Pick<DecisionApi, "recordTodoList">;
  onClose(): void;
  /**
   * Written, or a list already there found in its place: the page opens it. `empty`, made without items: the one found
   * is the list of that project and title, whatever it holds now; otherwise one with the same items too.
   */
  onRecorded(result: TodoRecordResult, empty: boolean): void;
}

/** What keeps the typed items from being saved, in the reader's words; null when they can be. */
const itemsProblem = (items: readonly string[]): string | null => {
  if (items.length > TODO_LIMITS.itemsPerCall) {
    return `一次最多 ${TODO_LIMITS.itemsPerCall} 项，现在有 ${items.length} 项；多出的可以建好清单后再添加。`;
  }
  const long = items.findIndex((item) => item.length > TODO_LIMITS.itemTitle);
  return long < 0 ? null : `每项最多 ${TODO_LIMITS.itemTitle} 个字，第 ${long + 1} 项太长了，请缩短后再创建。`;
};

/** 新建清单: the reader's own list, one item per line, written as an agent's would be; or an empty one to add to. */
export const TodoCreateDialog = ({ api, onClose, onRecorded }: TodoCreateDialogProps) => {
  const id = useId();
  const [title, setTitle] = useState("");
  const [project, setProject] = useState("");
  const [summary, setSummary] = useState("");
  const [itemsText, setItemsText] = useState("");
  // Null until the reader ticks or clears 长期清单 themselves.
  const [longTermChoice, setLongTermChoice] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const items = typedItems(itemsText);
  const problem = itemsProblem(items);
  // Until then it follows the items, as a list sent without the setting is made: one begun empty is to be added to
  // (日常, 学习), one written out whole is worked through and put away.
  const longTerm = longTermChoice ?? items.length === 0;
  const canSave = !saving && title.trim().length > 0 && problem === null;
  // Something typed that a stray Escape or click outside would throw away.
  const unsaved = [title, project, summary, itemsText].some((value) => value.trim().length > 0);

  const save = async (): Promise<void> => {
    if (!canSave) return;
    setSaving(true);
    setError(null);
    try {
      const result = await api.recordTodoList({
        title: title.trim(),
        ...(project.trim().length === 0 ? {} : { project: project.trim() }),
        ...(summary.trim().length === 0 ? {} : { summary: summary.trim() }),
        // Said either way: what was shown ticked is what is made, whatever the App would choose.
        longTerm,
        items: items.map((item) => ({ title: item })),
      });
      if ((result.status === "created" || result.status === "duplicate") && result.list !== null) {
        onRecorded(result, items.length === 0);
        return;
      }
      setError("清单没有写进去，请稍后再试。");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
  };

  return (
    <ModalDialog
      title="新建清单"
      description="清单会作为一篇笔记存进 Obsidian 的 Decision Journal/todos，在这里、由 agent 或在 Obsidian 里勾选都可以。"
      dismissible={!saving}
      unsaved={unsaved}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="secondary-button" disabled={saving} onClick={onClose}>取消</button>
          <button type="submit" form={`${id}-form`} className="primary-button" disabled={!canSave}>
            {saving ? "正在创建…" : "创建清单"}
          </button>
        </>
      }
    >
      <form
        id={`${id}-form`}
        className="todo-create-form"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
        onKeyDown={(event) => {
          if (!isSubmitShortcut(event)) return;
          event.preventDefault();
          void save();
        }}
      >
        <fieldset className="form-fields" disabled={saving}>
          <div className="form-field">
            <label htmlFor={`${id}-title`}>标题</label>
            <input
              id={`${id}-title`}
              maxLength={TODO_LIMITS.title}
              placeholder="如：官网首页加载性能调研"
              value={title}
              onChange={(event) => setTitle(event.currentTarget.value)}
            />
          </div>
          <div className="form-field">
            <label htmlFor={`${id}-project`}>项目（可选）</label>
            <input
              id={`${id}-project`}
              maxLength={TODO_LIMITS.project}
              placeholder="如 paraself"
              value={project}
              onChange={(event) => setProject(event.currentTarget.value)}
            />
          </div>
          <div className="form-field">
            <label htmlFor={`${id}-summary`}>摘要（可选）</label>
            <textarea
              id={`${id}-summary`}
              rows={2}
              maxLength={TODO_LIMITS.summary}
              placeholder="这份清单从哪来、按什么排的"
              value={summary}
              onChange={(event) => setSummary(event.currentTarget.value)}
            />
          </div>
          <div className="form-field">
            <label htmlFor={`${id}-items`}>事项（可选）</label>
            <textarea
              id={`${id}-items`}
              className="todo-create-items"
              rows={6}
              placeholder={"每行一项，例如：\n首屏大图改用 AVIF\n中文字体按需子集化"}
              aria-describedby={`${id}-items-help`}
              aria-invalid={problem === null ? undefined : true}
              value={itemsText}
              onChange={(event) => setItemsText(event.currentTarget.value)}
            />
            {problem === null ? (
              <p id={`${id}-items-help`}>
                每行一项，空行会忽略；一次最多 {TODO_LIMITS.itemsPerCall} 项。
                {items.length > 0 ? `已写 ${items.length} 项。` : "也可以先空着，建好后再逐项添加。"}
              </p>
            ) : (
              <p id={`${id}-items-help`} className="form-field-error" role="status">{problem}</p>
            )}
          </div>
          <div className="form-field todo-create-long-term">
            <label>
              <input
                type="checkbox"
                checked={longTerm}
                aria-describedby={`${id}-long-term-help`}
                onChange={(event) => setLongTermChoice(event.currentTarget.checked)}
              />
              长期清单
            </label>
            <p id={`${id}-long-term-help`}>
              一直留在「未完成」里，适合日常、学习这类随时往里加的清单；不勾选的清单在所有事项处理完后收进「全部」。
            </p>
          </div>
        </fieldset>
        {error === null ? null : <p className="form-error todo-create-error" role="alert">创建失败：{error}</p>}
      </form>
    </ModalDialog>
  );
};
