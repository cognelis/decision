import { ListWidthHandle } from "../../ListWidthHandle.js";
import { ActionIcon, IconButton } from "../../IconButton.js";
import type {
  AssistantFeedbackInput,
  AssistantFeedbackRating,
  AssistantMessage,
  AssistantStep,
  AssistantProgress,
  RetrievalAnswerCitation,
  RetrievalAnswerProvider,
  RetrievalAnswerScope,
} from "@cognelis/decision-protocol";
import { ASSISTANT_MAX_MESSAGES, ASSISTANT_MAX_MESSAGE_CHARS, ASSISTANT_MAX_FEEDBACK_NOTE_CHARS, clipText } from "@cognelis/decision-protocol";
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";

import type { DecisionApi } from "../../../../shared/renderer-api.js";
import {
  ActiveRecordDialog,
  type ActiveRecordDraft,
} from "../decisions/ActiveRecordDialog.js";
import { DesktopPageHeader } from "../DesktopPageHeader.js";
import { ModalDialog, PageHidden } from "../../ModalDialog.js";
import { SourcePicker } from "./SourcePicker.js";
import { ConversationLibrary } from "./ConversationLibrary.js";
import { AnswerEvidence, citationStanding, citationTarget } from "./AnswerEvidence.js";
import {
  byRecency,
  conversationTitle,
  emptyConversation,
  loadSessions,
  saveSessions,
  type AssistantConversation,
  type AssistantSessions,
} from "./assistant-session.js";

export type AssistantApi = Pick<
  DecisionApi,
  | "checkAssistantSource"
  | "searchAssistantSources"
  | "runAssistantTurn"
  | "cancelAssistantTurn"
  | "saveAssistantFeedback"
  | "createProactiveRecord"
  | "exportAssistantConversation"
  | "listAssistantModels"
  | "openVaultDocument"
  | "onAssistantProgress"
  | "forgetAssistantTurns"
>;

interface AssistantPanelProps {
  api: AssistantApi;
  hidden?: boolean;
  onOpenDecision(id: string): void;
  onOpenJournalEntry(id: string): void;
  onOpenPrinciple(id: string): void;
  /** A conversation picked elsewhere (quick jump), opened here as if from the list. */
  openConversationId?: { id: string } | null;
  /** The vault open now: its conversations are kept apart from another vault's. */
  vault?: string | null;
}

/**
 * The stored value stays `decisions` — conversations on disk carry it — but the
 * scope has never been only decisions: it is everything this app recorded
 * itself, which now includes preferences and ideas as well as principles.
 */
const NO_CITATIONS: readonly RetrievalAnswerCitation[] = [];

const SCOPES: ReadonlyArray<{ key: RetrievalAnswerScope; label: string }> = [
  { key: "all", label: "全部" },
  { key: "decisions", label: "Decision 记录" },
  { key: "obsidian", label: "Obsidian" },
];

const providerLabel = (provider: RetrievalAnswerProvider): string =>
  provider.model === null
    ? provider.label
    : `${provider.label} · ${provider.model}`;

const answerProviderLabel = (provider: RetrievalAnswerProvider): string =>
  `模型：${providerLabel(provider)} · ${provider.leavesDevice ? "远端回答" : "本机回答"}`;

const compactCount = (value: number): string =>
  value < 1_000 ? `${value}` : `${(value / 1_000).toFixed(1)}k`;

/**
 * A floor is not a bill: when some steps reported nothing, say so rather than
 * printing a total that reads as exact.
 */
const tokenLabel = (
  tokens: NonNullable<AssistantMessage["tokens"]>,
): string => {
  const total = compactCount(tokens.input + tokens.output);
  const detail = `输入 ${compactCount(tokens.input)} · 输出 ${compactCount(
    tokens.output,
  )}`;
  const money =
    tokens.cost === undefined
      ? ""
      : ` ≈ ${tokens.cost.currency}${tokens.cost.amount.toFixed(
          tokens.cost.amount < 1 ? 4 : 2,
        )}`;
  return tokens.unreportedSteps === 0
    ? `本轮 ${total} tokens（${detail}）${money}`
    : `本轮至少 ${total} tokens（${detail}；${tokens.unreportedSteps} 步未报告用量）${money}`;
};

const stepLabel = (step: AssistantStep): string => {
  if (step.kind === "search") {
    return `检索「${step.query ?? ""}」· ${step.hits ?? 0} 条${step.title === undefined ? "" : ` · ${step.title}`}`;
  }
  if (step.kind === "read") {
    const linked = step.hits ?? 0;
    return linked === 0
      ? `读全文《${step.title ?? ""}》`
      : `读全文《${step.title ?? ""}》· 顺带 ${linked} 条链接笔记`;
  }
  if (step.kind === "step_limit") return step.title ?? "检索或读取受到限制，使用已有材料作答";
  return "作答";
};

export const AssistantPanel = (props: AssistantPanelProps) => {
  const readHistory = (): AssistantSessions | null => {
    try {
      return loadSessions(props.vault);
    } catch {
      return null;
    }
  };
  const [restored, setRestored] = useState(readHistory);
  if (restored !== null) return <AssistantConversationPanel {...props} restored={restored} />;
  return (
    <section className="desktop-view assistant-panel" hidden={props.hidden} style={props.hidden ? { display: "none" } : undefined}>
      <DesktopPageHeader eyebrow="助手" title="问答" description="读取本机对话历史后继续问答" />
      <div className="assistant-content">
        <p className="error-message" role="alert">无法读取本机对话历史，尚未覆盖或删除原数据。请恢复存储访问或修复历史数据后重试。</p>
        <button type="button" className="secondary-button" onClick={() => setRestored(readHistory())}>重试读取历史</button>
      </div>
    </section>
  );
};

