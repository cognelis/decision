import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { prCommentSemanticKey } from "@cognelis/decision-core";
import { prCommentCandidatesSchema, prDiscussionSchema, type ModelProviderProfile, type PrConnection } from "@cognelis/decision-protocol";
import { PrCommentCandidates, PrCommentVerdicts } from "../src/main/pr-comment-candidates.js";
import { ProfiledModelGatewayError } from "../src/main/model/profiled-model-gateway.js";

const connectionId = "00000000-0000-4000-8000-000000000001";
const link: PrConnection = { id: connectionId, label: "公司", platform: "bitbucket-server", baseUrl: "https://code.example.com", recognition: { profileId: "remote", skipAuthors: [] } };
const profile = { profileId: "remote", kind: "openai-compatible" } as ModelProviderProfile;
const url = (reference: string, id: string) => `https://code.example.com/projects/PROJ/repos/repo/pull-requests/${reference.split("#")[1]}/overview?commentId=${id}`;
const comment = (reference: string, id: string, body: string, path: string) => ({
  id, author: "Alice", body, createdAt: new Date(2026, 9, 20, 9).toISOString(), replyTo: null, path, line: 3, side: null, code: null, url: url(reference, id) });
const listed = (reference: string) =>
  ({ reference, title: `标题 ${reference}`, repository: "PROJ/repo", number: reference.split("#")[1]!, author: "Bob", updatedAt: "2026-10-20T01:00:00Z", comments: 2 });
/** The words the provider's moderation refuses: a batch holding them is refused whole, which comment it does not say. */
const FLAGGED = "这段要整个重写";

/**
 * PR #12: in one batch, a thread the moderation refuses and another thread with a real decision. PR #13: a decision.
 * The model reads #22 and #31 as decisions whenever a call holding them gets through.
 */
