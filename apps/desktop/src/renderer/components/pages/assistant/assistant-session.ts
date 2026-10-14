import {
  assistantFeedbackRatingSchema,
  assistantMessageSchema,
  retrievalAnswerCitationSchema,
  type AssistantFeedbackRating,
  type RetrievalAnswerCitation,
  retrievalAnswerScopeSchema,
  type AssistantMessage,
  type RetrievalAnswerScope,
  clipText,
} from "@cognelis/decision-protocol";
import { z } from "zod";

const STORAGE_KEY = "decision.assistant.sessions.v2";
/** The single-conversation store this replaced; read once, then retired. */
const LEGACY_STORAGE_KEY = "decision.assistant.session.v1";

/**
 * Each vault's conversations under a key of their own. Kept under one key for every vault, another vault's
 * conversations, titles and excerpts showed after a switch, went out again as evidence, and their open buttons
 * opened whatever this vault holds under the same id. Conversations saved before under the shared key go to the
 * first vault opened since (for most readers the only one), and the shared copy is retired once that vault saves.
 */
const keyFor = (vault: string | null | undefined): string => {
  if (vault === null || vault === undefined) return STORAGE_KEY;
  // FNV-1a: a short, stable name for the path, not a secret.
  let hash = 0x811c9dc5;
  for (const character of vault) hash = Math.imul(hash ^ character.codePointAt(0)!, 0x01000193) >>> 0;
  return `${STORAGE_KEY}:${hash.toString(16).padStart(8, "0")}`;
};

export interface AssistantConversation {
  id: string;
  /** Derived from the opening question; blank until one is asked. */
  title: string;
  favorite?: boolean;
  selectedSources?: RetrievalAnswerCitation[] | undefined;
  updatedAt: number;
  profileId: string | null;
  scope: RetrievalAnswerScope;
  messages: AssistantMessage[];
  draft: string;
  /** The rating given each answer, by turn: kept with the conversation, it was offered again after a restart. */
  ratings?: Record<string, AssistantFeedbackRating> | undefined;
}

export interface AssistantSessions {
  activeId: string;
  conversations: AssistantConversation[];
}