const AssistantConversationPanel = ({
  api,
  hidden = false,
  onOpenDecision,
  onOpenJournalEntry,
  onOpenPrinciple,
  openConversationId = null,
  vault = null,
  restored,
}: AssistantPanelProps & { restored: AssistantSessions }) => {
  // App keeps this panel mounted across page switches so in-flight answers
  // can finish saving; completed conversations also survive an App restart.
  const [activeId, setActiveId] = useState(restored.activeId);
  // Everything but the open conversation. Keeping the active one in working
  // state instead of inside this list means switching is an explicit swap
  // rather than two copies of the truth drifting apart.
  const [others, setOthers] = useState<AssistantConversation[]>(() =>
    restored.conversations.filter(
      (conversation) => conversation.id !== restored.activeId,
    ),
  );
  const [models, setModels] = useState<RetrievalAnswerProvider[]>([]);
  const [modelsStatus, setModelsStatus] = useState<"loading" | "ready" | "failed">("loading");
  const [modelsReload, setModelsReload] = useState(0);
  const opened =
    restored.conversations.find(
      (conversation) => conversation.id === restored.activeId,
    ) ?? emptyConversation();
  const [title, setTitle] = useState(opened.title);
  const [favorite, setFavorite] = useState(opened.favorite ?? false);
  const [selectedSources, setSelectedSources] = useState(opened.selectedSources);
  const sourcesMissing = selectedSources?.length === 0;
  const [profileId, setProfileId] = useState<string | null>(opened.profileId);
  const [scope, setScope] = useState<RetrievalAnswerScope>(opened.scope);
  const [messages, setMessages] = useState<AssistantMessage[]>(
    opened.messages,
  );
  const [updatedAt, setUpdatedAt] = useState(opened.updatedAt);
  const [input, setInput] = useState(opened.draft);
  const hasContent = messages.length > 0 || input.trim().length > 0;
  // Asked, typed, named, starred or given material: kept when left, so it can be deleted too.
  const worthKeeping = hasContent || title.trim() !== "" || favorite || selectedSources !== undefined;
  const inputTooLong = input.trim().length > ASSISTANT_MAX_MESSAGE_CHARS;
  const inputErrorId = useId();
  const modelErrorId = useId();
  // A model-list refresh must not relabel a call already sent to its provider.
  const [runningProvider, setRunningProvider] = useState<RetrievalAnswerProvider | null>(null);
  const running = runningProvider !== null;
  const [exporting, setExporting] = useState(false);
  const exportInFlight = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [storageFailed, setStorageFailed] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [openSteps, setOpenSteps] = useState<number | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);
  const openRequest = useRef(0);
  const [progress, setProgress] = useState<AssistantStep[]>([]);
  // Keyed by turn id so a rating cannot land on another conversation's answer.
  const [rated, setRated] = useState(() => new Map<string, AssistantFeedbackRating>(
    restored.conversations.flatMap((conversation) => Object.entries(conversation.ratings ?? {})),
  ));
  const [notes, setNotes] = useState(() => new Map<string, string>());
  const [feedbackPending, setFeedbackPending] = useState<string | null>(null);
  const feedbackInFlight = useRef(false);
  const [feedbackError, setFeedbackError] = useState<string | null>(null);
  const feedbackErrorId = useId();
  const [showSources, setShowSources] = useState(false);
  const [deleteConversation, setDeleteConversation] = useState(false);
  const [navigationOpen, setNavigationOpen] = useState(false);
  const actionsRef = useRef<HTMLDetailsElement>(null);
  const followLatest = useRef(true);
  const [showLatest, setShowLatest] = useState(false);
  const [draft, setDraft] = useState<ActiveRecordDraft | null>(null);
  const turnRef = useRef<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const streamRef = useRef<HTMLDivElement>(null);
  const [visibleCount, setVisibleCount] = useState(40);
  const historyScroll = useRef<{ top: number; height: number } | null>(null);
  const firstVisible = Math.max(0, messages.length - visibleCount);
  useEffect(() => { setVisibleCount(40); historyScroll.current = null; followLatest.current = true; setShowLatest(false); }, [activeId]);
  useLayoutEffect(() => {
    const previous = historyScroll.current;
    const stream = streamRef.current;
    if (previous !== null && stream !== null) {
      stream.scrollTop = previous.top + stream.scrollHeight - previous.height;
      historyScroll.current = null;
    }
  }, [visibleCount]);


  useEffect(() => {
    // Not the record being written, kept out of sight with what was typed into it (below).
    if (hidden) { setShowSources(false); setDeleteConversation(false); if (actionsRef.current) actionsRef.current.open = false; }
  }, [hidden]);

  useEffect(() => {
    if (hidden) return;
    let active = true;
    setModelsStatus("loading");
    void api
      .listAssistantModels()
      .then((loaded) => {
        if (active) {
          setModels(loaded);
          setModelsStatus("ready");
        }
      })
      .catch(() => {
        if (active) {
          setModels([]);
          setModelsStatus("failed");
        }
      });
    return () => {
      active = false;
    };
  }, [api, hidden, modelsReload]);

  useEffect(() => {
    // Scrolling to the newest turn is a convenience, not a requirement: a DOM
    // without scrollTo must not take the conversation down with it.
    if (!hidden && followLatest.current && streamRef.current) {
      streamRef.current.scrollTop = streamRef.current.scrollHeight;
    }
  }, [messages, running, progress, activeId, hidden]);

  const active: AssistantConversation = {
    id: activeId,
    title,
    favorite,
    selectedSources,
    updatedAt,
    profileId,
    scope,
    messages,
    draft: input,
    // This conversation's answers only: the map holds every conversation's.
    ratings: Object.fromEntries(
      messages.flatMap((message) => {
        const rating = message.turnId === undefined ? undefined : rated.get(message.turnId);
        return message.turnId === undefined || rating === undefined ? [] : [[message.turnId, rating] as const];
      }),
    ),
  };

  const persistConversations = (): void => {
    const pending = messages.at(-1);
    // An interrupted App cannot resume the model call. Keep the last complete
    // history and an editable question instead of persisting a stranded turn.
    const snapshot = turnRef.current !== null && pending?.role === "user"
      ? { ...active, messages: messages.slice(0, -1), draft: pending.content }
      : active;
    setStorageFailed(!saveSessions({ activeId, conversations: [snapshot, ...others] }, vault));
  };

  // Typing a question changes the sessions on every key, and every conversation is written each time; they are
  // written once the typing pauses, not key by key. Whatever is still waiting is written when the window goes away.
  const typing = useRef(false);
  const unsaved = useRef<(() => void) | null>(null);
  useEffect(() => {
    const save = () => {
      unsaved.current = null;
      persistConversations();
    };
    const paused = typing.current;
    typing.current = false;
    if (!paused) { save(); return; }
    unsaved.current = save;
    const timer = setTimeout(save, 600);
    return () => clearTimeout(timer);
    // `active` is rebuilt every render; its parts are the real dependencies.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId, title, favorite, selectedSources, profileId, scope, messages, input, updatedAt, others, rated]);
  useEffect(() => {
    const flush = () => unsaved.current?.();
    window.addEventListener("pagehide", flush);
    return () => { window.removeEventListener("pagehide", flush); flush(); };
  }, []);

  useEffect(
    () =>
      api.onAssistantProgress((event: AssistantProgress) => {
        // A step from an abandoned turn would describe work nobody is waiting
        // on, so anything but the turn in flight is dropped.
        if (event.turnId !== turnRef.current) return;
        setProgress((current) => [...current, event.step]);
      }),
    [api],
  );

  const selected = runningProvider ?? (profileId === null
    ? models[0]
    : models.find((candidate) => candidate.profileId === profileId)) ?? null;
  const displayedModels = runningProvider === null
    ? models
    : [runningProvider, ...models.filter((model) => model.profileId !== runningProvider.profileId)];
  const missingModel = profileId !== null && selected === null && models.length > 0;

  /**
   * A turn that produced no answer gives the question back to the composer.
   * Left in the conversation it is stranded there with no reply, and every
   * later turn sends it again as history.
   */
  const handBackQuestion = (history: AssistantMessage[]): void => {
    const pending = history.at(-1);
    setMessages(history.slice(0, -1));
    setUpdatedAt(Date.now());
    if (pending?.role === "user") setInput(pending.content);
  };

  const send = (history: AssistantMessage[]): void => {
    followLatest.current = true; setShowLatest(false);
    setRunningProvider(selected);
    setError(null);
    setProgress([]);
    const turnId = `turn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    turnRef.current = turnId;
    const target = selected?.profileId;
    void api
      .runAssistantTurn({
        // Reserve a slot for the answer in the stored window. Bound the sent
        // context without discarding history still displayed in this window.
        messages: history.slice(-(ASSISTANT_MAX_MESSAGES - 1)),
        scope,
        ...(selectedSources === undefined ? {} : { selectedSources }),
        turnId,
        ...(target === undefined ? {} : { profileId: target }),
      })
      .then((response) => {
        turnRef.current = null;
        setRunningProvider(null);
        setError(null);
        if (response.status === "answered") {
          setTitle((current) => current || conversationTitle({ ...active, messages: history }));
          setMessages([...history, { ...response.message, provider: response.provider }]);
          // A cut answer is said as one: told only that the search was limited, the reader took it for complete.
          const notices = [
            ...(response.answerCut === true ? ["回答超过 4000 字，后面的部分没有显示。"] : []),
            ...(response.truncated ? ["本轮部分检索或读取受到限制，回答基于已有材料。"] : []),
          ];
          setNotice(notices.length === 0 ? null : notices.join(""));
          return;
        }
        // Spent before it stopped or failed, and billed all the same: said only on an answer, it went unseen.
        const spent = response.tokens === undefined ? "" : `${tokenLabel(response.tokens)}。`;
        if (response.status === "cancelled") {
          // A stopped turn usually means the reader wants to reword it.
          handBackQuestion(history);
          setNotice(`已停止这一轮。${spent}`);
          return;
        }
        handBackQuestion(history);
        setError(`${response.message}${spent}`);
      })
      .catch((caught: unknown) => {
        turnRef.current = null;
        setRunningProvider(null);
        handBackQuestion(history);
        setError(
          caught instanceof Error
            ? caught.message
            : "这一轮没能完成，请稍后重试。",
        );
      });
  };

  const stop = async (): Promise<void> => {
    const turnId = turnRef.current;
    if (turnId === null) return;
    setError(null);
    try {
      await api.cancelAssistantTurn(turnId);
    } catch {
      // The answer may finish before the cancellation request settles.
      if (turnRef.current === turnId) {
        setError("停止请求未能确认，请再次点击“停止”。本轮仍在等待结果。");
      }
    }
  };

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    const question = input.trim();
    // The turn id is set synchronously; React's running state may still be
    // stale when another submit arrives before the next render.
    if (question.length === 0 || sourcesMissing || inputTooLong || turnRef.current !== null || exportInFlight.current || modelsStatus !== "ready" || selected === null) return;
    const history: AssistantMessage[] = [
      ...messages,
      { role: "user", content: question },
    ];
    setMessages(history);
    setUpdatedAt(Date.now());
    setInput("");
    send(history);
  };

  /** Puts the working copy away and opens another conversation in its place. */
  const openConversation = (conversation: AssistantConversation): void => {
    if (turnRef.current !== null || exportInFlight.current || feedbackInFlight.current || conversation.id === activeId) return;
    setNavigationOpen(false);
    // One with nothing in it (nothing asked, typed, named, starred or picked) is let go, as "新对话" lets it go: kept,
    // it would pile up as rows that cannot be deleted.
    setOthers((current) => [
      ...(worthKeeping ? [active] : []),
      ...current.filter((entry) => entry.id !== conversation.id && entry.id !== active.id),
    ]);
    setActiveId(conversation.id);
    setTitle(conversation.title);
    setFavorite(conversation.favorite ?? false);
    setSelectedSources(conversation.selectedSources);
    setProfileId(conversation.profileId);
    setScope(conversation.scope);
    setMessages(conversation.messages);
    setUpdatedAt(conversation.updatedAt);
    setInput(conversation.draft);
    setError(null);
    setFeedbackError(null);
    setNotice(null);
    openRequest.current += 1;
    setOpenError(null);
    setOpenSteps(null);
  };

  // Picked elsewhere (⌘K) while an answer, an export or feedback is in flight: opened once that is done,
  // saying so meanwhile; and only once, so a later turn does not pull the reader back to it.
  const openedRequest = useRef<{ id: string } | null>(null);
  const openWaited = useRef(false);
  useEffect(() => {
    if (openConversationId === null || openedRequest.current === openConversationId) return;
    const target = others.find((entry) => entry.id === openConversationId.id);
    if (target !== undefined && (running || exporting || feedbackPending !== null)) {
      openWaited.current = true;
      setNotice("当前回答或操作完成后会打开所选会话。");
      return;
    }
    openedRequest.current = openConversationId;
    const waited = openWaited.current;
    openWaited.current = false;
    // What it waited for failed: the reason stays in view where it happened
    // rather than being switched away from, and cleared on the way.
    if (target !== undefined && waited && (error !== null || feedbackError !== null)) {
      setNotice("这一步没有完成，所以没有打开所选会话；可以再从快速跳转打开它。");
      return;
    }
    if (target !== undefined) openConversation(target);
  }, [openConversationId, running, exporting, feedbackPending]);

  const branchConversation = (index: number, editQuestion: boolean): void => {
    if (turnRef.current !== null || exportInFlight.current || feedbackInFlight.current) return;
    const message = messages[index];
    if (message === undefined) return;
    openConversation({
      ...emptyConversation(),
      title: `${conversationTitle(active)} · 分支`.slice(0, 200),
      profileId,
      scope,
      selectedSources,
      messages: messages.slice(0, editQuestion ? index : index + 1),
      draft: editQuestion ? message.content : "",
    });
    inputRef.current?.focus();
  };

  /** Drops the open conversation for good and opens the next most recent. */
  const forget = (): void => {
    if (turnRef.current !== null || exportInFlight.current || feedbackInFlight.current) return;
    // Its answers' call records and ratings go with it: kept, its question and the notes read for it stayed on this
    // Mac after 删除. A turn another conversation still holds (a branch of it, or the one it branched from) stays.
    const kept = new Set(others.flatMap((conversation) => conversation.messages.flatMap((message) => message.turnId ?? [])));
    const turnIds = [...new Set(messages.flatMap((message) => message.turnId ?? []))].filter((turnId) => !kept.has(turnId));
    if (turnIds.length > 0) {
      void api.forgetAssistantTurns(turnIds).catch(() =>
        setNotice("对话已删除，但它的模型调用记录和评分这次没能一并删除；调用记录可以在「日志」里删除。"));
    }
    const [next, ...rest] = byRecency(others);
    const replacement = next ?? emptyConversation();
    setOthers(next === undefined ? [] : rest);
    setActiveId(replacement.id);
    setTitle(replacement.title);
    setFavorite(replacement.favorite ?? false);
    setSelectedSources(replacement.selectedSources);
    setProfileId(replacement.profileId);
    setScope(replacement.scope);
    setMessages(replacement.messages);
    setUpdatedAt(replacement.updatedAt);
    setInput(replacement.draft);
    setError(null);
    setFeedbackError(null);
    setNotice(null);
    openRequest.current += 1;
    setOpenError(null);
    setOpenSteps(null);
  };

  const reset = (): void => {
    if (turnRef.current !== null || exportInFlight.current || feedbackInFlight.current) return;
    // The conversation being left is kept, not erased: "新对话" used to be the
    // only way to start over and it took the previous one with it.
    setNavigationOpen(false);
    const fresh = emptyConversation();
    setOthers((current) =>
      worthKeeping ? [active, ...current] : current,
    );
    setActiveId(fresh.id);
    setTitle(fresh.title);
    setFavorite(fresh.favorite ?? false);
    setSelectedSources(fresh.selectedSources);
    setUpdatedAt(fresh.updatedAt);
    setMessages([]);
    setInput("");
    setError(null);
    setFeedbackError(null);
    setNotice(null);
    setOpenSteps(null);
    openRequest.current += 1;
    setOpenError(null);
    inputRef.current?.focus();
  };

  const openCitation = useCallback((citation: RetrievalAnswerCitation): void => {
    const request = ++openRequest.current;
    setOpenError(null);
    const target = citationTarget(citation);
    if (target.kind === "decision") {
      onOpenDecision(target.id);
      return;
    }
    if (target.kind === "principle") {
      onOpenPrinciple(target.id);
      return;
    }
    if (target.kind === "journal") {
      onOpenJournalEntry(target.id);
      return;
    }
    void api.openVaultDocument(target.reference).catch((caught: unknown) => {
      if (request !== openRequest.current) return;
      setOpenError(
        caught instanceof Error
          ? caught.message
          : `没能打开《${target.reference}》，它可能已被移动或还没进索引。`,
      );
    });
  }, [api, onOpenDecision, onOpenPrinciple, onOpenJournalEntry]);

  const persistFeedback = async (input: AssistantFeedbackInput): Promise<boolean> => {
    if (feedbackInFlight.current) return false;
    feedbackInFlight.current = true;
    setFeedbackPending(input.turnId);
    setFeedbackError(null);
    try {
      const result = await api.saveAssistantFeedback(input);
      if (result.status !== "saved") throw new Error("Feedback unavailable");
      setRated((current) => new Map(current).set(input.turnId, input.rating));
      return true;
    } catch {
      setFeedbackError("评价未能保存，已填写的说明仍保留，可以稍后再试；一直存不进去时，「日志」里的问答评分会说明原因。");
      return false;
    } finally {
      feedbackInFlight.current = false;
      setFeedbackPending(null);
    }
  };

  const rate = async (
    message: AssistantMessage,
    question: string,
    rating: AssistantFeedbackRating,
  ): Promise<void> => {
    const turnId = message.turnId;
    if (turnId === undefined) return;
    const saved = await persistFeedback({
      turnId,
      rating,
      question,
      citedReferences: (message.citations ?? []).map((citation) => citation.reference),
    });
    if (saved && rating === "not_helpful") {
      setNotes((current) => new Map(current).set(turnId, ""));
    }
  };

  const submitNote = async (message: AssistantMessage, question: string): Promise<void> => {
    const turnId = message.turnId;
    const rating = turnId === undefined ? undefined : rated.get(turnId);
    if (turnId === undefined || rating === undefined) return;
    const note = notes.get(turnId) ?? "";
    if (note.trim().length > ASSISTANT_MAX_FEEDBACK_NOTE_CHARS) {
      setFeedbackError(`说明最多 ${ASSISTANT_MAX_FEEDBACK_NOTE_CHARS} 个字符，请缩短后重试。`);
      return;
    }
    const saved = await persistFeedback({
      turnId,
      rating,
      question,
      ...(note.trim().length === 0 ? {} : { note: note.trim() }),
      citedReferences: (message.citations ?? []).map((citation) => citation.reference),
    });
    if (saved) {
      setNotes((current) => {
        const remaining = new Map(current);
        remaining.delete(turnId);
        return remaining;
      });
    }
  };

  /**
   * Hands the answer to the manual record form as a starting draft. The
   * assistant still writes nothing: the reader edits it and saves it, and the
   * record is filed as their paraphrase rather than as their own words.
   */
  const draftRecord = (message: AssistantMessage, question: string): void => {
    // Numbered as the answer's [n] are, and flagged as the page flags them.
    const cited = (message.citations ?? []).map((citation) => {
      const standing = citationStanding(citation);
      return `[${citation.index}] ${citation.title}（${citation.reference}${standing === null ? "" : `，${standing}`}）`;
    });
    setDraft({
      title: question.length > 0 ? question : "来自问答的记录",
      content: message.content,
      ...(cited.length === 0
        ? {}
        : { rationale: `依据：\n${cited.join("\n")}` }),
    });
  };

  /**
   * Markdown, because that is what the rest of this app stores and what the
   * reader already reads. Citations come out as paths so the exported file
   * still points back at the sources rather than standing alone.
   */
  const asMarkdown = (): string => {
    const lines = [`# ${conversationTitle(active)}`, ""];
    for (let position = 0; position < messages.length; position += 1) {
      const message = messages[position]!;
      lines.push(message.role === "user" ? "## 问" : "## 答", "");
      if (message.role === "assistant" && message.provider !== undefined) {
        lines.push(answerProviderLabel(message.provider), "");
      }
      lines.push(message.content, "");
      for (const citation of message.citations ?? []) {
        const standing = citationStanding(citation);
        lines.push(`- [${citation.index}] ${citation.title} — ${citation.reference}${standing === null ? "" : `（${standing}）`}`);
      }
      if ((message.citations ?? []).length > 0) lines.push("");
    }
    if (input.trim().length > 0) lines.push("## 未发送的草稿", "", input, "");
    return lines.join("\n");
  };

  const exportConversation = async (): Promise<void> => {
    if (!hasContent || turnRef.current !== null || exportInFlight.current) return;
    exportInFlight.current = true;
    setExporting(true);
    setNotice(null);
    setError(null);
    try {
      const result = await api.exportAssistantConversation({
        // A renamed conversation's title runs to 200; the name, with ".md", is taken to 200 as well.
        suggestedName: `${clipText(conversationTitle(active), 196)}.md`,
        markdown: asMarkdown(),
      });
      if (result.status === "saved") setNotice("对话已导出。");
      if (result.status === "failed") setError("没能写入这个位置，换一个再试。");
    } catch {
      setError("没能导出这段对话。");
    } finally {
      exportInFlight.current = false;
      setExporting(false);
    }
  };

  const handleKeyDown = (
    event: ReactKeyboardEvent<HTMLTextAreaElement>,
  ): void => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      submit(event as unknown as FormEvent);
    }
  };

  return (
    <section
      className="desktop-view assistant-panel"
      hidden={hidden}
      style={hidden ? { display: "none" } : undefined}
    >
      <header className="desktop-view-header drag-region"><div><h1>问答</h1><p>从自己的决策、原则和笔记中寻找答案。</p></div><IconButton className="assistant-nav-toggle no-drag" aria-label="切换会话导航" aria-expanded={navigationOpen} aria-controls="assistant-navigation" onClick={() => setNavigationOpen(value => !value)}><ActionIcon name="panel" /></IconButton></header>

      {/* Out of sight while the page is, not closed: a captured decision taking the window threw away the edits. */}
      {draft === null ? null : (
        <PageHidden.Provider value={hidden}>
          <ActiveRecordDialog
            api={api}
            draft={draft}
            onClose={() => setDraft(null)}
            onSaved={() => {
              setDraft(null);
              setNotice("已保存为记录。");
            }}
          />
        </PageHidden.Provider>
      )}

      {showSources ? <ModalDialog title="材料范围" onClose={() => setShowSources(false)}>
        <div className="assistant-materials-dialog"><h3>检索范围</h3>
          <div className="assistant-scope" role="group" aria-label="检索范围">
            {SCOPES.map((entry) => (
              <button
                key={entry.key}
                type="button"
                aria-pressed={scope === entry.key}
                disabled={running || selectedSources !== undefined}
                onClick={() => setScope(entry.key)}
              >
                {entry.label}
              </button>
            ))}
          </div>
        <SourcePicker key={activeId} api={api} sources={selectedSources} disabled={running || exporting || feedbackPending !== null} onChange={(sources) => {
          if (turnRef.current !== null || exportInFlight.current || feedbackInFlight.current) return;
          setSelectedSources(sources);
        }} />
        <p className="assistant-source-hint">助手仅检索与回答，不会自动写入记录。</p></div>
      </ModalDialog> : null}
      {deleteConversation ? <ModalDialog title="删除对话" size="compact" onClose={() => setDeleteConversation(false)}>
        <p>删除「{conversationTitle(active)}」的本机对话和草稿，以及这些回答的模型调用记录和评分？引用的决策、原则和笔记不会被删除。</p>
        <div className="modal-form-actions"><button className="secondary-button" onClick={() => setDeleteConversation(false)}>取消</button><button className="primary-button" disabled={running || exporting || feedbackPending !== null} onClick={() => { forget(); setDeleteConversation(false); }}>确认删除</button></div>
      </ModalDialog> : null}
      <div className="assistant-workspace" data-navigation={navigationOpen}>
      <aside id="assistant-navigation" className="assistant-sidebar" aria-label="会话库">
        <div className="assistant-sidebar-heading"><h2>会话</h2><IconButton aria-label="新对话" disabled={running || exporting || feedbackPending !== null || !worthKeeping} onClick={reset}><ActionIcon name="edit" /></IconButton></div>
        <ConversationLibrary
          active={active}
          conversations={[active, ...others]}
          disabled={running || exporting || feedbackPending !== null}
          onOpen={openConversation}
          onRename={(value) => {
            if (turnRef.current !== null || exportInFlight.current || feedbackInFlight.current) return;
            setTitle(value);
          }}
          onFavorite={() => {
            if (turnRef.current !== null || exportInFlight.current || feedbackInFlight.current) return;
            setFavorite((value) => !value);
          }}
        />
        <p className="assistant-sidebar-foot">历史与草稿仅保存在本机</p>
      </aside>
      <ListWidthHandle storageKey="decision.assistant.list-width" label="调整会话列表宽度" controls="assistant-navigation" />
      <div className="assistant-content">
        <div className="assistant-conversation-heading"><div><h2>{conversationTitle(active)}</h2><p>{messages.length ? `${messages.length} 条消息` : "从一个问题开始"} · {selectedSources === undefined ? SCOPES.find(item => item.key === scope)?.label : `指定 ${selectedSources.length} 份材料`}</p></div>
          <details className="assistant-more" ref={actionsRef} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) event.currentTarget.open = false; }} onKeyDown={event => { if (event.key === "Escape") { event.currentTarget.open = false; event.currentTarget.querySelector("summary")?.focus(); } }}>
            <summary aria-label="对话操作"><ActionIcon name="more" /></summary><div className="assistant-more-menu">
              <button className="assistant-export" disabled={running || exporting || !hasContent} aria-busy={exporting} onClick={() => void exportConversation()}><ActionIcon name="download" />{exporting ? "正在导出…" : "导出"}</button>
              <button className="danger-text" disabled={running || exporting || feedbackPending !== null || !worthKeeping} onClick={() => { if (turnRef.current || exportInFlight.current || feedbackInFlight.current) return; actionsRef.current?.querySelector("summary")?.focus(); if (actionsRef.current) actionsRef.current.open = false; setDeleteConversation(true); }}><ActionIcon name="trash" />删除此对话</button>
            </div>
          </details>
        </div>
        <div className="assistant-stream" ref={streamRef} role="log" aria-label="问答消息" tabIndex={0} aria-live={hidden ? "off" : "polite"} onScroll={event => {
          const stream = event.currentTarget;
          const distance = stream.scrollHeight - stream.scrollTop - stream.clientHeight;
          if (distance <= 16) followLatest.current = true;
          else if (distance >= 64) followLatest.current = false;
          setShowLatest(!followLatest.current);
        }}>
          {messages.length === 0 ? (
            <div className="assistant-empty">
              <strong>问一句你自己的历史</strong>
              <span>
                比如「我们之前为什么决定把配置变更先留在测试环境？」。助手会自己决定检索什么、检索几轮，回答只用检索到的内容，并标注引用。
              </span>
            </div>
          ) : null}

          {firstVisible > 0 ? <button type="button" className="text-button" onClick={() => {
            const stream = streamRef.current;
            if (stream !== null) historyScroll.current = { top: stream.scrollTop, height: stream.scrollHeight };
            setVisibleCount((count) => count + 40);
          }}>加载更早的消息（还有 {firstVisible} 条）</button> : null}

          {messages.slice(firstVisible).map((message, position) => {
            const index = firstVisible + position;
            return message.role === "user" ? (
              <article key={index} className="assistant-turn user">
                <p>{message.content}</p>
                <IconButton type="button" className="assistant-action" aria-label="修改问题并分支" disabled={running || exporting || feedbackPending !== null} onClick={() => branchConversation(index, true)}><svg viewBox="0 0 20 20" aria-hidden="true"><path d="m12.5 3.5 4 4M3 17l4.5-1 10-10a1.4 1.4 0 0 0 0-2l-1.5-1.5a1.4 1.4 0 0 0-2 0L4 12.5 3 17Z" /></svg></IconButton>
              </article>
            ) : (
              <article key={`${activeId}-${index}`} className="assistant-turn assistant">
                <AnswerEvidence content={message.content} citations={message.citations ?? NO_CITATIONS} onOpen={openCitation} checkSource={api.checkAssistantSource} />

                <div className="assistant-keep" role="group" aria-label="回答操作">
                  <IconButton type="button" className="assistant-action" aria-label="从此处继续分支" disabled={running || exporting || feedbackPending !== null} onClick={() => branchConversation(index, false)}><svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="5" cy="4" r="2" /><circle cx="5" cy="16" r="2" /><circle cx="15" cy="5" r="2" /><path d="M5 6v8m0-2c6 0 10-1 10-5" /></svg></IconButton>
                  {message.citations?.length ? <IconButton type="button" className="assistant-action" aria-label="根据当前引用重新核对" disabled={running || exporting || feedbackPending !== null} onClick={() => {
                    if (turnRef.current !== null || exportInFlight.current || feedbackInFlight.current) return;
                    openConversation({
                      ...emptyConversation(),
                      title: `${conversationTitle(active)} · 重新核对`.slice(0, 200),
                      profileId, scope,
                      selectedSources: message.citations,
                      messages: messages.slice(0, Math.max(0, index - 1)),
                      draft: `请根据指定来源的当前内容，核对这条历史回答是否仍适用；说明需要修正的地方，材料不足时明确说明。\n\n原问题：${messages[index - 1]?.content ?? ""}\n\n历史回答：${message.content}`,
                    });
                    setNotice("已建立核对分支，请检查问题和材料后发送；原回答已保留。");
                  }}><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M16.5 7A7 7 0 1 0 17 12M16.5 2.5V7H12M7 10l2 2 4-4" /></svg></IconButton> : null}

                  <span className="assistant-action-divider" aria-hidden="true" />
                  <IconButton
                    type="button"
                    className="assistant-action"
                    aria-label="整理成记录"

                    onClick={() =>
                      draftRecord(message, messages[index - 1]?.content ?? "")
                    }
                  >
                    <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M11 3H4a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-7M7 7h3M7 11h2m4-6h5m-2.5-2.5v5" /></svg>
                  </IconButton>
                {message.turnId === undefined || messages[index - 1]?.role !== "user" || !messages[index - 1]?.content.trim() ? null : (
                  <div className="assistant-rate">
                    {feedbackPending === message.turnId ? <span role="status">正在保存评价…</span> : null}
                    {rated.get(message.turnId) === undefined ? (
                      <>
                        <IconButton
                          type="button"
                          className="assistant-action"
                          aria-label="有用"
                          disabled={feedbackPending !== null}
                          onClick={() =>
                            rate(
                              message,
                              messages[index - 1]?.content ?? "",
                              "helpful",
                            )
                          }
                        >
                          <svg viewBox="0 0 20 20" aria-hidden="true"><g><path d="M7 8 10 2c2 0 2.5 1.5 2 3l-.7 3H16a1.5 1.5 0 0 1 1.5 1.8l-1 6a1.5 1.5 0 0 1-1.5 1.2H7V8ZM3 8h4v9H3z" /></g></svg>
                        </IconButton>
                        <IconButton
                          type="button"
                          className="assistant-action"
                          aria-label="没用"
                          disabled={feedbackPending !== null}
                          onClick={() =>
                            rate(
                              message,
                              messages[index - 1]?.content ?? "",
                              "not_helpful",
                            )
                          }
                        >
                          <svg viewBox="0 0 20 20" aria-hidden="true"><g transform="rotate(180 10 10)"><path d="M7 8 10 2c2 0 2.5 1.5 2 3l-.7 3H16a1.5 1.5 0 0 1 1.5 1.8l-1 6a1.5 1.5 0 0 1-1.5 1.2H7V8ZM3 8h4v9H3z" /></g></svg>
                        </IconButton>
                      </>
                    ) : (
                      <span className="assistant-rated" role="status">
                        {rated.get(message.turnId) === "helpful"
                          ? "已记为有用"
                          : "已记为没用"}
                      </span>
                    )}
                  </div>
                )}
                </div>

                {message.turnId === undefined ||
                !notes.has(message.turnId) ? null : (
                  <form
                    className="assistant-rate-note"
                    onSubmit={(event) => {
                      event.preventDefault();
                      submitNote(message, messages[index - 1]?.content ?? "");
                    }}
                  >
                    <input
                      className="glass-input"
                      type="text"
                      value={notes.get(message.turnId) ?? ""}
                      disabled={feedbackPending !== null}
                      aria-label="哪里没用（可不填）"
                      aria-invalid={(feedbackError !== null && (notes.get(message.turnId) ?? "").trim().length > ASSISTANT_MAX_FEEDBACK_NOTE_CHARS) || undefined}
                      aria-describedby={feedbackError === null ? undefined : feedbackErrorId}
                      placeholder="哪里没用？可不填"
                      onChange={(event) => {
                        const value = event.target.value;
                        const turnId = message.turnId;
                        if (turnId !== undefined) setNotes((current) => new Map(current).set(turnId, value));
                        setFeedbackError(null);
                      }}
                    />
                    <button type="submit" className="secondary-button" disabled={feedbackPending !== null}>
                      记下
                    </button>
                  </form>
                )}

                {message.provider === undefined ? null : (
                  <p className="assistant-provider">{answerProviderLabel(message.provider)}</p>
                )}

                {message.tokens === undefined ? null : (
                  <p className="assistant-tokens">
                    {tokenLabel(message.tokens)}
                  </p>
                )}

                {message.steps === undefined ||
                message.steps.length === 0 ? null : (
                  <div className="assistant-steps">
                    <button
                      type="button"
                      aria-expanded={openSteps === index}
                      onClick={() =>
                        setOpenSteps(openSteps === index ? null : index)
                      }
                    >
                      {openSteps === index ? "隐藏推理过程" : "查看推理过程"} ·{" "}
                      {
                        message.steps.filter(
                          (step) =>
                            step.kind === "search" || step.kind === "read",
                        ).length
                      }{" "}
                      步
                    </button>
                    {openSteps === index ? (
                      <ol>
                        {message.steps.map((step, position) => (
                          <li key={position}>{stepLabel(step)}</li>
                        ))}
                      </ol>
                    ) : null}
                  </div>
                )}
              </article>
            );
          })}

          {running ? (
            <div className="assistant-running" role="status">
              <p>
                {selected?.leavesDevice === true
                  ? `已发送给 ${selected.label}，正在检索并回答…`
                  : "正在检索并回答…"}
              </p>
              {progress.length === 0 ? null : (
                <ol className="assistant-progress">
                  {progress.map((step, position) => (
                    <li key={position}>{stepLabel(step)}</li>
                  ))}
                </ol>
              )}
            </div>
          ) : null}
        </div>

        {modelsStatus === "loading" ? <p className="assistant-notice" role="status">正在加载回答模型…</p> : null}
        {modelsStatus === "failed" ? (
          <div className="error-message assistant-error" role="alert">
            无法读取回答模型列表，请重试。
            <button type="button" className="text-button" onClick={() => setModelsReload((value) => value + 1)}>重试加载模型</button>
          </div>
        ) : null}

        {missingModel ? (
          <p className="error-message assistant-error" role="status" id={modelErrorId}>
            原先选择的模型已不可用，请重新选择回答模型。问题已保留。
          </p>
        ) : null}

        {storageFailed ? (
          <div className="error-message assistant-error" role="alert">
            对话更改尚未保存到本机，关闭应用可能丢失。本机存储可能已满：删除不需要的对话后重试保存，或先导出需要保留的对话。
            <button type="button" className="text-button" onClick={persistConversations}>重试保存</button>
          </div>
        ) : null}

        {notice === null ? null : (
          <p className="assistant-notice" role="status">
            {notice}
          </p>
        )}

        {error === null ? null : (
          <p className="error-message assistant-error" role="alert">
            {error}
          </p>
        )}

        {openError === null ? null : (
          <p className="error-message assistant-error" role="alert">
            {openError}
          </p>
        )}

        {feedbackError === null ? null : (
          <p className="error-message assistant-error" id={feedbackErrorId} role="alert">
            {feedbackError}
          </p>
        )}

        {inputTooLong ? (
          <p className="error-message assistant-error" id={inputErrorId} role="alert">
            问题最多 {ASSISTANT_MAX_MESSAGE_CHARS} 个字符，请缩短后再发送。已输入的内容仍保留。
          </p>
        ) : null}

        <form className="assistant-composer" onSubmit={submit}>
          <div className="assistant-compose-box">
          <textarea
            ref={inputRef}
            className="glass-input"
            rows={2}
            value={input}
            // A placeholder is not a name: it is gone the moment the reader
            // types, and a screen reader is left with an unlabelled box.
            aria-label="问一句你自己的历史"
            aria-invalid={inputTooLong || undefined}
            aria-describedby={inputTooLong ? inputErrorId : undefined}
            placeholder={
              running ? "正在等待本轮回答…"
                : modelsStatus === "loading" ? "正在加载回答模型…"
                : modelsStatus === "failed" ? "回答模型列表读取失败，请重试"
                : models.length === 0
                ? "先在“模型”里启用一个可用于回答的后端"
                : selected === null ? "请先重新选择回答模型" : "问一句，⌘↩ 发送"
            }
            // Read-only, not disabled, while an answer is made: disabled, the box lost focus to the page, and the
            // next question typed once the answer was in went nowhere. Sending waits for the turn either way.
            readOnly={running}
            disabled={exporting || modelsStatus !== "ready" || selected === null}
            onChange={(event) => {
              typing.current = true;
              setInput(event.target.value);
              setUpdatedAt(Date.now());
            }}
            onKeyDown={handleKeyDown}
          />
          <div className="assistant-compose-tools">
<select
              className="assistant-model-picker"
              value={selected?.profileId ?? ""}
              disabled={running || exporting || modelsStatus !== "ready" || models.length === 0}
              onChange={(event) => setProfileId(event.target.value)}
              aria-label="回答模型"
              aria-describedby={missingModel ? modelErrorId : undefined}
            >
              {selected === null ? (
                <option value="" disabled>{modelsStatus === "loading" ? "正在加载模型…" : modelsStatus === "failed" ? "模型列表读取失败" : models.length === 0 ? "暂无可用模型" : "请重新选择模型"}</option>
              ) : null}
              {displayedModels.map((model) => (
                <option key={model.profileId} value={model.profileId}>
                  {providerLabel(model)}
                </option>
              ))}
            </select>
            <button type="button" className="assistant-materials-trigger" aria-label="材料范围" disabled={running || exporting || feedbackPending !== null} onClick={() => setShowSources(true)}><ActionIcon name="search" /><span>{selectedSources === undefined ? `自动检索 · ${SCOPES.find(item => item.key === scope)?.label}` : `指定材料 · ${selectedSources.length}`}</span></button>
            <div className="assistant-send-actions"><IconButton hidden={!showLatest} aria-label="滚动到底部" onClick={() => { followLatest.current = true; setShowLatest(false); if (streamRef.current) streamRef.current.scrollTop = streamRef.current.scrollHeight; }}><ActionIcon name="down" /></IconButton>
            {running ? <IconButton className="assistant-send" aria-label="停止" onClick={event => { if (event.detail > 1) return; void stop(); }}><ActionIcon name="stop" /></IconButton> : <IconButton className="assistant-send" type="submit" aria-label="发送" disabled={sourcesMissing || exporting || modelsStatus !== "ready" || input.trim().length === 0 || inputTooLong || selected === null}><ActionIcon name="send" /></IconButton>}
            </div>
          </div></div>
          <p className="assistant-compose-hint"><span>{selected === null ? "请选择可用模型" : selected.leavesDevice ? "问题与检索材料会发送给远端模型" : "在本机回答"}</span><span>⌘ / Ctrl + Enter 发送</span></p>
        </form>
      </div>
      </div>
    </section>
  );
};
