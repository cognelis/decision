import type { ModelInvocationTrace, ModelProviderProfile, StructuredGenerationRequest } from "@cognelis/decision-protocol";
import type { ModelTraceRecordInput } from "@cognelis/decision-storage";
import { describe, expect, it, vi } from "vitest";

import { abortFailure } from "../src/main/model/provider-deadline.js";
import { ProfiledModelGateway, ProfiledModelGatewayError, type ProfiledStructuredGenerationResult } from "../src/main/model/profiled-model-gateway.js";
import { summarizeRecordContext } from "../src/main/record-context-summary.js";
import type { SemanticClassifier } from "../src/main/semantic/semantic-classifier.js";

const profile = (profileId: string, kind: ModelProviderProfile["kind"], priority: number): ModelProviderProfile => ({
  version: 1, profileId, kind, label: profileId, enabled: true, priority, timeoutMs: 5_000,
  ...(kind === "qwen" ? { model: "qwen3.5-2b-q4-k-m" } : kind === "apple" ? { model: "system-language-model" }
    : kind === "openai" ? { model: "gpt-5-mini", baseUrl: "https://api.openai.com", apiProtocol: "responses" as const, credentialRef: `${profileId}-key` } : {}),
});

const answer = { change: "src/request.ts:12 给请求加了 5000 ms 的超时。", views: ["超时不该写死", "超时不该写死", "计时器要清理"], decided: "超时由调用方传入。" };

/** A gateway whose model answers `output`, through the parser the summary hands it, as the real one does. */
const fakeGateway = (profiles: ModelProviderProfile[], output: unknown = answer) => {
  const generate = vi.fn(async (request: StructuredGenerationRequest, parse: (value: unknown) => unknown, _signal?: AbortSignal): Promise<ProfiledStructuredGenerationResult<unknown>> => ({
    requestId: request.requestId, attemptId: "attempt", profileId: "qwen", backend: "qwen", provider: "Qwen", model: "qwen3.5-2b-q4-k-m",
    visibleOutput: JSON.stringify(output), parsedOutput: parse(output), usage: { source: "runtime_measured" }, providerDurationMs: 1_500,
  }));
  const gateway: Pick<ProfiledModelGateway, "generate" | "listGenerationProfiles"> = {
    listGenerationProfiles: async () => profiles,
    generate: generate as unknown as ProfiledModelGateway["generate"],
  };
  return { gateway, generate };
};

const request = {
  requestId: "6f4a1f5e-8a7b-4c2d-9e10-1a2b3c4d5e6f",
  title: "请求超时由谁决定？",
  choice: "超时改为调用方传入。",
  context: "PR：调整请求超时（sample/app#123）\n位置：src/request.ts:12\n讨论串：\nBob：超时写死不好。",
};

