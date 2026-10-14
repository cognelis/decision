// @vitest-environment jsdom

import type { AssistantMessage } from "@cognelis/decision-protocol";
import { assistantMessageSchema } from "@cognelis/decision-protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  byRecency,
  conversationTitle,
  emptyConversation,
  loadSessions,
  saveSessions,
  type AssistantConversation,
} from "../src/renderer/components/pages/assistant/assistant-session.js";

const KEY = "decision.assistant.sessions.v2";
const LEGACY_KEY = "decision.assistant.session.v1";
const provider = { profileId: "qwen", label: "本机模型", kind: "qwen" as const, model: "test", leavesDevice: false };

const conversation = (...contents: string[]): AssistantMessage[] =>
  contents.map((content, index) => ({
    role: index % 2 === 0 ? "user" : "assistant",
    content,
  }));

const make = (
  overrides: Partial<AssistantConversation> = {},
): AssistantConversation => ({ ...emptyConversation(), ...overrides });

describe("assistant session storage", () => {
  afterEach(() => { vi.restoreAllMocks(); });
  beforeEach(() => {
    localStorage.clear();
  });

  it("keeps each vault's conversations apart, carrying the shared ones into the first vault opened", () => {
    const earlier = make({ title: "A 公司薪资职级表", messages: conversation("职级怎么定？", "按表 [1]。") });
    // Saved by an earlier build under the one key every vault shared.
    saveSessions({ activeId: earlier.id, conversations: [earlier] });

    // The vault the reader opens first takes them, as they were its own; saved there, the shared copy goes.
    const first = loadSessions("/vaults/A");
    expect(first.conversations.map((item) => item.title)).toEqual(["A 公司薪资职级表"]);
    saveSessions(first, "/vaults/A");
    expect(localStorage.getItem(KEY)).toBeNull();

    // Another vault: kept under one key, A's conversations showed there and went out again as its evidence.
    expect(loadSessions("/vaults/B").conversations.map((item) => item.title)).toEqual([""]);
    expect(loadSessions("/vaults/A").conversations.map((item) => item.title)).toEqual(["A 公司薪资职级表"]);
  });

  it("keeps stored answers readable by the pre-provider schema and restores provenance separately", () => {
    const current = make({ messages: [{ role: "assistant", content: "回退后也不能丢失的回答", provider }] });
    saveSessions({ activeId: current.id, conversations: [current] });
    const raw = JSON.parse(localStorage.getItem(KEY)!);
    // Verified against 4f44baf: provider is the only runtime schema addition.
    const previousMessageSchema = assistantMessageSchema.pick({ role: true, content: true, citations: true, steps: true, turnId: true, tokens: true });
    expect(previousMessageSchema.safeParse(raw.conversations[0].messages[0]).success).toBe(true);
    expect(loadSessions().conversations[0]?.messages).toEqual(current.messages);
    // An older build strips unknown conversation-level metadata when saving.
    delete raw.conversations[0].messageProviders;
    localStorage.setItem(KEY, JSON.stringify(raw));
    expect(loadSessions().conversations[0]?.messages).toEqual([{ role: "assistant", content: "回退后也不能丢失的回答" }]);
  });

  it("reads the previous inline provider format and rewrites it compatibly", () => {
    const current = make({ messages: [{ role: "assistant", content: "已有来源信息", provider }] });
    localStorage.setItem(KEY, JSON.stringify({ activeId: current.id, conversations: [current] }));
    const loaded = loadSessions();
    expect(loaded.conversations[0]?.messages[0]?.provider).toEqual(provider);
    saveSessions(loaded);
    expect(JSON.parse(localStorage.getItem(KEY)!).conversations[0].messages[0]).not.toHaveProperty("provider");
    expect(loadSessions().conversations[0]?.messages[0]?.provider).toEqual(provider);
  });

  it("keeps provenance aligned when an unreadable message is skipped", () => {
    const current = make();
    const other = { ...provider, profileId: "other", label: "另一个模型" };
    localStorage.setItem(KEY, JSON.stringify({ activeId: current.id, conversations: [{ ...current,
      messages: [{ role: "assistant", content: "第一答" }, null, { role: "assistant", content: "第二答" }],
      messageProviders: [provider, null, other],
    }] }));
    const loaded = loadSessions().conversations[0]!.messages;
    expect(loaded.map((message) => message.content)).toEqual(["第一答", "第二答"]);
    expect(loaded.map((message) => message.provider?.profileId)).toEqual(["qwen", "other"]);
  });

  it("carries the model, the scope and the conversation across a remount", () => {
    const open = make({
      id: "c-1",
      profileId: "remote-deepseek",
      scope: "obsidian",
      messages: conversation("上一轮问题", "上一轮回答"),
    });
    saveSessions({ activeId: "c-1", conversations: [open] });

    const restored = loadSessions();
    expect(restored.activeId).toBe("c-1");
    expect(restored.conversations[0]).toMatchObject({
      profileId: "remote-deepseek",
      scope: "obsidian",
      messages: conversation("上一轮问题", "上一轮回答"),
    });
  });

  it("reports a failed write without replacing history and succeeds when retried", () => {
    const original = make({ messages: conversation("已保存的问题", "已保存的回答") });
    const sessions = { activeId: original.id, conversations: [original] };
    expect(saveSessions(sessions)).toBe(true);
    const stored = localStorage.getItem(KEY);
    const changed = { ...sessions, conversations: [{ ...original, messages: conversation("新问题", "新回答") }] };
    vi.spyOn(Storage.prototype, "setItem").mockImplementationOnce(() => {
      throw new DOMException("Storage is full", "QuotaExceededError");
    });
    expect(saveSessions(changed)).toBe(false);
    expect(localStorage.getItem(KEY)).toBe(stored);
    expect(saveSessions(changed)).toBe(true);
    expect(loadSessions()).toEqual(changed);
  });

  it("reports success even if retiring the legacy copy fails after the new copy is saved", () => {
    const current = make({ messages: conversation("问题", "回答") });
    const sessions = { activeId: current.id, conversations: [current] };
    vi.spyOn(Storage.prototype, "removeItem").mockImplementationOnce(() => {
      throw new DOMException("Storage denied", "SecurityError");
    });
    expect(saveSessions(sessions)).toBe(true);
    expect(loadSessions()).toEqual(sessions);
  });

  it("reports failure when storage is unavailable", () => {
    const current = make();
    vi.spyOn(window, "localStorage", "get").mockImplementation(() => {
      throw new DOMException("Storage denied", "SecurityError");
    });
    expect(saveSessions({ activeId: current.id, conversations: [current] })).toBe(false);
    expect(() => loadSessions()).toThrow();
  });

  it("writes only the fields it owns, whatever the caller spread in", () => {
    saveSessions({
      activeId: "c-1",
      conversations: [
        {
          ...make({ id: "c-1", messages: conversation("问题") }),
          // In-flight UI state rides along on the conversation object; none of
          // it belongs in storage.
          ...({ running: true } as unknown as Record<string, never>),
        },
      ],
    });

    const stored = JSON.parse(localStorage.getItem(KEY) ?? "{}") as {
      conversations: Array<Record<string, unknown>>;
    };
    expect(Object.keys(stored.conversations[0] ?? {}).sort()).toEqual([
      "draft",
      "favorite",
      "id",
      "messageProviders",
      "messages",
      "profileId",
      "scope",
      "title",
      "updatedAt",
    ]);
  });

  it.each([undefined, 42])("reads older or invalid draft fields as empty without losing messages: %j", (draft) => {
    const stored = make({ messages: conversation("已发送的问题", "已收到的回答") });
    localStorage.setItem(KEY, JSON.stringify({ activeId: stored.id, conversations: [{ ...stored, draft }] }));
    const restored = loadSessions().conversations[0]!;
    expect(restored.draft).toBe("");
    expect(restored.messages).toEqual(stored.messages);
  });

  it.each([undefined, { profileId: 42 }])("keeps an old answer when optional provider metadata is missing or invalid: %j", (provider) => {
    const stored = make();
    localStorage.setItem(KEY, JSON.stringify({ activeId: stored.id, conversations: [{ ...stored, messages: [{ role: "assistant", content: "仍需保留的旧回答", provider }] }] }));
    const restored = loadSessions().conversations[0]!;
    expect(restored.messages).toHaveLength(1);
    expect(restored.messages[0]?.content).toBe("仍需保留的旧回答");
    expect(restored.messages[0]?.provider).toBeUndefined();
  });

  it("keeps several conversations instead of replacing the last one", () => {
    saveSessions({
      activeId: "c-2",
      conversations: [
        make({ id: "c-2", messages: conversation("第二段") }),
        make({ id: "c-1", messages: conversation("第一段") }),
      ],
    });

    const restored = loadSessions();
    expect(restored.conversations).toHaveLength(2);
    expect(restored.activeId).toBe("c-2");
  });

  it("adopts the single conversation an older build left behind", () => {
    localStorage.setItem(
      LEGACY_KEY,
      JSON.stringify({
        profileId: "qwen",
        scope: "decisions",
        messages: conversation("升级前问的"),
      }),
    );

    const restored = loadSessions();

    // Upgrading must not silently start the reader over.
    expect(restored.conversations[0]).toMatchObject({
      profileId: "qwen",
      scope: "decisions",
      messages: conversation("升级前问的"),
    });
    // And the old key is retired so it cannot be adopted twice.
    expect(localStorage.getItem(LEGACY_KEY)).toBeNull();
    expect(localStorage.getItem(KEY)).not.toBeNull();
  });

  it.each(["reload", "save"])("keeps the legacy copy until a successful %s", (retry) => {
    const legacy = JSON.stringify({
      profileId: "qwen",
      scope: "decisions",
      messages: conversation("升级前的问题", "升级前的回答"),
    });
    localStorage.setItem(LEGACY_KEY, legacy);
    const write = vi.spyOn(Storage.prototype, "setItem").mockImplementationOnce(() => {
      throw new DOMException("Storage is full", "QuotaExceededError");
    });

    const restored = loadSessions();
    expect(restored.conversations[0]?.messages).toEqual(conversation("升级前的问题", "升级前的回答"));
    expect(localStorage.getItem(KEY)).toBeNull();
    expect(localStorage.getItem(LEGACY_KEY)).toBe(legacy);

    write.mockRestore();
    if (retry === "save") saveSessions(restored);
    expect(loadSessions().conversations[0]?.messages).toEqual(conversation("升级前的问题", "升级前的回答"));
    expect(localStorage.getItem(KEY)).not.toBeNull();
    expect(localStorage.getItem(LEGACY_KEY)).toBeNull();
  });

  it.each([KEY, LEGACY_KEY])("preserves unreadable data in %s instead of returning a fresh conversation", (key) => {
    localStorage.setItem(key, "{not json");
    expect(() => loadSessions()).toThrow();
    expect(localStorage.getItem(key)).toBe("{not json");
  });

  it.each([null, {}, { conversations: "unknown format" }, { conversations: [null, 42] }])("rejects an unreadable top-level store: %j", (value) => {
    localStorage.setItem(KEY, JSON.stringify(value));
    expect(() => loadSessions()).toThrow();
    expect(localStorage.getItem(KEY)).toBe(JSON.stringify(value));
  });

  it("preserves a legacy store with an unsupported message collection", () => {
    const raw = JSON.stringify({ messages: { old: "仍需恢复的历史" } });
    localStorage.setItem(LEGACY_KEY, raw);
    expect(() => loadSessions()).toThrow();
    expect(localStorage.getItem(LEGACY_KEY)).toBe(raw);
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it.each(["second", "missing"])("keeps healthy conversations around invalid entries with active id %s", (activeId) => {
    const first = make({ id: "first", messages: conversation("第一段问题", "第一段回答") });
    const second = make({ id: "second", messages: conversation("第二段问题", "第二段回答") });
    localStorage.setItem(KEY, JSON.stringify({
      activeId,
      conversations: [null, first, "invalid", [], 42, second],
    }));

    const restored = loadSessions();
    expect(restored.conversations).toEqual([first, second]);
    expect(restored.activeId).toBe(activeId === "second" ? "second" : "first");
    // Mounting the panel writes this result back immediately; the usable
    // history must survive that save as well as the initial read.
    saveSessions(restored);
    expect(loadSessions()).toEqual(restored);
  });

  it("keeps the usable parts of a conversation an older build wrote", () => {
    localStorage.setItem(
      KEY,
      JSON.stringify({
        activeId: "c-1",
        conversations: [
          {
            id: "c-1",
            title: "",
            updatedAt: 5,
            profileId: "qwen",
            scope: "无效范围",
            messages: [{ role: "user" }],
            legacyField: 1,
          },
        ],
      }),
    );

    expect(loadSessions().conversations[0]).toMatchObject({
      profileId: "qwen",
      scope: "all",
      messages: [],
    });
  });

  it("drops only the message it cannot read, not the conversation", () => {
    localStorage.setItem(
      KEY,
      JSON.stringify({
        activeId: "c-1",
        conversations: [
          {
            id: "c-1",
            title: "",
            updatedAt: 5,
            profileId: "qwen",
            scope: "all",
            messages: [
              { role: "user", content: "问题" },
              // Shaped like an answer a later build wrote: a step kind this
              // build's strict schema does not know.
              {
                role: "assistant",
                content: "回答",
                steps: [{ kind: "从未见过的步骤" }],
              },
              { role: "user", content: "追问" },
            ],
          },
        ],
      }),
    );

    expect(loadSessions().conversations[0]?.messages).toEqual([
      { role: "user", content: "问题" },
      { role: "user", content: "追问" },
    ]);
  });

  it("archives all messages independently of the model context limit", () => {
    saveSessions({
      activeId: "c-1",
      conversations: [
        make({
          id: "c-1",
          messages: conversation(
            ...Array.from({ length: 60 }, (_unused, turn) => `第 ${turn} 条`),
          ).map((message) => message.role === "assistant" ? { ...message, provider: { ...provider, label: message.content } } : message),
        }),
      ],
    });

    const restored = loadSessions().conversations[0]!;
    expect(restored.messages).toHaveLength(60);
    expect(restored.messages[0]?.content).toBe("第 0 条");
    expect(restored.messages.at(-1)?.content).toBe("第 59 条");
    for (const message of restored.messages.filter((item) => item.role === "assistant")) {
      expect(message.provider?.label).toBe(message.content);
    }
  });

  it("keeps older conversations and favorites beyond ten", () => {
    saveSessions({
      activeId: "c-0",
      conversations: Array.from({ length: 14 }, (_unused, index) =>
        make({ id: `c-${index}`, updatedAt: 1_000 - index, favorite: index === 13 }),
      ),
    });

    expect(loadSessions().conversations).toHaveLength(14);
    expect(loadSessions().conversations[13]?.favorite).toBe(true);
  });

  it("falls back to a real conversation when the active id is gone", () => {
    saveSessions({
      activeId: "c-missing",
      conversations: [make({ id: "c-1" })],
    });

    expect(loadSessions().activeId).toBe("c-1");
  });

  it("names a conversation after the question that opened it", () => {
    expect(
      conversationTitle(make({ messages: conversation("为什么先留测试环境？") })),
    ).toBe("为什么先留测试环境？");
    expect(conversationTitle(make())).toBe("新对话");
    expect(
      conversationTitle(make({ messages: conversation("问".repeat(50)) })),
    ).toHaveLength(24);
    // Cut where an emoji sits, the title keeps none of it rather than half.
    expect(
      conversationTitle(make({ messages: conversation(`${"问".repeat(22)}🚀还有更多`) })),
    ).toBe(`${"问".repeat(22)}…`);
  });

  it("orders conversations with the most recent first", () => {
    const ordered = byRecency([
      make({ id: "old", updatedAt: 1 }),
      make({ id: "new", updatedAt: 9 }),
    ]);

    expect(ordered.map((entry) => entry.id)).toEqual(["new", "old"]);
  });
});
