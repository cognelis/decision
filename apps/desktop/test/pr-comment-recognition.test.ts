import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { prCommentSemanticKey } from "@cognelis/decision-core";
import type { ModelProviderProfile, PrConnection } from "@cognelis/decision-protocol";
import { acceptVerdicts, recognitionBatches, type RecognitionComment } from "../src/main/pr-comment-recognition.js";
import { PR_COMMENT_RECOGNITION_DAILY_CALLS, PrCommentCandidates, PrCommentVerdicts, skipsAuthor } from "../src/main/pr-comment-candidates.js";
import { PrPlatformError } from "../src/main/pr-platform-client.js";
import { ProfiledModelGatewayError } from "../src/main/model/profiled-model-gateway.js";
import { prCommentCandidatesSchema } from "@cognelis/decision-protocol";
import { mkdir, writeFile, readdir } from "node:fs/promises";

const at = (minute: number) => new Date(Date.UTC(2026, 9, 20, 2, minute)).toISOString();
const comment = (id: string, minute: number, body: string, extra: Partial<RecognitionComment> = {}): RecognitionComment =>
  ({ id, author: "Alice", body, createdAt: at(minute), replyTo: null, path: "src/a.ts", line: 3, ...extra });
const pr = { title: "示例", reference: "PROJ/repo#12" };

describe("recognition batches", () => {
  it("judges a reply with the comment it answers, read as context only", () => {
    const asked = comment("1", 0, "[P1] 这里会重复写入", { author: "ci-bot" });
    const answer = comment("2", 5, "现有数据不会重复，先不处理", { replyTo: "1" });
    const [batch, ...rest] = recognitionBatches(pr, [answer, asked], new Set(["2"]), "codex-cli");
    expect(rest).toEqual([]);
    expect(batch!.subjects).toEqual(["2"]);
    expect(batch!.prompt).toContain("【讨论串 · src/a.ts:3】\n#1 ci-bot（上下文）：[P1] 这里会重复写入\n#2 Alice（待判断）：现有数据不会重复，先不处理");
  });

  it("puts the newest threads first, in calls a local model can hold", () => {
    const comments = Array.from({ length: 6 }, (_, index) => comment(String(index + 1), index, `第 ${index + 1} 条`, { path: null, line: null }));
    const local = recognitionBatches(pr, comments, new Set(comments.map((item) => item.id)), "qwen");
    expect(local.map((batch) => batch.subjects)).toEqual([["6", "5", "4", "3"], ["2", "1"]]);
    expect(recognitionBatches(pr, comments, new Set(comments.map((item) => item.id)), "claude-code-cli")).toHaveLength(1);
  });

  it("splits a thread too big for one call, each part opening with the thread's first comment", () => {
    const opener = comment("1", 0, "开头");
    const replies = Array.from({ length: 20 }, (_, index) => comment(String(index + 2), index + 1, `回复 ${index}`, { replyTo: "1" }));
    const batches = recognitionBatches(pr, [...replies].reverse().concat(opener), new Set(replies.map((item) => item.id)), "openai");
    // The newest part first, as threads go; within each part, oldest first, as the prompt says.
    expect(batches.map((batch) => batch.subjects)).toEqual([["17", "18", "19", "20", "21"], Array.from({ length: 15 }, (_, index) => String(index + 2))]);
    for (const batch of batches) expect(batch.prompt).toContain("#1 Alice（上下文）：开头");
    expect(batches[0]!.prompt).toContain("（这个讨论串另有 15 条未列出）");
  });
});

it("keeps a decision only with its own words, and an id from this call once", () => {
  const bodies = new Map([["1", "现有数据没有这种情况，\n先删掉"], ["2", "已改"]]);
  const { verdicts, refused } = acceptVerdicts({ verdicts: [
    { id: "#1", decision: true, question: "旧规则要不要兼容？", choice: "不兼容，直接删掉", quote: "现有数据没有这种情况， 先删掉" },
    { id: "1", decision: false, question: "", choice: "", quote: "" },
    { id: "2", decision: true, question: "要不要改？", choice: "改", quote: "先删掉" },
    { id: "9", decision: false, question: "", choice: "", quote: "" },
  ] }, ["1", "2"], bodies);
  expect(verdicts).toEqual([{ id: "1", decision: true, question: "旧规则要不要兼容？", choice: "不兼容，直接删掉", quote: "现有数据没有这种情况， 先删掉" }]);
  expect(refused).toBe(3);
});

