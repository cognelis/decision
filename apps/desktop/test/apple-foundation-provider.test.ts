import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import {
  AppleFoundationModelProvider,
  type AppleFoundationHelperProcess,
} from "../src/main/semantic/apple-foundation-provider.js";

class FakeHelperProcess
  extends EventEmitter
  implements AppleFoundationHelperProcess
{
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly kill = vi.fn(() => true);

  constructor(
    onRequest?: (
      request: Record<string, unknown>,
      process: FakeHelperProcess,
    ) => void,
  ) {
    super();
    let buffered = "";
    this.stdin.setEncoding("utf8");
    this.stdin.on("data", (chunk: string) => {
      buffered += chunk;
      const lines = buffered.split("\n");
      buffered = lines.pop() ?? "";
      for (const line of lines) {
        if (line.length > 0) {
          onRequest?.(
            JSON.parse(line) as Record<string, unknown>,
            this,
          );
        }
      }
    });
  }

  respond(response: Record<string, unknown>): void {
    this.stdout.write(`${JSON.stringify(response)}\n`);
  }

  crash(): void {
    this.emit("exit", 1, null);
  }
}

const statusResponse = (
  id: unknown,
  status:
    | "available"
    | "device_not_eligible"
    | "apple_intelligence_disabled"
    | "assets_unavailable",
) => ({
  id,
  ok: true,
  status,
  modelVersion: "system-language-model",
});