const setup = async () => {
  const directory = await mkdtemp(join(tmpdir(), "pr-comments-refused-"));
  let now = new Date(2026, 9, 20, 10);
  const comments: Record<string, Array<ReturnType<typeof comment>>> = {
    "PROJ/repo#12": [comment("PROJ/repo#12", "21", FLAGGED, "src/a.ts"), comment("PROJ/repo#12", "22", "先不处理，现有数据不会重复", "src/b.ts")],
    "PROJ/repo#13": [comment("PROJ/repo#13", "31", "先不处理", "src/c.ts")],
  };
  const reads: string[] = [];
  // The PRs the lists offer: open ones, and merged ones (whose discussion can still be recorded from).
  const open = new Set(["PROJ/repo#12", "PROJ/repo#13"]), merged = new Set<string>();
  let mergedAsked = 0;
  const generate = vi.fn(async (request: { userPrompt: string }, parse: (value: unknown) => unknown) => {
    if (request.userPrompt.includes(FLAGGED)) throw new ProfiledModelGatewayError("The structured model fallback chain failed or was stopped", "content_refused");
    return { parsedOutput: parse({ verdicts: [...request.userPrompt.matchAll(/#(\d+) [^（\n]+（待判断）/gu)].map(([, id]) =>
      ({ id, decision: true, question: "要不要处理？", choice: "先不处理", quote: "先不处理" })) }), usage: { source: "unavailable" }, model: "m" };
  });
  const verdicts = new PrCommentVerdicts(join(directory, "verdicts.json"), () => now);
  const candidates = new PrCommentCandidates({
    verdicts,
    connections: {
      list: async () => [link],
      discussion: async (request) => ({ comments: comments[request.reference] ?? [], more: false }),
      recentComments: async (request) => { reads.push(request.reference); return { comments: comments[request.reference] ?? [], more: false }; },
      pullRequests: async (query) => {
        if (query.state === "merged") mergedAsked += 1;
        return { items: query.filter === "review-requested" ? [...(query.state === "merged" ? merged : open)].map(listed) : [], nextPage: null };
      },
    },
    gateway: { generate: generate as never, listGenerationProfiles: async () => [profile] },
    recorded: () => null,
    now: () => now.getTime(),
  });
  /** How many calls carried these words. */
  const sent = (words: string) => generate.mock.calls.filter(([request]) => (request as { userPrompt: string }).userPrompt.includes(words)).length;
  const reword = (reference: string, id: string, body: string) => { comments[reference] = comments[reference]!.map((item) => item.id === id ? { ...item, body } : item); };
  return { candidates, verdicts, reads, sent, reword, open, merged, mergedAsked: () => mergedAsked, later: () => { now = new Date(now.getTime() + 3 * 3_600_000); } };
};
const pr12 = { connectionId, reference: "PROJ/repo#12" };

// Set down as "not a decision", the whole refused batch went: a real decision in another thread of it never reached the
// candidates, nothing said it was not read, and the one line that did was gone at the next look.
it("keeps a batch the provider's moderation refused apart from what was read, says how many, and sends the same words no more", async () => {
  const { candidates, verdicts, reads, sent, later } = await setup();

  await candidates.follow();

  expect(reads).toEqual(["PROJ/repo#12", "PROJ/repo#13"]);
  expect((await verdicts.following(connectionId)).retryAt).toBeNull();
  expect((await verdicts.read()).verdict(prCommentSemanticKey(url("PROJ/repo#12", "22")), "先不处理，现有数据不会重复")).toBeNull();
  const discussion = await candidates.discussion(pr12);
  expect(discussion.comments.map((item) => [item.id, item.refused ?? false])).toEqual([["21", true], ["22", true]]);
  expect(discussion.recognition).toMatchObject({ pending: 0 });
  // As the process boundary takes them, to the page.
  expect(() => prDiscussionSchema.parse(discussion)).not.toThrow();
  for (let look = 0; look < 2; look += 1) {
    later();
    await candidates.follow();
    const look = await candidates.candidates();
    expect(look.links[0]!.error).toBe("有 2 条评论因审核拒绝未能识别，可以手动查看并记录：PROJ/repo#12");
    expect(() => prCommentCandidatesSchema.parse(look)).not.toThrow();
  }
  expect(sent(FLAGGED)).toBe(1);
});

it("reads a refused comment again once reworded, and lets the reader settle one by hand", async () => {
  const { candidates, sent, reword } = await setup();
  const request = { ...pr12, title: "示例" };

  const first = await candidates.recognize(request);
  expect(first.comments.map((item) => item.refused ?? false)).toEqual([true, true]);
  expect(first.recognition).toMatchObject({ pending: 0, stopped: null });
  await candidates.recognize(request);
  expect(sent(FLAGGED)).toBe(1);

  reword("PROJ/repo#12", "22", "先不处理，现有数据不会重复，下个版本再看");
  await candidates.discussion(pr12);
  const again = await candidates.recognize(request);
  expect(sent("下个版本再看")).toBe(1);
  expect(sent(FLAGGED)).toBe(1);
  expect(again.comments.map((item) => [item.id, item.refused ?? false, item.candidate?.choice ?? null])).toEqual([["21", true, null], ["22", false, "先不处理"]]);

  await candidates.dismiss(url("PROJ/repo#12", "21"));
  expect((await candidates.discussion(pr12)).comments[0]!.refused).toBeUndefined();
  expect((await candidates.candidates()).links[0]!.error).toBeNull();
});

// Named on the link for as long as they were there, a declined PR's refused comments could be looked at from nowhere:
// the PR lists offer open and merged PRs only.
it("lets go of a declined PR's refused comments at the next look, and keeps a merged one's, asked about once", async () => {
  const declined = await setup();
  // Read through on the second look, the PR is one the link follows: gone from the list, it is read once more.
  await declined.candidates.follow();
  await declined.candidates.follow();
  declined.open.delete("PROJ/repo#12");
  await declined.candidates.follow();
  expect((await declined.candidates.candidates()).links[0]!.error).toBeNull();
  // Not sent again on that last read, before its refused comments were let go.
  expect(declined.sent(FLAGGED)).toBe(1);

  const merged = await setup();
  await merged.candidates.follow();
  merged.open.delete("PROJ/repo#12");
  merged.merged.add("PROJ/repo#12");
  await merged.candidates.follow();
  await merged.candidates.follow();
  expect((await merged.candidates.candidates()).links[0]!.error).toBe("有 2 条评论因审核拒绝未能识别，可以手动查看并记录：PROJ/repo#12");
  // Each of the two merged lists, on the look the PR left the open one; not again at every look after.
  expect(merged.mergedAsked()).toBe(2);
});

it("forgets a link's refused comments with the rest of what it saw, when it starts over or is removed", async () => {
  for (const reset of [(candidates: PrCommentCandidates) => candidates.linkRemoved(connectionId), (candidates: PrCommentCandidates) => candidates.linkSaved(link, link, true)]) {
    const { candidates } = await setup();
    await candidates.follow();
    await reset(candidates);
    expect((await candidates.candidates()).links[0]!.error).toBeNull();
  }
});