it("skips an author by the whole name or its first word", () => {
  expect([skipsAuthor("ci bot", ["ci"]), skipsAuthor("Bob.Li-李波", ["bob.li"]), skipsAuthor("Alice", ["ali"])]).toEqual([true, true, false]);
});

describe("comment candidates", () => {
  const profile = { profileId: "remote", kind: "openai-compatible" } as ModelProviderProfile;
  const link = (recognition?: PrConnection["recognition"]): PrConnection =>
    ({ id: "00000000-0000-4000-8000-000000000001", label: "公司", platform: "bitbucket-server", baseUrl: "https://code.example.com", ...(recognition ? { recognition } : {}) });
  const url = (id: string) => `https://code.example.com/projects/PROJ/repos/repo/pull-requests/12/overview?commentId=${id}`;
  const entry = (id: string, minute: number, body: string, extra: Partial<RecognitionComment> = {}) =>
    ({ ...comment(id, minute, body, extra), url: url(id), side: null, code: null });
  const setup = async (options: { connection?: PrConnection; answer?: (prompt: string) => unknown; recorded?: (url: string) => string | null } = {}) => {
    const directory = await mkdtemp(join(tmpdir(), "pr-comments-"));
    let now = new Date(2026, 9, 20, 10);
    const verdicts = new PrCommentVerdicts(join(directory, "verdicts.json"), () => now);
    const comments = [
      entry("1", 0, "[P1] 这里会重复写入", { author: "ci bot" }),
      entry("2", 5, "现有数据不会重复，先不处理", { replyTo: "1" }),
      entry("3", 6, "已改"),
      entry("4", 7, "记过了", { path: null, line: null }),
    ];
    const generate = vi.fn(async (request: { userPrompt: string }, parse: (value: unknown) => unknown) => ({
      parsedOutput: parse(options.answer?.(request.userPrompt) ?? { verdicts: [
        { id: "2", decision: true, question: "重复写入要不要处理？", choice: "先不处理，现有数据不会重复", quote: "先不处理" },
        { id: "3", decision: false, question: "", choice: "", quote: "" },
      ] }), usage: { source: "provider" }, model: "m",
    }));
    const candidates = new PrCommentCandidates({
      verdicts,
      connections: { list: async () => [options.connection ?? link({ profileId: "remote", skipAuthors: ["ci"] })], discussion: async () => ({ comments, more: false }),
        recentComments: async () => ({ comments, more: false }), pullRequests: async () => ({ items: [], nextPage: null }) },
      gateway: { generate: generate as never, listGenerationProfiles: async () => [profile] },
      recorded: options.recorded ?? ((link) => link === url("4") ? "decision-1" : null),
    });
    return { candidates, generate, verdicts, directory, setNow: (date: Date) => { now = date; } };
  };
  const load = { connectionId: "00000000-0000-4000-8000-000000000001", reference: "PROJ/repo#12" };

  it("reads with the link's model, offers what it read as a decision, and never the recorded or skipped", async () => {
    const { candidates, generate, directory } = await setup();
    expect((await candidates.discussion(load)).recognition).toEqual({ pending: 2, callsLeft: PR_COMMENT_RECOGNITION_DAILY_CALLS, stopped: null });
    const after = await candidates.recognize({ ...load, title: "示例" });
    expect(generate).toHaveBeenCalledTimes(1);
    const [request, , , profileId] = generate.mock.calls[0] as unknown as [{ purpose: string; userPrompt: string }, unknown, unknown, string];
    expect([request.purpose, profileId]).toEqual(["pr-comment-recognition", "remote"]);
    expect(request.userPrompt).toContain("#1 ci bot（上下文）");
    expect(request.userPrompt).not.toContain("#4 ");
    expect(after.comments.map((item) => [item.id, item.decisionId, item.candidate?.choice ?? null])).toEqual([
      ["1", null, null], ["2", null, "先不处理，现有数据不会重复"], ["3", null, null], ["4", "decision-1", null],
    ]);
    expect(after.recognition).toEqual({ pending: 0, callsLeft: PR_COMMENT_RECOGNITION_DAILY_CALLS - 1, stopped: null });
    expect((await stat(join(directory, "verdicts.json"))).mode & 0o777).toBe(0o600);
  });

  it("keeps the PR comment readable after its recorded decision disappears and no longer offers a dead decision link", async () => {
    let recorded: string | null = "decision-1";
    const { candidates, generate } = await setup({ recorded: (link) => link === url("4") ? recorded : null });
    expect((await candidates.discussion(load)).comments.find(item => item.id === "4")?.decisionId).toBe("decision-1");
    recorded = null;
    const after = await candidates.discussion(load);
    expect(after.comments.find(item => item.id === "4")).toMatchObject({ body: "记过了", decisionId: null });
    expect(after.recognition?.pending).toBe(3);
    expect(generate).not.toHaveBeenCalled();
  });

  it("forgets a candidate the reader turned down, and judges an edited comment again", async () => {
    const { candidates, verdicts } = await setup();
    await candidates.recognize({ ...load, title: "示例" });
    await candidates.dismiss(url("2"));
    expect((await candidates.discussion(load)).comments.find((item) => item.id === "2")!.candidate).toBeNull();
    const marks = await verdicts.read();
    expect(marks.verdict(prCommentSemanticKey(url("3")), "已改")).not.toBeNull();
    expect(marks.verdict(prCommentSemanticKey(url("3")), "已改，补了测试")).toBeNull();
  });

  it("stops at the day's calls and says so, then starts again the next day", async () => {
    const { candidates, verdicts, setNow } = await setup();
    for (let index = 0; index < PR_COMMENT_RECOGNITION_DAILY_CALLS; index += 1) expect(await verdicts.spend(load.connectionId)).toBe(true);
    const spent = await candidates.recognize({ ...load, title: "示例" });
    expect(spent.recognition).toEqual({ pending: 2, callsLeft: 0, stopped: `今天这个链接的 ${PR_COMMENT_RECOGNITION_DAILY_CALLS} 次识别已用完，明天可以继续。` });
    setNow(new Date(2026, 9, 21, 9));
    expect((await candidates.discussion(load)).recognition?.callsLeft).toBe(PR_COMMENT_RECOGNITION_DAILY_CALLS);
  });

  it("says why a reading stopped, and keeps nothing it did not judge", async () => {
    const { candidates } = await setup({ answer: () => { throw new Error("网络断了"); } });
    const result = await candidates.recognize({ ...load, title: "示例" });
    expect(result.recognition).toMatchObject({ pending: 2, stopped: "识别没有完成：网络断了" });
    expect(result.comments.every((item) => item.candidate === null)).toBe(true);
  });

  it("does not read without a model the link chose, nor offer to", async () => {
    const off = await setup({ connection: link() });
    expect((await off.candidates.discussion(load)).recognition).toBeNull();
    await expect(off.candidates.recognize({ ...load, title: "示例" })).rejects.toThrow("没有开启评论识别");
    const gone = await setup({ connection: link({ profileId: "removed", skipAuthors: [] }) });
    await expect(gone.candidates.recognize({ ...load, title: "示例" })).rejects.toThrow("已停用或已删除");
    expect(off.generate).not.toHaveBeenCalled();
  });

  it("keeps verdicts and the day's calls across a restart", async () => {
    const { candidates, directory } = await setup();
    await candidates.recognize({ ...load, title: "示例" });
    const saved = JSON.parse(await readFile(join(directory, "verdicts.json"), "utf8")) as { verdicts: Record<string, { decision: boolean }> };
    expect(Object.values(saved.verdicts).map((item) => item.decision).sort()).toEqual([false, true]);
    const reopened = new PrCommentVerdicts(join(directory, "verdicts.json"), () => new Date(2026, 9, 20, 11));
    expect((await reopened.read()).callsLeft(load.connectionId)).toBe(PR_COMMENT_RECOGNITION_DAILY_CALLS - 1);
  });

  it("drops what it read on a comment gone from the PR once the whole discussion is in hand", async () => {
    const { candidates, verdicts } = await setup();
    await candidates.recognize({ ...load, title: "示例" });
    expect((await candidates.candidates()).prs).toHaveLength(1);
    const gone = new PrCommentCandidates({
      verdicts,
      connections: { list: async () => [link({ profileId: "remote", skipAuthors: [] })], discussion: async () => ({ comments: [entry("3", 6, "已改")], more: false }),
        recentComments: async () => ({ comments: [], more: false }), pullRequests: async () => ({ items: [], nextPage: null }) },
      gateway: { generate: vi.fn() as never, listGenerationProfiles: async () => [profile] },
      recorded: () => null,
    });
    await gone.discussion(load);
    expect((await gone.candidates()).prs).toEqual([]);
  });

  it("does not take a verdict file it cannot read for an empty one, and sets a garbled one aside", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pr-verdicts-"));
    // A directory where the file should be: unreadable, and not to be written over.
    await mkdir(join(directory, "busy.json"));
    await expect(new PrCommentVerdicts(join(directory, "busy.json")).read()).rejects.toThrow();
    await writeFile(join(directory, "garbled.json"), "{not json");
    const garbled = new PrCommentVerdicts(join(directory, "garbled.json"));
    expect((await garbled.read()).callsLeft("link")).toBe(PR_COMMENT_RECOGNITION_DAILY_CALLS);
    expect((await readdir(directory)).some((name) => name.startsWith("garbled.json.corrupt-"))).toBe(true);
  });

  describe("following a link's open PRs", () => {
    const listed = (reference: string, updatedAt: string, comments?: number) =>
      ({ reference, title: `标题 ${reference}`, repository: "PROJ/repo", number: reference.split("#")[1]!, author: "Bob", updatedAt, ...(comments === undefined ? {} : { comments }) });
    const follower = async (options: { lists?: Array<ReturnType<typeof listed>[] | Error>; comments?: Record<string, Array<ReturnType<typeof entry>>> } = {}) => {
      const directory = await mkdtemp(join(tmpdir(), "pr-follow-"));
      let now = new Date(2026, 9, 20, 10);
      const verdicts = new PrCommentVerdicts(join(directory, "verdicts.json"), () => now);
      const lists = [...(options.lists ?? [[listed("PROJ/repo#12", "2026-10-20T01:00:00Z", 3)]])];
      const reads: string[] = [];
      const generate = vi.fn(async (request: { userPrompt: string }, parse: (value: unknown) => unknown) => ({
        parsedOutput: parse({ verdicts: [...request.userPrompt.matchAll(/#(\d+) [^（\n]+（待判断）/gu)].map(([, id]) =>
          ({ id, decision: id === "2", question: id === "2" ? "要不要处理？" : "", choice: id === "2" ? "先不处理" : "", quote: id === "2" ? "先不处理" : "" })) }),
        usage: { source: "provider" }, model: "m",
      }));
      const candidates = new PrCommentCandidates({
        verdicts,
        connections: {
          list: async () => [link({ profileId: "remote", skipAuthors: [] })],
          discussion: async () => ({ comments: [], more: false }),
          // The same list answers both "I review" and "I wrote"; one list per look.
          pullRequests: async (query) => {
            const next = lists[0];
            if (next instanceof Error) { lists.shift(); throw next; }
            if (query.filter === "created" && lists.length > 1) lists.shift();
            return { items: query.filter === "created" ? [] : next ?? [], nextPage: null };
          },
          recentComments: async (request) => { reads.push(request.reference); return { comments: options.comments?.[request.reference] ?? [entry("2", 5, "现有数据不会重复，先不处理")], more: false }; },
        },
        gateway: { generate: generate as never, listGenerationProfiles: async () => [profile] },
        recorded: () => null,
        now: () => now.getTime(),
      });
      return { candidates, generate, reads, verdicts, setNow: (date: Date) => { now = date; } };
    };

    it("reads only PRs whose comments moved, and a PR that left the list once more", async () => {
      const { candidates, reads } = await follower({ lists: [
        [listed("PROJ/repo#12", "2026-10-20T01:00:00Z", 3)],
        // Bitbucket's update time stays put for a new comment: the count says it moved.
        [listed("PROJ/repo#12", "2026-10-20T01:00:00Z", 3)],
        [listed("PROJ/repo#12", "2026-10-20T01:00:00Z", 4)],
        [],
      ] });
      expect(await candidates.follow()).toBe(true);
      expect(await candidates.follow()).toBe(false);
      await candidates.follow();
      await candidates.follow();
      expect(reads).toEqual(["PROJ/repo#12", "PROJ/repo#12", "PROJ/repo#12"]);
      expect((await candidates.candidates()).prs).toEqual([{ connectionId: load.connectionId, reference: "PROJ/repo#12", title: "标题 PROJ/repo#12", count: 1, latest: expect.any(String) }]);
    });

    it("looks a week back the first time, so turning it on reads no history", async () => {
      const { candidates, generate } = await follower({ comments: { "PROJ/repo#12": [
        { ...entry("2", 5, "现有数据不会重复，先不处理"), createdAt: new Date(2026, 9, 18).toISOString() },
        { ...entry("3", 6, "按老规矩办"), createdAt: new Date(2026, 8, 1).toISOString() },
      ] } });
      await candidates.follow();
      expect(generate).toHaveBeenCalledTimes(1);
      const prompt = (generate.mock.calls[0] as unknown as [{ userPrompt: string }])[0].userPrompt;
      expect(prompt).toContain("需要判断的有 1 条：#2。");
    });

    it("stops asking a platform that refused it until the link is saved again", async () => {
      const { candidates, reads } = await follower({ lists: [new PrPlatformError(403), [listed("PROJ/repo#12", "2026-10-20T01:00:00Z", 3)]] });
      await candidates.follow();
      await candidates.follow();
      expect(reads).toEqual([]);
      expect((await candidates.candidates()).links).toEqual([{ connectionId: load.connectionId, checkedAt: expect.any(String), error: expect.stringContaining("HTTP 403") }]);
      // Saved again with nothing about its reading changed: asked again, carrying on from what it saw.
      await candidates.linkSaved(link({ profileId: "remote", skipAuthors: [] }), link({ profileId: "remote", skipAuthors: [] }), false);
      await candidates.follow();
      expect(reads).toEqual(["PROJ/repo#12"]);
    });

    it("stops at the first failure of the model and waits before trying it again", async () => {
      const failing = await follower({ lists: [[listed("PROJ/repo#12", "a", 1), listed("PROJ/repo#13", "a", 1)]] });
      failing.generate.mockRejectedValue(new ProfiledModelGatewayError("Claude CLI logged out", "authentication_failed"));
      await failing.candidates.follow();
      // One call spent, not one per PR: the others would only fail the same way.
      expect(failing.generate).toHaveBeenCalledTimes(1);
      expect((await failing.candidates.candidates()).links[0]!.error).not.toContain("已用完");
      await failing.candidates.follow();
      expect(failing.generate).toHaveBeenCalledTimes(1);
      failing.setNow(new Date(2026, 9, 20, 12, 1));
      await failing.candidates.follow();
      expect(failing.generate).toHaveBeenCalledTimes(2);
    });

    it("keeps what stopped a look short enough for the page to show", async () => {
      const { candidates } = await follower({ lists: [new Error("x".repeat(2_000))] });
      await candidates.follow();
      const list = await candidates.candidates();
      expect(() => prCommentCandidatesSchema.parse(list)).not.toThrow();
      expect(list.links[0]!.error!.length).toBeLessThanOrEqual(500);
    });

    it("starts over a week back when its reading is turned on again", async () => {
      const { candidates, verdicts, setNow } = await follower();
      await candidates.follow();
      setNow(new Date(2026, 11, 1, 10));
      await candidates.linkSaved(link(), link({ profileId: "remote", skipAuthors: [] }), false);
      expect((await verdicts.following(load.connectionId)).since).toBe(new Date(2026, 10, 24, 10).toISOString());
    });

    it("leaves a PR to read again when the day's calls run out on it", async () => {
      const { candidates, verdicts, reads, setNow } = await follower();
      for (let index = 0; index < PR_COMMENT_RECOGNITION_DAILY_CALLS; index += 1) await verdicts.spend(load.connectionId);
      await candidates.follow();
      expect((await candidates.candidates()).links[0]!.error).toContain("已用完");
      setNow(new Date(2026, 9, 21, 9));
      await candidates.follow();
      expect(reads).toEqual(["PROJ/repo#12", "PROJ/repo#12"]);
      expect((await candidates.candidates()).prs).toHaveLength(1);
    });
  });
});
