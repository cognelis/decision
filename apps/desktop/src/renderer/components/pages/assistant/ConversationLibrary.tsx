import { IconButton, ActionIcon } from "../../IconButton.js";
import { useEffect, useRef, useState } from "react";
import { isClearShortcut } from "../../../keyboard.js";
import { byRecency, conversationTitle, type AssistantConversation } from "./assistant-session.js";

export const ConversationLibrary = ({ active, conversations, disabled, onOpen, onRename, onFavorite }: {
  active: AssistantConversation;
  conversations: AssistantConversation[];
  disabled: boolean;
  onOpen(conversation: AssistantConversation): void;
  onRename(title: string): void;
  onFavorite(): void;
}) => {
  const [query, setQuery] = useState("");
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  // Renamed or let be, the form goes with the field that had focus: focus goes back to 重命名, where it was left on
  // the window and Tab started over at its top.
  const listRef = useRef<HTMLUListElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [renameEnded, setRenameEnded] = useState(0);
  useEffect(() => {
    if (renameEnded === 0) return;
    // Disabled while a reply runs, 重命名 takes no focus and it was left on the window: the search field then, which
    // never is.
    (listRef.current?.querySelector<HTMLElement>('[aria-label="重命名"]:not(:disabled)') ?? searchRef.current)?.focus();
  }, [renameEnded]);
  const endRename = (): void => {
    setEditingId(null);
    setRenameEnded((value) => value + 1);
  };
  const needle = query.trim().toLocaleLowerCase();
  const matches = byRecency(conversations).filter((conversation) =>
    (!favoritesOnly || conversation.favorite) &&
    (!needle || [conversationTitle(conversation), conversation.draft, ...conversation.messages.map((message) => message.content)]
      .some((text) => text.toLocaleLowerCase().includes(needle))),
  ).sort((left, right) => Number(Boolean(right.favorite)) - Number(Boolean(left.favorite)));

  return <div className="assistant-library assistant-session-library">
    <div className="assistant-library-body">
      <div className="assistant-library-tools">
        <div className="assistant-search-field">
          <ActionIcon name="search" />
          <input ref={searchRef} type="search" aria-label="搜索会话标题和正文" placeholder="搜索会话" value={query} onChange={(event) => setQuery(event.target.value)} />
        </div>
        <button type="button" className="assistant-filter" aria-label="只看收藏" aria-pressed={favoritesOnly} onClick={() => setFavoritesOnly((value) => !value)}><ActionIcon name="star" /><span>收藏</span></button>
      </div>
      <ul className="assistant-library-list" aria-label="会话搜索结果" ref={listRef}>
        {matches.map((conversation) => {
          const current = conversation.id === active.id;
          return <li key={conversation.id} className={current ? "current" : ""}>
            {current && editingId === active.id ? <form className="assistant-rename" onSubmit={(event) => {
              event.preventDefault();
              if (disabled) return;
              const title = String(new FormData(event.currentTarget).get("title") ?? "").trim();
              if (title && title.length <= 200) { onRename(title); endRename(); }
            }}>
              <input name="title" aria-label="当前会话名称" defaultValue={conversationTitle(active)} maxLength={200} required disabled={disabled} autoFocus onKeyDown={(event) => { if (isClearShortcut(event)) { event.stopPropagation(); endRename(); } }} />
              <IconButton type="submit" aria-label="保存名称" disabled={disabled}><ActionIcon name="check" /></IconButton>
              <IconButton aria-label="取消重命名" onClick={endRename}><ActionIcon name="close" /></IconButton>
            </form> : <>
              <button type="button" className="assistant-conversation-row" data-conversation-id={conversation.id} disabled={disabled} aria-current={current ? "true" : undefined} onClick={() => { setEditingId(null); onOpen(conversation); }}>
                <span className="assistant-conversation-title">{conversation.favorite ? <ActionIcon name="star" /> : null}<span>{conversationTitle(conversation)}</span></span>
                <small>{current ? "当前" : `${conversation.messages.length} 条消息`}</small>
              </button>
              {current ? <div className="assistant-row-actions">
                <IconButton aria-label="重命名" disabled={disabled} onClick={() => setEditingId(active.id)}><ActionIcon name="edit" /></IconButton>
                <IconButton aria-label={active.favorite ? "取消收藏" : "收藏此对话"} disabled={disabled} aria-pressed={Boolean(active.favorite)} onClick={onFavorite}><ActionIcon name="star" /></IconButton>
              </div> : null}
            </>}
          </li>;
        })}
      </ul>
      {matches.length === 0 ? <p className="assistant-library-empty" role="status">没有匹配的会话。</p> : null}
    </div>
  </div>;
};