describe("summarizeRecordContext", () => {
  it("says what to turn on when nothing on this machine can write a summary, and calls no model", async () => {
    const remoteOnly = fakeGateway([profile("remote", "openai", 0)]);
    await expect(summarizeRecordContext(remoteOnly.gateway, request)).resolves.toEqual({
      status: "unavailable",
      reason: "没有启用本机模型。请先在“模型”中启用 Qwen 本机模型；总结只在本机进行，不会发给远端 API 或命令行工具。",
    });
    // Apple's model only classifies: named, the reader knows why it is not enough.
    const appleOnly = fakeGateway([profile("apple", "apple", 0), profile("remote", "openai", 1)]);
    await expect(summarizeRecordContext(appleOnly.gateway, request)).resolves.toMatchObject({ status: "unavailable", reason: expect.stringMatching(/^Apple 本机模型只做分类，不能写总结。请先在“模型”中启用 Qwen 本机模型/u) });
    expect(remoteOnly.generate).not.toHaveBeenCalled();
    expect(appleOnly.generate).not.toHaveBeenCalled();
  });

  it("asks for a context summary with the record's title and choice, and puts its three parts together, each view once", async () => {
    const { gateway, generate } = fakeGateway([profile("qwen", "qwen", 0)]);
    await expect(summarizeRecordContext(gateway, request)).resolves.toEqual({
      status: "summarized",
      // Each label a line of its own, which searching leaves out once the summary is in a record.
      summary: "在做什么：\nsrc/request.ts:12 给请求加了 5000 ms 的超时。\n各方观点：\n- 超时不该写死\n- 计时器要清理\n定了什么：\n超时由调用方传入。",
      model: "qwen3.5-2b-q4-k-m",
      clipped: false,
    });
    const sent = generate.mock.calls[0]![0];
    expect(sent).toMatchObject({ purpose: "context-summary", requestId: `context-summary:${request.requestId}`, promptVersion: "context-summary-v1", locale: "zh-CN" });
    expect(sent.userPrompt).toBe(`记录标题：请求超时由谁决定？\n最终选择：超时改为调用方传入。\n当时上下文：\n${request.context}`);
    expect(sent.systemPrompt).toMatch(/只写记录标题、最终选择和上下文里写明的内容，不推测、不补充、不评价/u);
    expect(sent.systemPrompt).toMatch(/文件名、路径、行号、函数名、变量名和编号照原文抄写/u);
  });

  it("refuses an answer missing a part, as the call log's invalid output", async () => {
    const { gateway } = fakeGateway([profile("qwen", "qwen", 0)], { change: "", views: [], decided: "" });
    await expect(summarizeRecordContext(gateway, request)).rejects.toThrow(/^总结没有完成：/u);
  });

  it("gives the model the start and the end of a long context with the middle marked as left out, and says so", async () => {
    const { gateway, generate } = fakeGateway([profile("qwen", "qwen", 0)]);
    const context = `开头：PR 与位置\n${"中间的代码行\n".repeat(700)}结尾：最后一条回复`;
    await expect(summarizeRecordContext(gateway, { ...request, context })).resolves.toMatchObject({ status: "summarized", clipped: true });
    const prompt = generate.mock.calls[0]![0].userPrompt;
    expect(prompt).toContain("开头：PR 与位置");
    expect(prompt).toContain("结尾：最后一条回复");
    expect(prompt).toMatch(/……（中间省略 \d+ 字）……/u);
    // What fits Qwen's window with the instructions and the answer: the window would otherwise drop part of it silently.
    expect(prompt.length).toBeLessThan(2_300);
  });

  it("keeps the longest prompt within 85% of Qwen's window, the answer included, at the densest Chinese measured", async () => {
    const { gateway, generate } = fakeGateway([profile("qwen", "qwen", 0)]);
    // Every part at its limit, in full-width punctuation and Han: Qwen's tokenizer counts 0.82 tokens a character there.
    await summarizeRecordContext(gateway, { ...request, title: "题".repeat(500), choice: "选，".repeat(4_000), context: "「上下文」，（讨论）；".repeat(800) });
    const sent = generate.mock.calls[0]![0];
    // Measured: the instructions 0.62 tokens a character; the chat template's own tokens; the answer at its budget.
    const tokens = sent.systemPrompt.length * 0.62 + sent.userPrompt.length * 0.82 + 32 + sent.maxOutputTokens;
    // Past the window the runtime drops part of the prompt without a word; the margin is for rarer characters.
    expect(tokens).toBeLessThanOrEqual(4_096 * 0.85);
  });

  it("says an enabled local model that is not ready is unavailable, and other failures in words", async () => {
    const failing = (code: ConstructorParameters<typeof ProfiledModelGatewayError>[1]) => {
      const { gateway, generate } = fakeGateway([profile("qwen", "qwen", 0)]);
      generate.mockRejectedValueOnce(new ProfiledModelGatewayError("The structured model fallback chain failed or was stopped", code));
      return summarizeRecordContext(gateway, request);
    };
    await expect(failing("provider_unavailable")).resolves.toEqual({ status: "unavailable", reason: "Qwen 本机模型暂时不可用（模型可能还没下载，或校验没有通过），请在“模型”中检查。" });
    await expect(failing("timeout")).rejects.toThrow("本机模型没有在限定时间内写完总结（可能正忙于其它调用，或上下文较长），可以稍后重试。");
    await expect(failing("invalid_output")).rejects.toThrow(/^总结没有完成：模型的回答不符合要求的格式/u);
  });

  it("stops when the reader cancels, and at its own deadline when the model never answers", async () => {
    const { gateway, generate } = fakeGateway([profile("qwen", "qwen", 0)]);
    // A model stuck loading, or waiting behind another call: only the signal ends it.
    generate.mockImplementation((_request, _parse, signal) => new Promise<never>((_resolve, reject) => {
      if (signal!.aborted) reject(abortFailure(signal));
      signal!.addEventListener("abort", () => reject(abortFailure(signal)), { once: true });
    }));
    const reader = new AbortController();
    const cancelled = summarizeRecordContext(gateway, request, reader.signal);
    reader.abort();
    await expect(cancelled).rejects.toThrow("总结已取消。");
    await expect(summarizeRecordContext(gateway, request, new AbortController().signal, 10)).rejects.toThrow(/^本机模型没有在限定时间内写完总结/u);
  });

  it("says Qwen is not ready when it comes before an enabled Apple and its model file is missing", async () => {
    const status = (id: ModelProviderProfile["kind"], availability: "available" | "model_missing") => vi.fn(async () => ({ id, availability, promptVersion: "semantic-v1" }));
    const gateway = new ProfiledModelGateway({
      profiles: { load: async () => [profile("qwen", "qwen", 0), profile("apple", "apple", 10)] },
      providerFactory: (chosen) => chosen.kind === "qwen"
        ? { id: "qwen", status: status("qwen", "model_missing"), invoke: vi.fn(), classify: vi.fn(), close: vi.fn(async () => undefined), generate: vi.fn() } as SemanticClassifier
        : { id: "apple", status: status("apple", "available"), invoke: vi.fn(), classify: vi.fn(), close: vi.fn(async () => undefined) },
      traces: { record: async (trace) => trace as ModelInvocationTrace },
      audit: { fingerprint: async () => "f".repeat(64), record: async () => undefined, summary: async () => ({ processed: 0, high: 0, medium: 0, failures: 0 }) as never },
    });
    await expect(summarizeRecordContext(gateway, request)).resolves.toEqual({ status: "unavailable", reason: "Qwen 本机模型暂时不可用（模型可能还没下载，或校验没有通过），请在“模型”中检查。" });
    await gateway.close();
  });

  it("goes only to the local model through the real gateway, filed in the call log as a context summary", async () => {
    const traces: ModelTraceRecordInput[] = [];
    const generated = vi.fn(async (sent: StructuredGenerationRequest) => ({
      parsedOutput: answer, visibleOutput: JSON.stringify(answer), modelVersion: "qwen3.5-2b-q4-k-m",
      traceInput: { systemPrompt: sent.systemPrompt, userPrompt: sent.userPrompt, outputSchema: sent.outputSchema, clientSystemPromptVisibility: "visible" as const },
      usage: { source: "runtime_measured" as const }, providerDurationMs: 1_500,
    }));
    const provider = (id: ModelProviderProfile["kind"]): SemanticClassifier & { generate: typeof generated } => ({
      id, invoke: vi.fn(), classify: vi.fn(), close: vi.fn(async () => undefined), generate: generated,
      status: vi.fn(async () => ({ id, availability: "available" as const, promptVersion: "semantic-v1" })),
    });
    const remote = provider("openai");
    const gateway = new ProfiledModelGateway({
      // The remote backend is first in line, as a reader who answers with it would have it.
      profiles: { load: async () => [profile("remote", "openai", 0), profile("qwen", "qwen", 10)] },
      providerFactory: (chosen) => chosen.kind === "openai" ? remote : provider("qwen"),
      traces: { record: async (trace) => { traces.push(trace); return trace as ModelInvocationTrace; } },
      audit: { fingerprint: async () => "f".repeat(64), record: async () => undefined, summary: async () => ({ processed: 0, high: 0, medium: 0, failures: 0 }) as never },
    });
    await expect(summarizeRecordContext(gateway, request)).resolves.toMatchObject({ status: "summarized" });
    expect(traces.map((trace) => [trace.purpose, trace.profile.backend, trace.status])).toEqual([["context-summary", "qwen", "succeeded"]]);
    expect(generated).toHaveBeenCalledOnce();
    await gateway.close();
  });
});
