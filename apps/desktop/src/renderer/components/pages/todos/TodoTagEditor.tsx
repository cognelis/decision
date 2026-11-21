import { isTodoTag, TODO_LIMITS } from "@cognelis/decision-protocol";
import { useId, useState } from "react";

interface TodoTagEditorProps {
  tags: readonly string[];
  /** Tags already in use elsewhere, offered as the reader types. */
  known: readonly string[];
  disabled: boolean;
  onChange(tags: string[]): void;
}

/** An item's tags as chips with a field to add one: Enter adds, a chip's ✕ takes it off, Backspace in the empty field takes the last. */
export const TodoTagEditor = ({ tags, known, disabled, onChange }: TodoTagEditorProps) => {
  const id = useId();
  const [draft, setDraft] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const lower = (tag: string): string => tag.toLocaleLowerCase("zh-CN");
  const add = (): void => {
    const tag = draft.trim().replace(/^[#＃]/u, "");
    if (tag.length === 0) return;
    if (!isTodoTag(tag)) {
      setProblem("标签只能写字母（含中文）、数字、_ - /，不能全是数字。");
      return;
    }
    if (tags.length >= TODO_LIMITS.itemTags) {
      setProblem(`一项最多 ${TODO_LIMITS.itemTags} 个标签。`);
      return;
    }
    setDraft("");
    setProblem(null);
    if (!tags.some((existing) => lower(existing) === lower(tag))) onChange([...tags, tag]);
  };
  return (
    <div className="todo-tag-editor">
      <label htmlFor={`${id}-field`}>标签</label>
      <div className="todo-tag-box">
        {tags.map((tag) => (
          <span key={tag} className="todo-tag todo-tag-chip">
            #{tag}
            <button type="button" aria-label={`去掉标签 #${tag}`} disabled={disabled} onClick={() => onChange(tags.filter((existing) => existing !== tag))}>✕</button>
          </span>
        ))}
        <input
          id={`${id}-field`}
          list={`${id}-known`}
          value={draft}
          disabled={disabled}
          autoComplete="off"
          maxLength={60}
          placeholder={tags.length === 0 ? "输入标签回车，已有标签会联想" : "加标签"}
          aria-describedby={problem === null ? undefined : `${id}-problem`}
          onChange={(event) => {
            setDraft(event.currentTarget.value);
            setProblem(null);
          }}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (event.key === "Enter") {
              event.preventDefault();
              add();
            } else if (event.key === "Backspace" && draft.length === 0 && tags.length > 0) {
              onChange(tags.slice(0, -1));
            }
          }}
        />
        <datalist id={`${id}-known`}>
          {known.filter((tag) => !tags.some((existing) => lower(existing) === lower(tag))).map((tag) => <option key={tag} value={tag} />)}
        </datalist>
      </div>
      {problem === null ? null : <p id={`${id}-problem`} className="form-field-error" role="status">{problem}</p>}
    </div>
  );
};