describe("AppleFoundationModelProvider", () => {
  it("maps JSON-line responses to concurrent requests by request ID", async () => {
    const requests: Record<string, unknown>[] = [];
    const child = new FakeHelperProcess((request, process) => {
      requests.push(request);
      if (requests.length === 2) {
        process.respond(
          statusResponse(requests[1]?.id, "available"),
        );
        const classification = {
          decisionIntent: "decision",
          answerRelation: "answers",
          question: "先提交还是先修复？",
          optionLabels: ["先提交", "先修复"],
          answerExcerpt: "先修复",
          confidence: 0.94,
        };
        process.respond({
          id: requests[0]?.id,
          ok: true,
          visibleOutput: JSON.stringify(classification),
          classification,
        });
      }
    });
    const provider = new AppleFoundationModelProvider({
      helperPath: "/fake/helper",
      spawnHelper: () => child,
      timeoutMs: 100,
    });

    const attempt = provider.invoke({
      pairId: "pair-1",
      assistantText: "先提交还是先修复？",
      userText: "先修复",
      locale: "zh-CN",
    });
    const status = provider.status();

    await expect(status).resolves.toMatchObject({
      id: "apple",
      availability: "available",
      modelVersion: "system-language-model",
    });
    await expect(attempt).resolves.toMatchObject({
      classification: {
        decisionIntent: "decision",
        answerRelation: "answers",
        question: "先提交还是先修复？",
        optionLabels: ["先提交", "先修复"],
        answerExcerpt: "先修复",
        confidence: 0.94,
        provider: "apple",
        modelVersion: "system-language-model",
        promptVersion: "semantic-v1",
      },
      visibleOutput: expect.stringContaining(
        "\"decisionIntent\"",
      ),
      traceInput: {
        systemPrompt: expect.stringContaining(
          "Classify whether",
        ),
        userPrompt: expect.stringContaining(
          "<assistant_message>",
        ),
        outputSchema: expect.objectContaining({
          type: "object",
        }),
        clientSystemPromptVisibility: "visible",
      },
      usage: { source: "unavailable" },
      providerDurationMs: expect.any(Number),
    });
    expect(requests).toEqual([
      expect.objectContaining({
        operation: "classify",
        systemPrompt: expect.stringContaining(
          "Classify whether",
        ),
        userPrompt: expect.stringContaining(
          "<assistant_message>",
        ),
        locale: "zh-CN",
      }),
      expect.objectContaining({ operation: "status" }),
    ]);
  });

  it.each([
    ["available", "available"],
    ["device_not_eligible", "device_not_eligible"],
    [
      "apple_intelligence_disabled",
      "apple_intelligence_disabled",
    ],
    ["assets_unavailable", "assets_unavailable"],
  ] as const)(
    "reports helper status %s as %s",
    async (helperStatus, availability) => {
      const child = new FakeHelperProcess((request, process) => {
        process.respond(
          statusResponse(request.id, helperStatus),
        );
      });
      const provider = new AppleFoundationModelProvider({
        helperPath: "/fake/helper",
        spawnHelper: () => child,
      });

      await expect(provider.status()).resolves.toMatchObject({
        id: "apple",
        availability,
      });
    },
  );

  it("reports a missing helper without throwing", async () => {
    const provider = new AppleFoundationModelProvider({
      helperPath: "/missing/helper",
      spawnHelper: () => {
        const child = new FakeHelperProcess();
        queueMicrotask(() => {
          const error = Object.assign(new Error("spawn ENOENT"), {
            code: "ENOENT",
          });
          child.emit("error", error);
        });
        return child;
      },
      timeoutMs: 50,
    });

    await expect(provider.status()).resolves.toMatchObject({
      id: "apple",
      availability: "helper_missing",
    });
  });

  it("rejects malformed output safely and can use a fresh helper", async () => {
    const malformed = new FakeHelperProcess((_request, process) => {
      process.stdout.write("{not-json}\n");
    });
    const healthy = new FakeHelperProcess((request, process) => {
      process.respond(statusResponse(request.id, "available"));
    });
    const spawnHelper = vi
      .fn<() => AppleFoundationHelperProcess>()
      .mockReturnValueOnce(malformed)
      .mockReturnValueOnce(healthy);
    const provider = new AppleFoundationModelProvider({
      helperPath: "/fake/helper",
      spawnHelper,
      timeoutMs: 50,
    });

    await expect(
      provider.classify({
        pairId: "pair-1",
        assistantText: "请选择方案。",
        userText: "方案一",
        locale: "zh-CN",
      }),
    ).rejects.toMatchObject({
      code: "provider_invalid_output",
    });
    await expect(provider.status()).resolves.toMatchObject({
      availability: "available",
    });
    expect(spawnHelper).toHaveBeenCalledTimes(2);
  });

  it("rejects a visible output that is not the returned classification JSON", async () => {
    const child = new FakeHelperProcess((request, process) => {
      process.respond({
        id: request.id,
        ok: true,
        visibleOutput: "not-json",
        classification: {
          decisionIntent: "decision",
          answerRelation: "answers",
          question: "请选择方案。",
          optionLabels: ["方案一", "方案二"],
          answerExcerpt: "方案一",
          confidence: 0.9,
        },
      });
    });
    const provider = new AppleFoundationModelProvider({
      helperPath: "/fake/helper",
      spawnHelper: () => child,
    });

    await expect(
      provider.invoke({
        pairId: "pair-1",
        assistantText: "请选择方案。",
        userText: "方案一",
        locale: "zh-CN",
      }),
    ).rejects.toMatchObject({
      code: "provider_invalid_output",
    });
  });

  it("times out or cancels only the pending request and keeps the helper alive", async () => {
    let statusCount = 0;
    const child = new FakeHelperProcess((request, process) => {
      if (request.operation === "status") {
        statusCount += 1;
        if (statusCount > 1) {
          process.respond(statusResponse(request.id, "available"));
        }
      }
    });
    const provider = new AppleFoundationModelProvider({
      helperPath: "/fake/helper",
      spawnHelper: () => child,
      timeoutMs: 15,
    });

    await expect(provider.status()).resolves.toMatchObject({
      availability: "runtime_unavailable",
    });

    const abortController = new AbortController();
    const cancelled = provider.classify(
      {
        pairId: "pair-1",
        assistantText: "请选择方案。",
        userText: "方案一",
        locale: "zh-CN",
      },
      abortController.signal,
    );
    abortController.abort();
    await expect(cancelled).rejects.toMatchObject({
      name: "AbortError",
    });

    await expect(provider.status()).resolves.toMatchObject({
      availability: "available",
    });
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("opens a process-lifetime circuit after three consecutive crashes", async () => {
    const children = Array.from(
      { length: 3 },
      () => new FakeHelperProcess((_request, process) => process.crash()),
    );
    const spawnHelper = vi.fn(() => {
      const child = children.shift();
      if (child === undefined) {
        throw new Error("circuit breaker failed");
      }
      return child;
    });
    const provider = new AppleFoundationModelProvider({
      helperPath: "/fake/helper",
      spawnHelper,
      timeoutMs: 50,
    });

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expect(provider.status()).resolves.toMatchObject({
        availability: "runtime_unavailable",
      });
    }
    await expect(provider.status()).resolves.toMatchObject({
      availability: "runtime_unavailable",
    });
    expect(spawnHelper).toHaveBeenCalledTimes(3);
  });

  it("kills the helper and rejects pending work when closed", async () => {
    const child = new FakeHelperProcess();
    const provider = new AppleFoundationModelProvider({
      helperPath: "/fake/helper",
      spawnHelper: () => child,
      timeoutMs: 1_000,
    });
    const pending = provider.classify({
      pairId: "pair-1",
      assistantText: "请选择方案。",
      userText: "方案一",
      locale: "zh-CN",
    });

    await provider.close();

    await expect(pending).rejects.toMatchObject({
      code: "runtime_unavailable",
    });
    expect(child.kill).toHaveBeenCalledTimes(1);
    await expect(provider.status()).resolves.toMatchObject({
      availability: "runtime_unavailable",
    });
  });
});
