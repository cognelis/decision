import { describe, expect, it } from "vitest";
// @ts-expect-error Production lint entry is an ESM script.
import { lintModelNetwork, violations } from "../lint-model-network.mjs";

describe("模型网络依赖边界", () => {
  it("检查全部应用和包的生产源码", async () => {
    expect(await lintModelNetwork()).toEqual([]);
  });
  it.each([
    'import OpenAI from "openai"; new OpenAI();',
    'import { fetch as send } from "undici"; send(url);',
    'import https from "node:https"; https.request(url);',
    'import { AnthropicMessagesAdapter } from "./model/adapters/anthropic-messages-adapter.js";',
    'globalThis.fetch(url);',
    'const send = fetch; send(url);',
    'const http = require("node:https");',
    'setGlobalDispatcher(dispatcher);',
    'await import("node:net");',
    'new WebSocket(url);',
    'new HttpModelTransport();',
    'new ManagedChildProcessRunner();',
    'import { complete } from "@earendil-works/pi-ai";',
  ])("阻止业务绕过 Factory：%s", (source) => {
    expect(violations("apps/desktop/src/main/bypass.ts", source).length).toBeGreaterThan(0);
  });
  it("不把代码示例字符串当作网络调用", () => {
    expect(violations("apps/desktop/src/renderer/example.ts", 'const example = "return fetch(url)";')).toEqual([]);
  });
});
