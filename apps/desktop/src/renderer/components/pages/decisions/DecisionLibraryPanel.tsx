import { ActionIcon, IconButton } from "../../IconButton.js";
import type { OutcomeVerdict } from "@cognelis/decision-core";
import {
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";

import type {
  DecisionApi,
  DecisionLibraryItem,
  DecisionRationaleFilter,
  DecisionProjectCount,
  DecisionSourceFilter,
  MethodologyItem,
  ProactiveRecordResult,
} from "../../../../shared/renderer-api.js";
import { calendarDate, dateAfter, dueLabel, zonedFormatter } from "../../../calendar-date.js";
import { isClearShortcut } from "../../../keyboard.js";
import { focusFirst, navigateList } from "../../../list-navigation.js";
import { useSearchHighlight } from "../../../use-search-highlight.js";
import { useSlashToFocus } from "../../../use-slash-focus.js";
import { ModalDialog, PageHidden, usePageShownAgain } from "../../ModalDialog.js";
import { DesktopPageHeader } from "../DesktopPageHeader.js";
import { ActiveRecordDialog } from "./ActiveRecordDialog.js";
import { DecisionEvidencePanel } from "./DecisionEvidencePanel.js";
import { DecisionLifecycle } from "./DecisionLifecycle.js";
import { SameQuestionDecisions } from "./SameQuestionDecisions.js";
import { decisionMarkdown, decisionsMarkdown } from "./decision-markdown.js";
import { LocalDecisionList } from "./LocalDecisionList.js";
import { JournalEntryView } from "./JournalEntryView.js";
import { VaultNoteResults } from "./VaultNoteResults.js";

interface DecisionLibraryPanelProps {
  api: DecisionApi;
  totalDecisions: number;
  /** The index's revision as the last snapshot gave it (DashboardSnapshot.revision): moved, the page reads again. */
  decisionsRevision?: number;
  /** Preferences and ideas written since (DashboardSnapshot.journalRevision): moved, their list reads again. */
  journalRevision?: number;
  /**
   * Rationales still to write, as the home page counts them: those put off in the rationale panel wait
   * in the app's own queue and are not in this list until written.
   */
  pendingRationales?: number;
  /** Preference or idea notes that could not be read, said in the list they are missing from. */
  journalNotice?: string | null;
  onOpenHome?(): void;
  initialReviewState?: ReviewStateFilter;
  initialQuery?: string;
  initialPeriod?: PeriodFilter;
  initialRationaleStatus?: DecisionRationaleFilter | "all";
  initialProject?: string | null;
  initialVerdict?: OutcomeVerdict | null;
  initialDecisionId?: string | null;
  initialJournalEntryId?: string | null;
  onInitialNavigationConsumed?(): void;
  onInitialJournalConsumed?(): void;
  onOpenPrinciple(id: string): void;
  onDistillDecision(id: string): void;
  onRecorded(result: ProactiveRecordResult): void;
}

/** The most a list query returns (ipc.ts allows no more). */
const LIST_LIMIT = 200;

const rationaleLabels: Record<DecisionRationaleFilter, string> = {
  captured: "理由完整",
  deferred: "待补理由",
  skipped: "未补理由",
};

const sourceLabels: Record<string, string> = {
  codex: "Codex",
  "claude-code": "Claude Code",
  test: "Test",
  manual: "手动记录",
  "pr-comment": "PR 评论",
};

const dateFormatter = zonedFormatter({
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

const listDateFormatter = zonedFormatter({
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

const statusFilters: Array<{
  label: string;
  value: DecisionRationaleFilter | "all";
}> = [
  { label: "全部", value: "all" },
  { label: "理由完整", value: "captured" },
  { label: "待补理由", value: "deferred" },
  { label: "未补理由", value: "skipped" },
];

/** A principle distilled from this decision may since have been set aside. */
const principleStatusLabels: Record<MethodologyItem["status"], string> = {
  candidate: "待确认",
  accepted: "已采纳",
  retired: "已归档",
  dismissed: "已忽略",
};

const verdictLabels: Record<OutcomeVerdict, string> = {
  better: "优于预期",
  as_expected: "符合预期",
  mixed: "部分符合",
  worse: "低于预期",
  unclear: "暂无法判断",
};

const verdictOptions = Object.entries(verdictLabels) as Array<
  [OutcomeVerdict, string]
>;

/** Days, counted as today and the calendar days before it. */
type PeriodFilter = "all" | "7" | "30";

/** How another page opens this one already narrowed. */
export interface DecisionBrowseFilter {
  query?: string;
  period?: Exclude<PeriodFilter, "all">;
  rationaleStatus?: DecisionRationaleFilter;
  project?: string;
  outcomeVerdict?: OutcomeVerdict;
  reviewState?: Exclude<ReviewStateFilter, "all">;
}

/** Local midnight at the start of the window: the dashboard counts the same way. */
const periodStart = (period: Exclude<PeriodFilter, "all">): string => {
  const now = new Date();
  return new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() - (Number(period) - 1),
  ).toISOString();
};

type ReviewStateFilter =
  | "all"
  | "attention"
  | "due"
  | "scheduled"
  | "unscheduled"
  | "expectation_missing"
  | "pending_outcome"
  | "pending_review"
  | "reviewed";

interface PrincipleChoice {
  id: string;
  title: string;
  status: "accepted" | "candidate" | "dismissed" | "retired" | "missing";
  selectable: boolean;
  /** Why the local matcher thinks it fits; never a reason to check it. */
  suggestion?: { strength: "strong" | "possible"; reason: string };
}

export const DecisionLibraryPanel = ({
  api,
  totalDecisions,
  decisionsRevision = 0,
  journalRevision = 0,
  pendingRationales = 0,
  journalNotice = null,
  onOpenHome,
  initialReviewState = "all",
  initialQuery = "",
  initialPeriod = "all",
  initialRationaleStatus = "all",
  initialProject = null,
  initialVerdict = null,
  initialDecisionId = null,
  initialJournalEntryId = null,
  onInitialNavigationConsumed,
  onInitialJournalConsumed,
  onOpenPrinciple,
  onDistillDecision,
  onRecorded,
}: DecisionLibraryPanelProps) => {
  const [query, setQuery] = useState(initialQuery);
  const [libraryView, setLibraryView] = useState<"decisions" | "journal" | "local">("decisions");
  const [recording, setRecording] = useState(false);
  // With the decision it is about (a 主动记录 opened right after it is saved), or null: kept while that one is shown.
  const [recordNotice, setRecordNotice] = useState<{ text: string; forId: string | null } | null>(null);
  const [searchMode, setSearchMode] = useState<"keyword" | "semantic">(
    "keyword",
  );
  const [status, setStatus] = useState<DecisionRationaleFilter | "all">(
    initialRationaleStatus,
  );
  const [source, setSource] = useState<DecisionSourceFilter | "all">("all");
  const [reviewState, setReviewState] =
    useState<ReviewStateFilter>(initialReviewState);
  const [period, setPeriod] = useState<PeriodFilter>(initialPeriod);
  // Only set by arriving from elsewhere (the retrospective's projects), so it
  // shows as a removable condition rather than another select.
  const [project, setProject] = useState<string | null>(initialProject);
  const [projects, setProjects] = useState<DecisionProjectCount[]>([]);

  // Read again with the list: a project renamed in Obsidian (no decision added) kept its old name and count here,
  // and choosing it showed fewer than it said.
  useEffect(() => {
    let active = true;
    void (api.listDecisionProjects?.() ?? Promise.resolve([]))
      .then((loaded) => {
        if (active) setProjects(Array.isArray(loaded) ? loaded : []);
      })
      .catch(() => {
        if (active) setProjects([]);
      });
    return () => {
      active = false;
    };
  }, [api, totalDecisions, decisionsRevision]);
  // Shares the 复盘 select with the progress states: one or the other.
  const [verdict, setVerdict] = useState<OutcomeVerdict | null>(initialVerdict);
  const [decisions, setDecisions] = useState<DecisionLibraryItem[]>([]);
  const [selected, setSelected] = useState<DecisionLibraryItem | null>(null);
  // The record on screen as this render has it, for a read that lands later to tell whether the reader moved on.
  const shown = useRef(selected);
  shown.current = selected;
  // Only offered before an outcome exists: afterwards it would restate it.
  const [editingExpected, setEditingExpected] = useState(false);
  const [expectedDraft, setExpectedDraft] = useState("");
  const [expectedSavingId, setExpectedSaving] = useState<string | null>(null);
  const [expectedError, setExpectedError] = useState<string | null>(null);
  const [editingOutcome, setEditingOutcome] = useState(false);
  const [outcomeDraft, setOutcomeDraft] = useState("");
  const [outcomeSavingId, setOutcomeSaving] = useState<string | null>(null);
  const [outcomeError, setOutcomeError] = useState<string | null>(null);
  const [editingRationale, setEditingRationale] = useState(false);
  const [evidenceEditing, setEvidenceEditing] = useState(false);
  const [copyNotice, setCopyNotice] = useState<{
    id: string;
    ok: boolean;
    text: string;
  } | null>(null);
  // Speaks for the list as it was copied; once the list changes it is stale.
  const [listCopy, setListCopy] = useState<{ ok: boolean; text: string } | null>(
    null,
  );
  const listedRef = useRef(decisions);
  useEffect(() => {
    listedRef.current = decisions;
    setListCopy(null);
  }, [decisions]);
  // A copy said about one visit: reopening or stepping back must not replay it.
  useEffect(() => setCopyNotice(null), [selected?.id]);
  const [rationaleDraft, setRationaleDraft] = useState("");
  const [rationaleSavingId, setRationaleSaving] = useState<string | null>(null);
  const [rationaleError, setRationaleError] = useState<string | null>(null);
  const [editingReview, setEditingReview] = useState(false);
  const [reviewVerdict, setReviewVerdict] = useState<OutcomeVerdict>("as_expected");
  const [reviewLesson, setReviewLesson] = useState("");
  const [reviewSavingId, setReviewSaving] = useState<string | null>(null);
  const [reviewError, setReviewError] = useState<string | null>(null);
  const [editingReviewSchedule, setEditingReviewSchedule] = useState(false);
  const [reviewScheduleDraft, setReviewScheduleDraft] = useState("");
  const [reviewScheduleSavingId, setReviewScheduleSaving] = useState<string | null>(null);
  const [reviewScheduleError, setReviewScheduleError] = useState<string | null>(
    null,
  );
  const [editingPrinciples, setEditingPrinciples] = useState(false);
  const [principleChoices, setPrincipleChoices] = useState<PrincipleChoice[]>([]);
  const [selectedPrincipleIds, setSelectedPrincipleIds] = useState<string[]>([]);
  const [principleLoading, setPrincipleLoading] = useState(false);
  const [principleSavingId, setPrincipleSaving] = useState<string | null>(null);
  const [principleError, setPrincipleError] = useState<string | null>(null);
  // Each save is its record's: left to finish after its record was closed, it said 保存中 in the next record's
  // editor, held its 保存 and 取消, and let that dialog go on Escape with what was being written in it.
  const savingHere = (id: string | null): boolean => id !== null && id === selected?.id;
  const expectedSaving = savingHere(expectedSavingId);
  const outcomeSaving = savingHere(outcomeSavingId);
  const rationaleSaving = savingHere(rationaleSavingId);
  const reviewSaving = savingHere(reviewSavingId);
  const reviewScheduleSaving = savingHere(reviewScheduleSavingId);
  const principleSaving = savingHere(principleSavingId);
  /** Done saving: let go only by the save that began it, not one begun since for another record. */
  const doneSaving = (id: string) => (current: string | null): string | null => (current === id ? null : current);
  const [principles, setPrinciples] = useState<MethodologyItem[]>([]);
  const [refreshRevision, setRefreshRevision] = useState(0);
  // Preferences and ideas are not in the decisions' index: read again when the page is shown again, not at its every
  // move, which took the list away mid-read and closed the revision history open in it.
  const [shownAgain, setShownAgain] = useState(0);
  // Shown again, the open record is read again with the list (below), not only the list.
  const rereadShown = useRef(false);
  usePageShownAgain(() => {
    rereadShown.current = true;
    setRefreshRevision((value) => value + 1);
    setShownAgain((value) => value + 1);
  });
  // Changed in the index by another hand while the page is in view (an agent recording an outcome or a review, an
  // edit in Obsidian): read again as when shown again, the open record with it. The count of decisions stayed as it
  // was, and the page kept saying 尚未记录实际结果 under a result that was there.
  const seenRevision = useRef(decisionsRevision);
  useEffect(() => {
    if (seenRevision.current === decisionsRevision) return;
    seenRevision.current = decisionsRevision;
    rereadShown.current = true;
    setRefreshRevision((value) => value + 1);
  }, [decisionsRevision]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [failedSourceLink, setFailedSourceLink] = useState<string | null>(null);
  const lastSearchRequest = useRef<string | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLOListElement>(null);
  useSlashToFocus(searchInputRef);
  // The words that matched, marked in place: a result list that ranks by
  // relevance otherwise leaves the reader to find why each row is there.
  useSearchHighlight(
    listRef,
    ".decision-library-copy, .decision-library-project",
    query,
    "decision-search",
    decisions,
  );

  const focusFirstRow = (): boolean =>
    focusFirst(listRef.current, ".decision-library-row");

  // Arrow keys walk the result rows; ArrowUp from the first row returns to
  // the search box so the whole browse loop stays on the keyboard.
  const handleListKeyDown = (
    event: ReactKeyboardEvent<HTMLOListElement>,
  ): void => {
    navigateList(
      event,
      [...event.currentTarget.querySelectorAll<HTMLElement>(".decision-library-row")],
      () => searchInputRef.current?.focus(),
    );
  };

  // The page open across midnight: the snapshot published for the new day renders it again, and 近 7 天 and what is
  // due are asked for from the new day, not the one the list was read on.
  const today = calendarDate(new Date());
  useEffect(() => {
    let active = true;
    const normalizedQuery = query.trim();
    const searchRequestKey = `${searchMode}:${normalizedQuery}`;
    const isSearchRequest = lastSearchRequest.current !== searchRequestKey;
    const timer = setTimeout(() => {
      lastSearchRequest.current = searchRequestKey;
      setLoading(isSearchRequest);
      setError(null);
      void api
        .listDecisions({
          query: normalizedQuery,
          searchMode,
          ...(status === "all" ? {} : { rationaleStatus: status }),
          ...(source === "all" ? {} : { sourceClient: source }),
          ...(reviewState === "all" ? {} : { reviewState }),
          ...(period === "all" ? {} : { createdSince: periodStart(period) }),
          ...(project === null ? {} : { project }),
          ...(verdict === null ? {} : { outcomeVerdict: verdict }),
          limit: LIST_LIMIT,
        })
        .then((items) => {
          if (active) setDecisions(items);
        })
        .catch((caught: unknown) => {
          if (active) {
            setDecisions([]);
            setError(caught instanceof Error ? caught.message : String(caught));
          }
        })
        .finally(() => {
          if (active) setLoading(false);
        });
    }, isSearchRequest ? 160 : 0);
    return () => {
      active = false;
      clearTimeout(timer);
    };
    // totalDecisions: a decision saved from elsewhere (⌘N, a capture) joins the list as it joins the count.
  }, [api, period, project, query, refreshRevision, reviewState, searchMode, source, status, today, totalDecisions, verdict]);

  useEffect(() => {
    if (initialDecisionId === null) {
      onInitialNavigationConsumed?.();
      return;
    }
    let active = true;
    setLibraryView("decisions");
    // What an earlier arrival said (its decision gone) is not this one's; 记录已保存, said of the decision this very
    // arrival opens, is: cleared with the rest, it never showed.
    setRecordNotice((current) => (current?.forId === initialDecisionId ? current : null));
    const openAtStart = shown.current?.id ?? null;
    void api
      .listDecisions({ query: "", decisionId: initialDecisionId, limit: 1 })
      .then((items) => {
        if (!active) return;
        // Opened (or closed) by the reader while it was read, what is on screen is theirs: landing late, the
        // arrival put its own record over the one they had just opened.
        if ((shown.current?.id ?? null) !== openAtStart) return;
        if (items[0] !== undefined) setSelected(items[0]);
        // Its note gone since it was cited, say: the click that brought the reader here did nothing at all.
        else setRecordNotice({ text: "要打开的决策已不在知识库里，笔记可能已被删除或移动", forId: null });
      })
      .catch((caught: unknown) => {
        if (active) {
          setError(caught instanceof Error ? caught.message : String(caught));
        }
      })
      .finally(() => {
        if (active) onInitialNavigationConsumed?.();
      });
    return () => {
      active = false;
    };
  }, [api, initialDecisionId, onInitialNavigationConsumed]);

  // Read once per panel, not per decision: listing principles reads every
  // methodology note, and selecting a record must not pay for that each time.
  useEffect(() => {
    let active = true;
    void api
      .listMethodologies()
      .then((records) => {
        if (active) setPrinciples(records);
      })
      .catch(() => {
        // A missing back-reference is a quieter failure than a broken detail
        // page; the section simply does not appear.
        if (active) setPrinciples([]);
      });
    return () => {
      active = false;
    };
  }, [api, refreshRevision]);

  // The other direction of the same relation: 采用的方法论 is what this
  // decision applied, this is what the decision became evidence for.
  const distilled = useMemo(
    () =>
      selected === null
        ? []
        : principles.filter((record) =>
            record.sourceDecisionIds.includes(selected.id),
          ),
    [principles, selected],
  );

  // Preferences and ideas live behind their own tab, so arriving at one means
  // switching the view first. The arrival is taken, as a decision's is: the page
  // opened later, from anywhere, starts on the decisions again.
  const [journalHighlight, setJournalHighlight] = useState<string | null>(null);
  const [journalJumps, setJournalJumps] = useState(0);
  useEffect(() => {
    if (initialJournalEntryId === null) return;
    setSelected(null);
    setLibraryView("journal");
    setJournalHighlight(initialJournalEntryId);
    setJournalJumps((count) => count + 1);
    onInitialJournalConsumed?.();
  }, [initialJournalEntryId, onInitialJournalConsumed]);

  const filtersActive =
    query.trim().length > 0 ||
    status !== "all" ||
    source !== "all" ||
    reviewState !== "all" ||
    period !== "all" ||
    project !== null ||
    verdict !== null;

  // A to-do list emptied by finishing its last item is good news, not a miss.
  // Other narrowing still in force means only that slice is done, so say so.
  // Put off in the rationale panel, a rationale waits on the home page, not here: none listed here
  // is not all written.
  const deferredElsewhere = status === "deferred" && pendingRationales > 0;
  const todoDone =
    totalDecisions > 0 && query.trim().length === 0 && !deferredElsewhere
      ? status === "deferred"
        ? "待补的理由都补完了"
        : reviewState === "expectation_missing"
          ? "该写的预期都写好了"
          : reviewState === "attention"
            ? "需要处理的复盘都处理完了"
            : null
      : null;
  const narrowedFurther =
    source !== "all" || period !== "all" || project !== null || verdict !== null;
  const todoCleared =
    todoDone === null ? null : narrowedFurther ? `当前筛选下，${todoDone}` : todoDone;

  const resetFilters = (): void => {
    setQuery("");
    setStatus("all");
    setSource("all");
    setReviewState("all");
    setPeriod("all");
    setProject(null);
    setVerdict(null);
  };

  const closeDetails = (): void => {
    setSelected(null);
    setEditingRationale(false);
    setRationaleDraft("");
    setRationaleError(null);
    setEditingExpected(false);
    setExpectedDraft("");
    setExpectedError(null);
    setEditingOutcome(false);
    setOutcomeDraft("");
    setOutcomeError(null);
    setEditingReview(false);
    setReviewLesson("");
    setReviewError(null);
    setEditingReviewSchedule(false);
    setReviewScheduleDraft("");
    setReviewScheduleError(null);
    setEditingPrinciples(false);
    setPrincipleChoices([]);
    setSelectedPrincipleIds([]);
    setPrincipleError(null);
  };

  const principleLoad = useRef(0);
  const beginPrincipleEdit = async (): Promise<void> => {
    if (selected === null) return;
    // Only the latest opening's choices are shown: a slow reply for the record left behind put its
    // ranking and reasons into the editor opened since on the next one.
    const load = ++principleLoad.current;
    setEditingOutcome(false);
    setEditingReview(false);
    setEditingReviewSchedule(false);
    setEditingPrinciples(true);
    setSelectedPrincipleIds([...selected.appliedPrincipleIds]);
    setPrincipleLoading(true);
    setPrincipleError(null);
    try {
      // The same local matching the rationale step offers, so the likely ones
      // come first with their reason; the list still waits for a hand to pick.
      const [accepted, suggestions] = await Promise.all([
        api.listMethodologies("accepted"),
        api
          .getDecisionPrincipleSuggestions({
            question: selected.question,
            selectedAnswer: selected.selectedAnswer,
            optionLabels: [],
            context: selected.context,
          })
          .catch(() => []),
      ]);
      if (principleLoad.current !== load) return;
      const suggested = new Map(suggestions.map((item, rank) => [item.id, { item, rank }]));
      const choices = new Map<string, PrincipleChoice>();
      [...accepted]
        .sort(
          (left, right) =>
            (suggested.get(left.id)?.rank ?? Number.MAX_SAFE_INTEGER) -
            (suggested.get(right.id)?.rank ?? Number.MAX_SAFE_INTEGER),
        )
        .forEach((item) => {
          const match = suggested.get(item.id)?.item;
          choices.set(item.id, {
            id: item.id,
            title: item.title,
            status: item.status,
            selectable: true,
            ...(match === undefined
              ? {}
              : { suggestion: { strength: match.strength, reason: match.reason } }),
          });
        });
      selected.appliedPrinciples.forEach((item) => {
        if (!choices.has(item.id)) {
          choices.set(item.id, {
            id: item.id,
            title: item.title,
            status: item.status,
            selectable: false,
          });
        }
      });
      selected.appliedPrincipleIds.forEach((id) => {
        if (!choices.has(id)) {
          choices.set(id, {
            id,
            title: "已归档或缺失的原则",
            status: "missing",
            selectable: false,
          });
        }
      });
      setPrincipleChoices([...choices.values()]);
    } catch (caught) {
      if (principleLoad.current !== load) return;
      setPrincipleChoices(
        selected.appliedPrinciples.map((item) => ({
          ...item,
          selectable: false,
        })),
      );
      setPrincipleError(
        caught instanceof Error ? caught.message : String(caught),
      );
    } finally {
      if (principleLoad.current === load) setPrincipleLoading(false);
    }
  };

  const togglePrinciple = (choice: PrincipleChoice): void => {
    setSelectedPrincipleIds((current) => {
      if (current.includes(choice.id)) {
        return current.filter((id) => id !== choice.id);
      }
      if (!choice.selectable || current.length >= 5) return current;
      return [...current, choice.id];
    });
  };

  // Each time a record is put on screen, counted, the same one again too. A save that finishes after
  // the look it began in (its record closed, a save may be left to finish, or another opened) changes
  // that screen not at all: no record reopened, no editor closed. By id alone, a record closed and
  // opened again looked never left: an editor begun again there was closed, a failure went unsaid.
  const looks = useRef(0);
  // What an editor of the open record saved, said where a screen reader hears it: closing on 保存, the editor said
  // nothing, and focus went to the dialog itself.
  const [savedNotice, setSavedNotice] = useState("");
  useEffect(() => {
    looks.current += 1;
    setSavedNotice("");
    // Said of an arrival or a 主动记录 before: kept, "要打开的决策已不在知识库里" stood beside the one opened since. One
    // said of the decision now shown stays.
    setRecordNotice((current) => (current !== null && current.forId !== null && current.forId === selected?.id ? current : null));
  }, [selected?.id]);
  const patchShown = (id: string, patch: Partial<DecisionLibraryItem>): void =>
    setSelected((current) => (current?.id === id ? { ...current, ...patch } : current));
  // Such a save that fails went unsaid, and what was written with it was gone. It is said on the page,
  // and what was written comes back in its editor when that record is opened again (below).
  const [unsaved, setUnsaved] = useState<{ id: string; notice: string; restore(): void } | null>(null);
  const saveFailed = (
    record: DecisionLibraryItem,
    look: number,
    what: string,
    caught: unknown,
    showHere: (message: string) => void,
    reopen?: () => void,
  ): void => {
    const message = caught instanceof Error ? caught.message : String(caught);
    if (looks.current === look) {
      showHere(message);
      return;
    }
    setUnsaved({
      id: record.id,
      notice: `「${record.question}」的${what}没能保存：${message.replace(/[。.]$/u, "")}${
        reopen === undefined ? "。" : "。重新打开这条决策，写下的内容还在。"
      }`,
      restore: () => {
        reopen?.();
        showHere(message);
      },
    });
  };

  const savePrinciples = async (): Promise<void> => {
    if (selected === null) return;
    const record = selected;
    const id = record.id;
    const look = looks.current;
    setPrincipleSaving(id);
    setPrincipleError(null);
    try {
      const appliedPrinciples = await api.updateDecisionAppliedPrinciples(
        id,
        selectedPrincipleIds,
      );
      patchShown(id, {
        appliedPrincipleIds: [...selectedPrincipleIds],
        appliedPrinciples,
      });
      if (looks.current === look) {
        setEditingPrinciples(false);
        setSavedNotice("采用的方法论已保存");
      }
      setRefreshRevision((value) => value + 1);
    } catch (caught) {
      saveFailed(record, look, "采用的方法论", caught, setPrincipleError);
    } finally {
      setPrincipleSaving(doneSaving(id));
    }
  };

  const beginReviewScheduleEdit = (): void => {
    setReviewScheduleDraft(selected?.reviewDueDate ?? dateAfter(7));
    setReviewScheduleError(null);
    setEditingOutcome(false);
    setEditingReview(false);
    setEditingPrinciples(false);
    setEditingReviewSchedule(true);
  };

  const saveReviewSchedule = async (
    reviewDueDate: string | null = reviewScheduleDraft,
  ): Promise<void> => {
    if (selected === null || (reviewDueDate !== null && reviewDueDate === "")) {
      return;
    }
    const record = selected;
    const id = record.id;
    const look = looks.current;
    setReviewScheduleSaving(id);
    setReviewScheduleError(null);
    try {
      await api.updateDecisionReviewDueDate(id, reviewDueDate);
      patchShown(id, { reviewDueDate });
      if (looks.current === look) {
        setEditingReviewSchedule(false);
        setSavedNotice(reviewDueDate === null ? "复盘日期已取消" : "复盘日期已保存");
      }
      setRefreshRevision((value) => value + 1);
    } catch (caught) {
      saveFailed(record, look, "复盘日期", caught, setReviewScheduleError);
    } finally {
      setReviewScheduleSaving(doneSaving(id));
    }
  };

  // The note's version each editor opened at: saved with it, what was written in Obsidian meanwhile is not
  // written over without a word. Not known (read before it was kept), the save goes as it did.
  const basisArgument = (basis: string | null | undefined) => (basis ? [basis] as const : [] as const);
  const editBasis = useRef<{ outcome?: string | null; expected?: string | null; review?: string | null }>({});

  const beginReviewEdit = (): void => {
    editBasis.current.review = selected?.contentHash ?? null;
    setReviewVerdict(selected?.outcomeReview?.verdict ?? "as_expected");
    setReviewLesson(selected?.outcomeReview?.lesson ?? "");
    setReviewError(null);
    setEditingOutcome(false);
    setEditingReviewSchedule(false);
    setEditingPrinciples(false);
    setEditingReview(true);
  };

  const saveReview = async (): Promise<void> => {
    if (selected === null || selected.outcome === null) return;
    const record = selected;
    const id = record.id;
    const [verdict, lesson] = [reviewVerdict, reviewLesson];
    const look = looks.current;
    setReviewSaving(id);
    setReviewError(null);
    try {
      const outcomeReview = await api.updateDecisionReview(id, {
        verdict: reviewVerdict,
        lesson: reviewLesson.trim().length === 0 ? null : reviewLesson.trim(),
      }, ...basisArgument(editBasis.current.review));
      // Written, the note is a version this page has not read: the next edit is not checked against the old one.
      patchShown(id, { outcomeReview, contentHash: null });
      if (looks.current === look) {
        setEditingReview(false);
        setSavedNotice("复盘已保存");
      }
      setRefreshRevision((value) => value + 1);
    } catch (caught) {
      saveFailed(record, look, "复盘", caught, setReviewError, () => {
        setReviewVerdict(verdict);
        setReviewLesson(lesson);
        setEditingReview(true);
      });
    } finally {
      setReviewSaving(doneSaving(id));
    }
  };

  // A deferred rationale is completed where the decision is read, not only
  // from the dashboard card; the note keeps it as the user's own words.
  const beginRationaleEdit = (): void => {
    setRationaleDraft("");
    setRationaleError(null);
    setEditingRationale(true);
  };

  const saveRationale = async (): Promise<void> => {
    if (selected === null || rationaleDraft.trim().length === 0) return;
    const rationale = rationaleDraft.trim();
    const record = selected;
    const id = record.id;
    const look = looks.current;
    setRationaleSaving(id);
    setRationaleError(null);
    try {
      await api.submitRationale({
        candidateId: id,
        status: "captured",
        rationale,
      });
      patchShown(id, { rationale, rationaleStatus: "captured" });
      if (looks.current === look) {
        setEditingRationale(false);
        setSavedNotice("理由已保存");
      }
      setRefreshRevision((value) => value + 1);
    } catch (caught) {
      saveFailed(record, look, "理由", caught, setRationaleError, () => {
        setRationaleDraft(rationale);
        setEditingRationale(true);
      });
    } finally {
      setRationaleSaving(doneSaving(id));
    }
  };

  const beginOutcomeEdit = (): void => {
    editBasis.current.outcome = selected?.contentHash ?? null;
    setOutcomeDraft(selected?.outcome ?? "");
    setOutcomeError(null);
    setEditingReview(false);
    setEditingReviewSchedule(false);
    setEditingPrinciples(false);
    setEditingOutcome(true);
  };

  const beginExpectedEdit = (): void => {
    editBasis.current.expected = selected?.contentHash ?? null;
    setExpectedDraft(selected?.expectedOutcome ?? "");
    setExpectedError(null);
    setEditingExpected(true);
  };

  const saveExpected = async (): Promise<void> => {
    if (selected === null || expectedDraft.trim().length === 0) return;
    const expectedOutcome = expectedDraft.trim();
    const record = selected;
    const id = record.id;
    const look = looks.current;
    setExpectedSaving(id);
    setExpectedError(null);
    try {
      await api.updateDecisionExpectedOutcome(id, expectedOutcome, ...basisArgument(editBasis.current.expected));
      patchShown(id, { expectedOutcome, contentHash: null });
      if (looks.current === look) {
        setEditingExpected(false);
        setSavedNotice("预期结果已保存");
      }
      setRefreshRevision((value) => value + 1);
    } catch (caught) {
      saveFailed(record, look, "预期结果", caught, setExpectedError, () => {
        setExpectedDraft(expectedOutcome);
        setEditingExpected(true);
      });
    } finally {
      setExpectedSaving(doneSaving(id));
    }
  };

  const saveOutcome = async (): Promise<void> => {
    if (selected === null || outcomeDraft.trim().length === 0) return;
    const outcome = outcomeDraft.trim();
    const record = selected;
    const id = record.id;
    const look = looks.current;
    setOutcomeSaving(id);
    setOutcomeError(null);
    try {
      await api.updateDecisionOutcome(id, outcome, ...basisArgument(editBasis.current.outcome));
      patchShown(id, { outcome, contentHash: null });
      if (looks.current === look) {
        setEditingOutcome(false);
        setSavedNotice("实际结果已保存");
      }
      setRefreshRevision((value) => value + 1);
    } catch (caught) {
      saveFailed(record, look, "实际结果", caught, setOutcomeError, () => {
        setOutcomeDraft(outcome);
        setEditingOutcome(true);
      });
    } finally {
      setOutcomeSaving(doneSaving(id));
    }
  };

  const resultCopy = useMemo(() => {
    if (loading) {
      return query.trim().length > 0 && searchMode === "semantic"
        ? "正在理解并查找…"
        : "正在查找…";
    }
    if (error !== null) return "查询失败";
    const semanticParticipated = decisions.some(
      (decision) =>
        decision.searchMatch === "semantic" || decision.searchMatch === "hybrid",
    );
    // At the limit there may be more than are shown: said as the newest, or the best matching, so many.
    // "200 条结果" read as all of them, under a header counting 350.
    const count =
      decisions.length < LIST_LIMIT
        ? `${decisions.length} 条结果`
        : query.trim().length === 0
          ? `最近 ${LIST_LIMIT} 条`
          // The best matching only where ranked so: keywords alone may be listed newest first (a two-character word).
          : semanticParticipated
            ? `最相关的 ${LIST_LIMIT} 条`
            : `前 ${LIST_LIMIT} 条`;
    if (query.trim().length === 0) return count;
    return `${count} · ${semanticParticipated ? "语义参与排序" : "关键词匹配"}`;
  }, [decisions, error, loading, query, searchMode]);

  // Reviewing a batch should not mean closing and reopening each record: the
  // detail steps through the list as it is currently filtered. Stepping is off
  // while an editor is open so a half-written draft is never dropped.
  const selectedIndex =
    selected === null
      ? -1
      : decisions.findIndex((decision) => decision.id === selected.id);
  const detailEditing =
    editingRationale ||
    editingExpected || editingOutcome ||
    editingReview ||
    editingReviewSchedule ||
    editingPrinciples ||
    evidenceEditing;
  // An editor closed (saved or let go) takes the focused field and its own buttons with it: focus goes back to the
  // button that opened it, where the dialog took it to its top and Tab started over there. Where that button is
  // gone with what was saved (补充理由 once there is a rationale), the dialog keeps it, and the save is said.
  const openEditors = {
    rationale: editingRationale,
    expected: editingExpected,
    outcome: editingOutcome,
    review: editingReview,
    schedule: editingReviewSchedule,
    principles: editingPrinciples,
  };
  const editorsBefore = useRef(openEditors);
  useEffect(() => {
    const editors = Object.keys(openEditors) as Array<keyof typeof openEditors>;
    const closed = editors.find((editor) => editorsBefore.current[editor] && !openEditors[editor]);
    // One opened again: the last "…已保存" goes, or the same words set by the next save changed nothing to be said.
    if (editors.some((editor) => !editorsBefore.current[editor] && openEditors[editor])) setSavedNotice("");
    editorsBefore.current = openEditors;
    if (closed === undefined) return;
    const focused = document.activeElement;
    if (focused !== null && focused !== document.body && focused.getAttribute("role") !== "dialog") return;
    document.querySelector<HTMLElement>(`[data-opens-editor="${closed}"]`)?.focus();
  });
  // The open record as the list now has it, once the page is shown again: changed elsewhere meanwhile (a
  // review, an outcome), it said what it said before, and an edit made from it was refused as out of date.
  // Only then: after a save here, the record shown is the one just written, ahead of a list read from the index.
  // Left as it is while an editor is open, as what that editor saves is checked against what it was opened on.
  const editingNow = useRef(false);
  editingNow.current = detailEditing;
  useEffect(() => {
    if (!rereadShown.current) return;
    rereadShown.current = false;
    if (editingNow.current || selected === null) return;
    const listed = decisions.find((decision) => decision.id === selected.id);
    if (listed !== undefined) {
      setSelected(listed);
      return;
    }
    // Opened from elsewhere (the home page, a citation), out of the list as filtered or past what it shows: read
    // again on its own, as the list did not hold it, or it said what it said before and an edit from it was refused.
    const { id } = selected;
    void api
      .listDecisions({ query: "", decisionId: id, limit: 1 })
      .then((items) => {
        const reread = items[0];
        if (reread !== undefined && !editingNow.current) {
          setSelected((current) => (current?.id === id ? reread : current));
        }
      })
      .catch(() => undefined);
  }, [decisions]);
  // Given back once that record is on screen with no editor open: one begun again since would have what
  // is typed in it written over, so it waits until that one is done.
  useEffect(() => {
    if (unsaved === null || selected?.id !== unsaved.id || detailEditing) return;
    unsaved.restore();
    setUnsaved(null);
  }, [selected?.id, unsaved, detailEditing]);
  // A save under way may be left to finish on its own: closing then loses no words.
  const detailSaving =
    rationaleSaving || expectedSaving || outcomeSaving || reviewSaving || reviewScheduleSaving || principleSaving;
  // Completing a record can drop it out of the filtered list (a rationale
  // written under 待补理由). The detail keeps its place: the record that moved
  // up into that position is the next one, the one above it the previous.
  const listedPlace = useRef<{ id: string; index: number } | null>(null);
  if (selected !== null && selectedIndex >= 0) {
    listedPlace.current = { id: selected.id, index: selectedIndex };
  }
  const droppedOut =
    selected !== null &&
    selectedIndex < 0 &&
    listedPlace.current?.id === selected.id;
  const neighbor = (step: -1 | 1): DecisionLibraryItem | undefined =>
    selectedIndex >= 0
      ? decisions[selectedIndex + step]
      : droppedOut && listedPlace.current !== null
        ? decisions[listedPlace.current.index + (step > 0 ? 0 : -1)]
        : undefined;
  const copyList = async (): Promise<void> => {
    const listed = decisions;
    let ok = true;
    try {
      await navigator.clipboard.writeText(decisionsMarkdown(listed));
    } catch {
      ok = false;
    }
    // The list may have been refreshed while the clipboard was written.
    if (listedRef.current !== listed) return;
    setListCopy(
      ok
        ? { ok, text: `已复制 ${listed.length} 条为 Markdown` }
        : { ok, text: "复制失败" },
    );
  };
  const copyDecision = async (): Promise<void> => {
    if (selected === null) return;
    const { id } = selected;
    try {
      await navigator.clipboard.writeText(decisionMarkdown(selected));
      setCopyNotice({ id, ok: true, text: "已复制为 Markdown" });
    } catch {
      setCopyNotice({ id, ok: false, text: "复制失败" });
    }
  };
  // Said when stepping, and only then: stepping swapped the whole record while focus stayed on the button, and a
  // screen reader heard nothing of which one was shown now. As a live counter, every re-read that moved the record
  // (an agent's capture, a save that took it out of the filter) spoke over a reader who had pressed nothing.
  const [stepNotice, setStepNotice] = useState<{ id: string; text: string } | null>(null);
  // Gone with the detail: kept, the same decision opened again (no step at all) came up saying where it stood once.
  useEffect(() => {
    if (selected === null) setStepNotice(null);
  }, [selected]);
  const stepDetail = (step: -1 | 1): void => {
    const next = neighbor(step);
    if (next === undefined || detailEditing) return;
    setSelected(next);
    setStepNotice({
      id: next.id,
      text: `第 ${decisions.findIndex((item) => item.id === next.id) + 1} / ${decisions.length} 条：${next.question}`,
    });
  };

  // Out of sight while a captured decision has the window, its arrow keys are not this page's to take.
  const pageHidden = useContext(PageHidden);
  useEffect(() => {
    if (selected === null || pageHidden) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      if (event.defaultPrevented || event.altKey || event.metaKey || event.ctrlKey) {
        return;
      }
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest("input, textarea, select, [contenteditable='true']")) return;
      event.preventDefault();
      stepDetail(event.key === "ArrowLeft" ? -1 : 1);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [decisions, detailEditing, selected, pageHidden]);

  const detailEditingClass = editingRationale
    ? " rationale-editing"
    : editingReview
    ? " review-editing"
    : editingOutcome
      ? " outcome-editing"
      : editingReviewSchedule
        ? " schedule-editing"
        : editingPrinciples
          ? " principles-editing"
        : "";

  return (
    <section
      className="desktop-view decisions-panel decision-library-panel"
      role="region"
      aria-label="知识"
    >
      <DesktopPageHeader
        eyebrow="沉淀"
        title="知识"
        description="一次搜索同时查决策、个人偏好想法和 Vault 里的全部笔记。"
        meta={totalDecisions}
        metaLabel="全部决策"
      />

      <div className="decision-directory-actions">
        <div className="decision-directory-tabs" role="tablist" aria-label="决策目录视图" onKeyDown={(event) => {
          // Tabs as they are read: an arrow moves to the other one and shows it, Home and End go to the first and last.
          if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
          event.preventDefault();
          const tabs = ["decisions", "journal", "local"] as const;
          const next = event.key === "Home" ? tabs[0] : event.key === "End" ? tabs[2] : tabs[(tabs.indexOf(libraryView) + (event.key === "ArrowRight" ? 1 : 2)) % 3]!;
          if (next !== "decisions") setSelected(null);
          setLibraryView(next);
          document.getElementById(`knowledge-tab-${next}`)?.focus();
        }}>
          <button type="button" role="tab" id="knowledge-tab-decisions" aria-controls="knowledge-panel-decisions" aria-selected={libraryView === "decisions"} tabIndex={libraryView === "decisions" ? 0 : -1} onClick={() => setLibraryView("decisions")}><ActionIcon name="record" /><span>决策</span></button>
          <button type="button" role="tab" id="knowledge-tab-journal" aria-controls="knowledge-panel-journal" aria-selected={libraryView === "journal"} tabIndex={libraryView === "journal" ? 0 : -1} onClick={() => { setSelected(null); setLibraryView("journal"); }}><ActionIcon name="idea" /><span>偏好与想法</span></button>
          <button type="button" role="tab" id="knowledge-tab-local" aria-controls="knowledge-panel-local" aria-selected={libraryView === "local"} tabIndex={libraryView === "local" ? 0 : -1} onClick={() => { setSelected(null); setLibraryView("local"); }}><ActionIcon name="record" /><span>仅本机保留</span></button>
        </div>
        {recordNotice === null ? null : <span role="status">{recordNotice.text}</span>}
        <button type="button" className="primary-button" onClick={() => setRecording(true)}>主动记录</button>
      </div>

      <div className="desktop-page-scroll decision-library-content">
        <div className="knowledge-results" id="knowledge-panel-decisions" role="tabpanel" aria-labelledby="knowledge-tab-decisions" hidden={libraryView !== "decisions"}>
        <section className="decision-library-card" aria-label="决策历史">
          {unsaved === null ? null : (
            <p className="error-message" role="alert">
              {unsaved.notice}
            </p>
          )}
          <div className="decision-library-toolbar">
            <div className="decision-search-control">
              <div className="decision-search-field">
                <svg viewBox="0 0 20 20" aria-hidden="true">
                  <circle cx="8.5" cy="8.5" r="5" />
                  <path d="m12.2 12.2 4 4" />
                </svg>
                <input
                  ref={searchInputRef}
                  type="text"
                  role="searchbox"
                  aria-label="搜索决策与笔记"
                  // What a decision search takes: a longer paste was refused, and shown as a failure.
                  maxLength={200}
                  placeholder={
                    searchMode === "semantic"
                      ? "按关键词或含义搜索决策与笔记"
                      : "按关键词搜索决策与笔记"
                  }
                  value={query}
                  onChange={(event) => setQuery(event.currentTarget.value)}
                  onKeyDown={(event) => {
                    if (event.nativeEvent.isComposing) return;
                    if (event.key === "Enter" || event.key === "ArrowDown") {
                      if (focusFirstRow()) event.preventDefault();
                      return;
                    }
                    if (query.length === 0 || !isClearShortcut(event)) return;
                    event.preventDefault();
                    setQuery("");
                  }}
                />
                {query.length > 0 ? (
                  <IconButton
                    type="button"
                    className="decision-search-clear"
                    aria-label="清空搜索"
                    onClick={() => setQuery("")}
                  >
                    <svg viewBox="0 0 16 16" aria-hidden="true">
                      <path d="m4 4 8 8m0-8-8 8" />
                    </svg>
                  </IconButton>
                ) : (
                  <kbd
                    className="decision-search-shortcut"
                    aria-hidden="true"
                    title="按 / 聚焦搜索"
                  >
                    /
                  </kbd>
                )}
              </div>
              <label
                className="decision-search-mode"
                // Notes are searched by meaning whenever the local model is
                // available, so saying "semantic" without naming the half this
                // switch governs promises more than it does.
                title={
                  searchMode === "semantic"
                    ? "关闭后决策仅按关键词查找；笔记检索不受此开关影响"
                    : "开启后决策也可按含义查找；笔记检索不受此开关影响"
                }
              >
                <span className="decision-search-mode-label">决策语义</span>
                <input
                  type="checkbox"
                  role="switch"
                  aria-label="决策使用语义检索"
                  aria-checked={searchMode === "semantic"}
                  checked={searchMode === "semantic"}
                  onChange={(event) =>
                    setSearchMode(
                      event.currentTarget.checked ? "semantic" : "keyword",
                    )
                  }
                />
              </label>
            </div>

            <div className="decision-filter-segment" aria-label="理由状态">
              {statusFilters.map((filter) => (
                <button
                  key={filter.value}
                  type="button"
                  aria-pressed={status === filter.value}
                  onClick={() => setStatus(filter.value)}
                >
                  {filter.label}
                </button>
              ))}
            </div>

            <label className="decision-source-filter">
              <span>来源</span>
              <select
                aria-label="按来源筛选"
                value={source}
                onChange={(event) =>
                  setSource(
                    event.currentTarget.value as DecisionSourceFilter | "all",
                  )
                }
              >
                <option value="all">全部</option>
                <option value="codex">Codex</option>
                <option value="claude-code">Claude Code</option>
                <option value="manual">手动记录</option>
                <option value="pr-comment">PR 评论</option>
              </select>
            </label>

            <label className="decision-source-filter decision-review-filter">
              <span>复盘</span>
              <select
                aria-label="按复盘进度或结论筛选"
                value={verdict === null ? reviewState : `verdict:${verdict}`}
                onChange={(event) => {
                  const { value } = event.currentTarget;
                  if (value.startsWith("verdict:")) {
                    setReviewState("all");
                    setVerdict(value.slice("verdict:".length) as OutcomeVerdict);
                  } else {
                    setVerdict(null);
                    setReviewState(value as ReviewStateFilter);
                  }
                }}
              >
                <option value="all">全部</option>
                <optgroup label="进度">
                  <option value="attention">需处理</option>
                  <option value="due">已到期</option>
                  <option value="scheduled">已安排</option>
                  <option value="unscheduled">未安排</option>
                  <option value="expectation_missing">待写预期</option>
                  <option value="pending_outcome">待回填</option>
                  <option value="pending_review">待复盘</option>
                  <option value="reviewed">已复盘</option>
                </optgroup>
                <optgroup label="结论">
                  {verdictOptions.map(([value, label]) => (
                    <option key={value} value={`verdict:${value}`}>
                      {label}
                    </option>
                  ))}
                </optgroup>
              </select>
            </label>

            <label className="decision-source-filter decision-period-filter">
              <span>时间</span>
              <select
                aria-label="按记录时间筛选"
                value={period}
                onChange={(event) =>
                  setPeriod(event.currentTarget.value as PeriodFilter)
                }
              >
                <option value="all">全部</option>
                <option value="7">近 7 天</option>
                <option value="30">近 30 天</option>
              </select>
            </label>

            {/* One project leaves nothing to choose between, unless one arrived from the retrospective. */}
            {project === null && projects.length < 2 ? null : (
              <label className="decision-source-filter decision-project-filter">
                <span>项目</span>
                <select
                  aria-label="按项目筛选"
                  value={project ?? ""}
                  title={project ?? undefined}
                  onChange={(event) => setProject(event.currentTarget.value || null)}
                >
                  <option value="">全部</option>
                  {project !== null && !projects.some((item) => item.project === project) ? (
                    <option value={project}>{project}</option>
                  ) : null}
                  {projects.map((item) => (
                    <option key={item.project} value={item.project}>
                      {item.project}（{item.count}）
                    </option>
                  ))}
                </select>
              </label>
            )}

            <span
              className={`decision-result-count${listCopy?.ok === false ? " error" : ""}`}
              role="status"
            >
              {listCopy?.text ?? resultCopy}
            </span>
            {decisions.length === 0 ? null : (
              <IconButton
                aria-label={`把这 ${decisions.length} 条决策复制为 Markdown`}
                disabled={loading}
                onClick={() => void copyList()}
              >
                <ActionIcon name="copy" />
              </IconButton>
            )}
          </div>

          {error !== null ? (
            <p className="decision-library-message error-message">
              无法读取决策库，请在设置中重建决策索引后重试。
            </p>
          ) : !loading && decisions.length === 0 ? (
            <div className="decision-library-empty">
              <strong>
                {deferredElsewhere && query.trim().length === 0
                  ? `还有 ${pendingRationales} 条理由待补，在首页`
                  : todoCleared ?? (filtersActive ? "没有匹配结果" : "还没有决策")}
              </strong>
              <span>
                {deferredElsewhere && query.trim().length === 0
                  ? "选了“稍后处理”的决策补完理由后才写进决策库，先在首页的“待补理由”里补充。"
                  : todoCleared !== null
                    ? "这张列表里已经没有要处理的了。"
                    : filtersActive
                      ? "调整关键词或筛选条件后再试。"
                      : "在 Claude Code / Codex 中完成一次选择，或使用上方“主动记录”手动添加。"}
              </span>
              {deferredElsewhere && query.trim().length === 0 && onOpenHome !== undefined ? (
                <button type="button" className="primary-button" onClick={onOpenHome}>
                  去首页补充
                </button>
              ) : null}
              {filtersActive ? (
                <button
                  type="button"
                  className="secondary-button decision-library-reset"
                  onClick={resetFilters}
                >
                  清除关键词与筛选
                </button>
              ) : null}
            </div>
          ) : (
            <ol
              ref={listRef}
              className="decision-library-list"
              aria-label="决策列表"
              onKeyDown={handleListKeyDown}
            >
              {decisions.map((decision) => (
                <li key={decision.id}>
                  <button
                    type="button"
                    className="decision-library-row"
                    onClick={() => setSelected(decision)}
                  >
                    <span className="decision-library-copy">
                      <strong>{decision.question}</strong>
                      <span>
                        {decision.selectedAnswer}
                        {decision.searchMatch === "semantic" ||
                        decision.searchMatch === "hybrid" ? (
                          <small
                            className={`decision-semantic-badge ${decision.searchMatch}`}
                          >
                            {decision.searchMatch === "hybrid"
                              ? "综合命中"
                              : "语义命中"}
                          </small>
                        ) : null}
                        {decision.outcomeReview !== null ? (
                          <small
                            className={`decision-review-badge ${decision.outcomeReview.verdict}`}
                          >
                            {verdictLabels[decision.outcomeReview.verdict]}
                          </small>
                        ) : decision.outcome !== null ? (
                          <small className="decision-outcome-badge">待复盘</small>
                        ) : decision.reviewDueDate !== null ? (
                          <small
                            className={`decision-schedule-badge${
                              decision.reviewDueDate <= calendarDate(new Date())
                                ? " due"
                                : ""
                            }`}
                          >
                            {decision.reviewDueDate <= calendarDate(new Date())
                              ? "到期回填"
                              : `${dueLabel(decision.reviewDueDate)}复盘`}
                          </small>
                        ) : null}
                      </span>
                    </span>
                    <span className="decision-library-project">
                      {decision.project}
                    </span>
                    <span className="decision-library-source">
                      {sourceLabels[decision.sourceClient] ?? decision.sourceClient}
                    </span>
                    <time dateTime={decision.created}>
                      {listDateFormatter.format(new Date(decision.created))}
                    </time>
                    <span className={`rationale-state ${decision.rationaleStatus}`}>
                      {rationaleLabels[decision.rationaleStatus]}
                    </span>
                    <span className="decision-library-disclosure" aria-hidden="true">
                      ›
                    </span>
                  </button>
                </li>
              ))}
            </ol>
          )}
        </section>
          <VaultNoteResults api={api} query={query} />
        </div>
        <div id="knowledge-panel-journal" role="tabpanel" aria-labelledby="knowledge-tab-journal" hidden={libraryView !== "journal"}>
          <JournalEntryView
            // Each arrival is fresh, the same entry again included: its search and filters start clear.
            key={journalJumps}
            api={api}
            // Shown again, or a preference or idea written (an agent's, while the list stays in view): both only
            // grow, so either moves the sum.
            refreshRevision={shownAgain + journalRevision}
            highlightId={journalHighlight}
            unreadableNotice={journalNotice}
          />
        </div>
        <div id="knowledge-panel-local" role="tabpanel" aria-labelledby="knowledge-tab-local" hidden={libraryView !== "local"}>
          {libraryView === "local" ? <LocalDecisionList api={api} /> : null}
        </div>
      </div>

      {selected === null ? null : (
        <ModalDialog
          title="决策详情"
          description={`${selected.project} · ${dateFormatter.format(
            new Date(selected.created),
          )}`}
          size="wide"
          // While something is being written here, Escape, a click outside or the close button does not throw it away:
          // its own 取消 does. Once it is being saved it may be closed; the save finishes without reopening anything.
          dismissible={!detailEditing || detailSaving}
          onClose={closeDetails}
          actions={
            <>
              {copyNotice === null || copyNotice.id !== selected.id ? null : (
                <span
                  className={`decision-detail-copy-notice${copyNotice.ok ? "" : " error"}`}
                  role="status"
                >
                  {copyNotice.text}
                </span>
              )}
              <IconButton
                aria-label="复制为 Markdown"
                onClick={() => void copyDecision()}
              >
                <ActionIcon name="copy" />
              </IconButton>
            {/* Nothing left to step to once the last item of a to-do list is done. */}
            {decisions.length === 0 ||
            (selectedIndex < 0 && !droppedOut) ||
            (selectedIndex >= 0 && decisions.length < 2) ? null : (
              <div className="decision-detail-nav" role="group" aria-label="逐条查看">
                <IconButton
                  aria-label="上一条决策"
                  disabled={detailEditing || neighbor(-1) === undefined}
                  onClick={() => stepDetail(-1)}
                >
                  <ActionIcon name="previous" />
                </IconButton>
                <span>
                  {selectedIndex >= 0 ? selectedIndex + 1 : "–"} / {decisions.length}
                </span>
                <span className="sr-only" role="status">{stepNotice?.id === selected.id ? stepNotice.text : ""}</span>
                <IconButton
                  aria-label="下一条决策"
                  disabled={detailEditing || neighbor(1) === undefined}
                  onClick={() => stepDetail(1)}
                >
                  <ActionIcon name="next" />
                </IconButton>
              </div>
            )}
            </>
          }
        >
          <article className={`decision-library-detail${detailEditingClass}`}>
            <p className="sr-only" role="status">{savedNotice}</p>
            <div className="decision-detail-main">
            <section className="decision-detail-question">
              <span>问题</span>
              <h3>{selected.question}</h3>
            </section>
            <section className="decision-detail-choice">
              <span>最终选择</span>
              <p>{selected.selectedAnswer}</p>
              <div className="decision-detail-choice-meta">
                <em className={`decision-rationale-chip ${selected.rationaleStatus}`}>
                  {rationaleLabels[selected.rationaleStatus]}
                </em>
                <span>
                  {sourceLabels[selected.sourceClient] ?? selected.sourceClient}
                </span>
                {selected.sourceUrl === undefined ? null : (
                  <button
                    type="button"
                    className="text-button"
                    onClick={() => {
                      const link = selected.sourceUrl!;
                      setFailedSourceLink(null);
                      void api.openPrLink(link).catch(() => setFailedSourceLink(link));
                    }}
                  >
                    打开原评论
                  </button>
                )}
              </div>
              {failedSourceLink !== null && failedSourceLink === selected.sourceUrl ? (
                <p className="error-message" role="alert">
                  无法打开原评论：它不在已添加的代码平台链接下，或系统拒绝了打开。
                </p>
              ) : null}
            </section>
            <section className="decision-detail-rationale">
              <div className="decision-outcome-heading">
                <h4>决策理由</h4>
                {selected.rationaleStatus !== "deferred" ||
                editingRationale ||
                editingExpected || editingOutcome ||
                editingReview ||
                editingReviewSchedule ||
                editingPrinciples ? null : (
                  <button
                    type="button"
                    className="text-button"
                    data-opens-editor="rationale"
                    onClick={beginRationaleEdit}
                  >
                    补充理由
                  </button>
                )}
              </div>
              {editingRationale ? (
                <div className="decision-outcome-editor">
                  <label htmlFor="decision-rationale-input">理由原文</label>
                  <textarea
                    id="decision-rationale-input"
                    autoFocus
                    maxLength={8_000}
                    value={rationaleDraft}
                    placeholder="写下当时为什么这样选。"
                    onChange={(event) => setRationaleDraft(event.currentTarget.value)}
                  />
                  <div className="decision-outcome-editor-footer">
                    <span>{rationaleDraft.length} / 8000</span>
                    <div>
                      <button
                        type="button"
                        className="text-button"
                        disabled={rationaleSaving}
                        onClick={() => {
                          setEditingRationale(false);
                          setRationaleError(null);
                        }}
                      >
                        取消
                      </button>
                      <button
                        type="button"
                        className="primary-button"
                        disabled={rationaleSaving || rationaleDraft.trim().length === 0}
                        onClick={() => void saveRationale()}
                      >
                        {rationaleSaving ? "保存中…" : "保存理由"}
                      </button>
                    </div>
                  </div>
                  {rationaleError === null ? null : (
                    <p className="error-message" role="alert">
                      理由暂时无法保存：{rationaleError}
                    </p>
                  )}
                </div>
              ) : (
                <p className={selected.rationale === null ? "missing" : undefined}>
                  {selected.rationale ?? "没有补充理由。"}
                </p>
              )}
            </section>
            {selected.context === null ? null : (
              <section className="decision-detail-context">
                <span>当时上下文</span>
                <p>{selected.context}</p>
              </section>
            )}
            {/* Kept visible while reviewing: it is what the result is compared with. */}
            {editingExpected ? (
              <section className="decision-detail-expected">
                <div className="decision-outcome-editor">
                  <label htmlFor="decision-expected-input">预期结果</label>
                  <textarea
                    id="decision-expected-input"
                    autoFocus
                    maxLength={4_000}
                    value={expectedDraft}
                    placeholder="结果出来之前写下：做完之后预期会看到什么。"
                    onChange={(event) => setExpectedDraft(event.currentTarget.value)}
                  />
                  <div className="decision-outcome-editor-footer">
                    <span>{expectedDraft.length} / 4000</span>
                    <div>
                      <button
                        type="button"
                        className="text-button"
                        disabled={expectedSaving}
                        onClick={() => {
                          setEditingExpected(false);
                          setExpectedError(null);
                        }}
                      >
                        取消
                      </button>
                      <button
                        type="button"
                        className="primary-button"
                        disabled={expectedSaving || expectedDraft.trim().length === 0}
                        onClick={() => void saveExpected()}
                      >
                        {expectedSaving ? "保存中…" : "保存预期"}
                      </button>
                    </div>
                  </div>
                  {expectedError === null ? null : (
                    <p className="error-message" role="alert">
                      预期暂时无法保存：{expectedError}
                    </p>
                  )}
                </div>
              </section>
            ) : selected.expectedOutcome || selected.outcome === null ? (
              <section className="decision-detail-expected">
                <div className="decision-outcome-heading">
                  <h4>预期结果</h4>
                  {selected.outcome !== null || detailEditing ? null : (
                    <button type="button" className="text-button" data-opens-editor="expected" onClick={beginExpectedEdit}>
                      {selected.expectedOutcome ? "修改预期" : "补写预期"}
                    </button>
                  )}
                </div>
                {selected.expectedOutcome ? (
                  <p>{selected.expectedOutcome}</p>
                ) : (
                  <p className="missing">结果出来之前写下预期，复盘时才有对照。</p>
                )}
              </section>
            ) : null}
            <section className="decision-outcome-section">
              <div className="decision-outcome-heading">
                <h4>实际结果</h4>
                {editingExpected || editingOutcome ||
                editingReview ||
                editingReviewSchedule ||
                editingPrinciples ||
                editingRationale ? null : (
                  <button type="button" className="text-button" data-opens-editor="outcome" onClick={beginOutcomeEdit}>
                    {selected.outcome === null ? "记录结果" : "更新结果"}
                  </button>
                )}
              </div>
              {editingOutcome ? (
                <div className="decision-outcome-editor">
                  <label htmlFor="decision-outcome-input">结果说明</label>
                  <textarea
                    id="decision-outcome-input"
                    autoFocus
                    maxLength={8_000}
                    value={outcomeDraft}
                    placeholder="记录实施后的实际效果、偏差或新的结论。"
                    onChange={(event) => setOutcomeDraft(event.currentTarget.value)}
                  />
                  <div className="decision-outcome-editor-footer">
                    <span>{outcomeDraft.length} / 8000</span>
                    <div>
                      <button
                        type="button"
                        className="text-button"
                        disabled={outcomeSaving}
                        onClick={() => {
                          setEditingOutcome(false);
                          setOutcomeError(null);
                        }}
                      >
                        取消
                      </button>
                      <button
                        type="button"
                        className="primary-button"
                        disabled={outcomeSaving || outcomeDraft.trim().length === 0}
                        onClick={() => void saveOutcome()}
                      >
                        {outcomeSaving ? "保存中…" : "保存结果"}
                      </button>
                    </div>
                  </div>
                  {outcomeError === null ? null : (
                    <p className="error-message" role="alert">
                      结果暂时无法保存：{outcomeError}
                    </p>
                  )}
                </div>
              ) : (
                <p>{selected.outcome ?? "尚未记录实际结果。"}</p>
              )}
            </section>
            <section className="decision-review-section">
              <div className="decision-outcome-heading">
                <h4>预期 / 实际复盘</h4>
                {selected.outcome === null ||
                editingReview ||
                editingExpected || editingOutcome ||
                editingReviewSchedule ||
                editingPrinciples ||
                editingRationale ? null : (
                  <button
                    type="button"
                    className="text-button"
                    data-opens-editor="review"
                    onClick={beginReviewEdit}
                  >
                    {selected.outcomeReview === null ? "开始复盘" : "更新复盘"}
                  </button>
                )}
              </div>
              {selected.outcome === null ? (
                <p>记录实际结果后即可比较当初选择与最终效果。</p>
              ) : editingReview ? (
                <div className="decision-review-editor">
                  <fieldset>
                    <legend>实际结果与当初选择相比</legend>
                    <div className="decision-verdict-options">
                      {verdictOptions.map(([value, label]) => (
                        <button
                          key={value}
                          type="button"
                          className={value}
                          aria-pressed={reviewVerdict === value}
                          onClick={() => setReviewVerdict(value)}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                  </fieldset>
                  <label htmlFor="decision-review-lesson">复盘经验（可选）</label>
                  <textarea
                    id="decision-review-lesson"
                    autoFocus
                    maxLength={8_000}
                    value={reviewLesson}
                    placeholder="哪些判断有效、哪里出现偏差、下次应如何调整。"
                    onChange={(event) => setReviewLesson(event.currentTarget.value)}
                  />
                  <div className="decision-outcome-editor-footer">
                    <span>{reviewLesson.length} / 8000</span>
                    <div>
                      <button
                        type="button"
                        className="text-button"
                        disabled={reviewSaving}
                        onClick={() => {
                          setEditingReview(false);
                          setReviewError(null);
                        }}
                      >
                        取消
                      </button>
                      <button
                        type="button"
                        className="primary-button"
                        disabled={reviewSaving}
                        onClick={() => void saveReview()}
                      >
                        {reviewSaving ? "保存中…" : "保存复盘"}
                      </button>
                    </div>
                  </div>
                  {reviewError === null ? null : (
                    <p className="error-message" role="alert">
                      复盘暂时无法保存：{reviewError}
                    </p>
                  )}
                </div>
              ) : selected.outcomeReview === null ? (
                <p>实际结果已记录，尚未进行复盘。</p>
              ) : (
                <div className="decision-review-summary">
                  <strong
                    className={`decision-review-verdict ${selected.outcomeReview.verdict}`}
                  >
                    {verdictLabels[selected.outcomeReview.verdict]}
                  </strong>
                  <time dateTime={selected.outcomeReview.reviewedAt}>
                    {dateFormatter.format(
                      new Date(selected.outcomeReview.reviewedAt),
                    )}
                  </time>
                  <p>{selected.outcomeReview.lesson ?? "未填写复盘经验。"}</p>
                  <div className="decision-methodology-ready">
                    <span>
                      <strong>这条决策现在可作为方法论证据</strong>
                      <small>可与其它已复盘决策一起提炼成可复用原则。</small>
                    </span>
                    {/* Leaving for 方法论 takes this page and a half-written draft with it: held, as stepping is. */}
                    <button
                      type="button"
                      className="primary-button"
                      disabled={detailEditing}
                      title={detailEditing ? "先保存或取消正在填写的内容" : undefined}
                      onClick={() => onDistillDecision(selected.id)}
                    >
                      用于提炼原则
                    </button>
                  </div>
                </div>
              )}
            </section>
            <DecisionEvidencePanel key={selected.id} api={api} decisionId={selected.id} revision={JSON.stringify([selected.outcome, selected.outcomeReview, selected.reviewDueDate, refreshRevision])} onEditingChange={setEvidenceEditing} />
            </div>
            <aside className="decision-detail-side" aria-label="进度与关联">
              {/* Only principles in use count; one set aside or still unconfirmed is listed below, not counted. */}
              <DecisionLifecycle
                decision={selected}
                distilledCount={distilled.filter(({ status }) => status === "accepted").length}
              />
              <SameQuestionDecisions
                api={api}
                decision={selected}
                onOpen={(item) => {
                  if (!detailEditing) setSelected(item);
                }}
              />
            <section
              className={`decision-review-plan${
                selected.outcomeReview !== null ? " completed" : ""
              }`}
            >
              <div className="decision-outcome-heading">
                <h4>复盘计划</h4>
                {selected.outcomeReview !== null ||
                editingExpected || editingOutcome ||
                editingReview ||
                editingReviewSchedule ||
                editingPrinciples ||
                editingRationale ? null : (
                  <button
                    type="button"
                    className="text-button"
                    data-opens-editor="schedule"
                    onClick={beginReviewScheduleEdit}
                  >
                    {selected.reviewDueDate === null ? "安排日期" : "调整日期"}
                  </button>
                )}
              </div>
              {selected.outcomeReview !== null ? (
                <div className="decision-review-plan-copy">
                  <strong>复盘已完成</strong>
                  <span>
                    {dateFormatter.format(
                      new Date(selected.outcomeReview.reviewedAt),
                    )}
                  </span>
                </div>
              ) : editingReviewSchedule ? (
                <div className="decision-review-schedule-editor">
                  <div className="decision-review-presets" aria-label="快捷日期">
                    {/* The same spans the dashboard offers when a review is postponed, plus tomorrow. */}
                    {([
                      [1, "明天"],
                      [7, "一周后"],
                      [14, "两周后"],
                      [30, "一个月后"],
                    ] as const).map(([days, label]) => (
                      <button
                        key={days}
                        type="button"
                        aria-pressed={reviewScheduleDraft === dateAfter(days)}
                        onClick={() => setReviewScheduleDraft(dateAfter(days))}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                  <label htmlFor="decision-review-due-date">复盘日期</label>
                  {/* A date field, as a preference's review date is: what it holds is always a real date or
                      nothing, never text the save would turn down with a validation error. */}
                  <input
                    id="decision-review-due-date"
                    type="date"
                    autoFocus
                    value={reviewScheduleDraft}
                    onChange={(event) =>
                      setReviewScheduleDraft(event.currentTarget.value)
                    }
                  />
                  <div className="decision-review-schedule-actions">
                    <span>到期后只进入首页收件箱，不会自动弹出窗口。</span>
                    <div>
                      {selected.reviewDueDate === null ? null : (
                        <button
                          type="button"
                          className="text-button"
                          disabled={reviewScheduleSaving}
                          onClick={() => void saveReviewSchedule(null)}
                        >
                          取消安排
                        </button>
                      )}
                      <button
                        type="button"
                        className="text-button"
                        disabled={reviewScheduleSaving}
                        onClick={() => setEditingReviewSchedule(false)}
                      >
                        返回
                      </button>
                      <button
                        type="button"
                        className="primary-button"
                        disabled={
                          reviewScheduleSaving || reviewScheduleDraft.length === 0
                        }
                        onClick={() => void saveReviewSchedule()}
                      >
                        {reviewScheduleSaving ? "保存中…" : "保存日期"}
                      </button>
                    </div>
                  </div>
                  {reviewScheduleError === null ? null : (
                    <p className="error-message" role="alert">
                      复盘日期暂时无法保存：{reviewScheduleError}
                    </p>
                  )}
                </div>
              ) : selected.reviewDueDate === null ? (
                <div className="decision-review-plan-copy empty">
                  <strong>尚未安排</strong>
                  <span>安排一个合适的日期，届时会出现在首页复盘收件箱。</span>
                </div>
              ) : (
                <div
                  className={`decision-review-plan-copy${
                    selected.reviewDueDate <= calendarDate(new Date())
                      ? " due"
                      : ""
                  }`}
                >
                  <strong>
                    {selected.reviewDueDate <= calendarDate(new Date())
                      ? "已到复盘时间"
                      : `${dueLabel(selected.reviewDueDate)}复盘`}
                  </strong>
                  <span>只在首页提醒，不会主动打开应用。</span>
                </div>
              )}
            </section>
            <section className="decision-applied-principles">
              <div className="decision-outcome-heading">
                <h4>采用的方法论</h4>
                {editingExpected || editingOutcome ||
                editingReview ||
                editingReviewSchedule ||
                editingPrinciples ||
                editingRationale ? null : (
                  <button
                    type="button"
                    className="text-button"
                    data-opens-editor="principles"
                    onClick={() => void beginPrincipleEdit()}
                  >
                    {selected.appliedPrincipleIds.length === 0
                      ? "关联原则"
                      : "调整关联"}
                  </button>
                )}
              </div>
              {editingPrinciples ? (
                <div className="decision-principle-editor">
                  <p>
                    只记录这次决策实际采用过的原则，最多 5 条；不会由模型自动判断。
                  </p>
                  {principleLoading ? (
                    <span className="decision-principle-loading">正在读取已采纳原则…</span>
                  ) : principleChoices.length === 0 ? (
                    <span className="decision-principle-loading">
                      还没有已采纳原则，可先到方法论中审核候选。
                    </span>
                  ) : (
                    <div className="decision-principle-choices">
                      {principleChoices.map((choice) => {
                        const checked = selectedPrincipleIds.includes(choice.id);
                        return (
                          <label
                            key={choice.id}
                            className={checked ? "selected" : ""}
                          >
                            <input
                              type="checkbox"
                              checked={checked}
                              disabled={
                                principleSaving ||
                                (!checked &&
                                  (!choice.selectable ||
                                    selectedPrincipleIds.length >= 5))
                              }
                              onChange={() => togglePrinciple(choice)}
                            />
                            <span>
                              <strong>{choice.title}</strong>
                              {choice.suggestion === undefined ? null : (
                                <small className={`decision-principle-hint ${choice.suggestion.strength}`}>
                                  {choice.suggestion.strength === "strong" ? "强相关" : "可能相关"}
                                  {" · "}
                                  {choice.suggestion.reason}
                                </small>
                              )}
                              {choice.selectable ? null : (
                                <small>仅保留历史关联，取消后不能重新添加</small>
                              )}
                            </span>
                          </label>
                        );
                      })}
                    </div>
                  )}
                  {principleError === null ? null : (
                    <p className="error-message" role="alert">
                      原则关联暂时无法处理：{principleError}
                    </p>
                  )}
                  <footer>
                    <span>已选 {selectedPrincipleIds.length} / 5</span>
                    <div>
                      <button
                        type="button"
                        className="text-button"
                        disabled={principleSaving}
                        onClick={() => {
                          setEditingPrinciples(false);
                          setPrincipleError(null);
                        }}
                      >
                        取消
                      </button>
                      <button
                        type="button"
                        className="primary-button"
                        disabled={principleSaving || principleLoading}
                        onClick={() => void savePrinciples()}
                      >
                        {principleSaving ? "保存中…" : "保存关联"}
                      </button>
                    </div>
                  </footer>
                </div>
              ) : selected.appliedPrinciples.length === 0 ? (
                <p>尚未记录这次决策实际采用了哪些原则。</p>
              ) : (
                <div className="decision-principle-tags">
                  {selected.appliedPrinciples.map((principle) => (
                    // The principle is where its conditions, cautions and
                    // evidence live; naming it without a way there leaves the
                    // reader to go find it by hand.
                    <button
                      key={principle.id}
                      type="button"
                      className={principle.status}
                      disabled={detailEditing}
                      title={detailEditing ? "先保存或取消正在填写的内容" : `打开原则：${principle.title}`}
                      onClick={() => onOpenPrinciple(principle.id)}
                    >
                      {principle.title}
                      {principle.status === "retired" ? " · 已归档" : ""}
                    </button>
                  ))}
                  {selected.appliedPrincipleIds.length >
                  selected.appliedPrinciples.length ? (
                    <span className="missing">部分历史原则已不可用</span>
                  ) : null}
                </div>
              )}
            </section>
            {distilled.length === 0 ? null : (
              <section className="decision-applied-principles">
                <div className="decision-outcome-heading">
                  <h4>由此沉淀的原则</h4>
                </div>
                <div className="decision-principle-tags">
                  {distilled.map((principle) => (
                    <button
                      key={principle.id}
                      type="button"
                      className={principle.status}
                      disabled={detailEditing}
                      title={detailEditing ? "先保存或取消正在填写的内容" : `打开原则：${principle.title}`}
                      onClick={() => onOpenPrinciple(principle.id)}
                    >
                      {principle.title}
                      {principle.status === "accepted"
                        ? ""
                        : ` · ${principleStatusLabels[principle.status]}`}
                    </button>
                  ))}
                </div>
              </section>
            )}
            </aside>
          </article>
        </ModalDialog>
      )}
      {recording ? (
        <ActiveRecordDialog
          api={api}
          onClose={() => setRecording(false)}
          onSaved={(result) => {
            setRecording(false);
            setRecordNotice({
              text: result.status === "updated" ? "已更新原有记录" : "记录已保存",
              forId: result.recordKind === "decision" ? result.recordId : null,
            });
            setRefreshRevision((value) => value + 1);
            if (result.recordKind !== "decision") setLibraryView("journal");
            onRecorded(result);
          }}
        />
      ) : null}
    </section>
  );
};