const newId = (): string =>
  `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

export const emptyConversation = (): AssistantConversation => ({
  id: newId(),
  title: "",
  favorite: false,
  updatedAt: Date.now(),
  profileId: null,
  scope: "all",
  messages: [],
  draft: "",
});

/** The opening question names the conversation; nothing else is as recognisable. */
export const conversationTitle = (
  conversation: AssistantConversation,
): string => {
  if (conversation.title.length > 0) return conversation.title;
  const opening = conversation.messages.find(
    (message) => message.role === "user",
  );
  const content = opening?.content ?? conversation.draft;
  if (content.trim().length === 0) return "新对话";
  const text = `${opening === undefined ? "草稿：" : ""}${content.trim().replace(/\s+/gu, " ")}`;
  return text.length <= 24 ? text : `${clipText(text, 23)}…`;
};

/**
 * Anything already in storage is untrusted: it may come from an older build, a
 * hand-edited store, or a schema that has since changed. Parse it rather than
 * cast it. Whole-store failures must reach the reader so a fresh session
 * cannot silently overwrite the history that failed to load.
 */
/**
 * One unreadable message must not take the rest of the conversation with it.
 * `z.array(schema).catch([])` blanks the whole thread on a single bad entry,
 * and the reader gets no signal: running an older build over a store a newer
 * one wrote would silently empty their history.
 */
const messagesSchema = z
  .array(z.unknown())
  .catch([])
  .transform((entries) =>
    entries.flatMap((entry) => {
      const parsed = assistantMessageSchema.safeParse(entry);
      return parsed.success ? [parsed.data] : [];
    }),
  );

const conversationSchema = z
  .object({
    id: z.string().min(1).max(64).catch(newId),
    title: z.string().max(200).catch(""),
    favorite: z.boolean().catch(false),
    selectedSources: z.array(retrievalAnswerCitationSchema).max(12).catch([]).optional(),
    updatedAt: z.number().int().nonnegative().catch(0),
    profileId: z.string().min(1).max(200).nullable().catch(null),
    scope: retrievalAnswerScopeSchema.catch("all"),
    messages: z.array(z.unknown()).catch([]),
    messageProviders: z.array(z.unknown()).catch([]),
    draft: z.string().catch(""),
    ratings: z.record(z.string().min(1).max(200), assistantFeedbackRatingSchema).optional().catch(undefined),
  })
  .strip()
  .transform(({ messages, messageProviders, ...conversation }) => ({
    ...conversation,
    // Restore by original position before invalid messages are filtered out.
    messages: messagesSchema.parse(messages.map((message, index) => {
      if (typeof message !== "object" || message === null || Array.isArray(message)) return message;
      return { ...message, provider: "provider" in message ? message.provider : messageProviders[index] };
    })),
  }));

const sessionsSchema = z
  .object({
    activeId: z.string().min(1).max(64).catch(""),
    conversations: z.array(z.unknown()).transform((entries, context) => {
      const conversations = entries.flatMap((entry) => {
        const parsed = conversationSchema.safeParse(entry);
        return parsed.success ? [parsed.data] : [];
      });
      if (entries.length > 0 && conversations.length === 0) {
        context.addIssue({ code: "custom", message: "No readable conversations" });
      }
      return conversations;
    }),
  })
  .strip();

/** The shape the single-conversation store used, so nothing is lost on upgrade. */
const legacySchema = z
  .object({
    profileId: z.string().min(1).max(200).nullable().catch(null),
    scope: retrievalAnswerScopeSchema.catch("all"),
    messages: z.array(z.unknown()).pipe(messagesSchema),
  })
  .strip();

const storage = (): Storage | null => {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    // Storage can be unavailable (disabled, or a partition without a quota).
    return null;
  }
};

const readLegacy = (store: Storage): AssistantSessions | null => {
  const raw = store.getItem(LEGACY_STORAGE_KEY);
  if (raw === null) return null;
  const parsed = legacySchema.parse(JSON.parse(raw));
  const carried: AssistantConversation = {
    ...emptyConversation(),
    ...parsed,
  };
  return { activeId: carried.id, conversations: [carried] };
};

export const loadSessions = (vault?: string | null): AssistantSessions => {
  const store = storage();
  const fresh = (): AssistantSessions => {
    const conversation = emptyConversation();
    return { activeId: conversation.id, conversations: [conversation] };
  };
  if (store === null) throw new Error("Conversation storage unavailable");

  const key = keyFor(vault);
  const raw = store.getItem(key) ?? (key === STORAGE_KEY ? null : store.getItem(STORAGE_KEY));
  if (raw === null) {
    // First run on this build: carry the one conversation the old store held
    // rather than silently starting the reader over.
    const migrated = readLegacy(store);
    if (migrated !== null) {
      saveSessions(migrated, vault);
      return migrated;
    }
    return fresh();
  }

  const parsed = sessionsSchema.parse(JSON.parse(raw));
  if (parsed.conversations.length === 0) return fresh();
  const conversations = parsed.conversations;
  const activeId =
    conversations.find(
      (conversation) => conversation.id === parsed.activeId,
    )?.id ?? conversations[0]!.id;
  return { activeId, conversations };
};

export const saveSessions = (sessions: AssistantSessions, vault?: string | null): boolean => {
  const store = storage();
  if (store === null) return false;
  const key = keyFor(vault);
  try {
    store.setItem(
      key,
      JSON.stringify({
        activeId: sessions.activeId,
        conversations: sessions.conversations.map((conversation) => {
          const messages = conversation.messages;
          return {
            id: conversation.id,
            title: conversation.title,
            favorite: conversation.favorite ?? false,
            selectedSources: conversation.selectedSources,
            updatedAt: conversation.updatedAt,
            profileId: conversation.profileId,
            scope: conversation.scope,
            // Older builds reject unknown message fields but ignore extra
            // conversation fields, so keep optional provenance separately.
            messages: messages.map(({ provider: _provider, ...message }) => message),
            messageProviders: messages.map((message) => message.provider ?? null),
            draft: conversation.draft,
            ...(conversation.ratings === undefined || Object.keys(conversation.ratings).length === 0
              ? {}
              : { ratings: conversation.ratings }),
          };
        }),
      }),
    );
  } catch {
    // Keep the in-memory conversation and any remaining legacy copy usable.
    return false;
  }
  try {
    // The legacy copy is retired only after the replacement has been written,
    // including an ordinary autosave following an earlier failed migration.
    store.removeItem(LEGACY_STORAGE_KEY);
    // As is the copy shared by every vault, once one vault holds its conversations under its own key.
    if (key !== STORAGE_KEY) store.removeItem(STORAGE_KEY);
  } catch {
    // The current copy is saved; legacy cleanup can wait for the next save.
  }
  return true;
};

/** Most recent first, so the picker reads in the order the reader thinks in. */
export const byRecency = (
  conversations: readonly AssistantConversation[],
): AssistantConversation[] =>
  [...conversations].sort((left, right) => right.updatedAt - left.updatedAt);
