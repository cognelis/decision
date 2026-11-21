import { Agent, type AgentOptions } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream, type AssistantMessage, type Model, type JsonObject } from "@earendil-works/pi-ai";
import type { NormalizedTokenUsage } from "@cognelis/decision-protocol";
export type { AgentTool, StreamFn } from "@earendil-works/pi-agent-core";
export type { Model, JsonObject } from "@earendil-works/pi-ai";

/** No default Pi provider transport: every caller must supply its gateway stream. */
export function createGatewayAgent(options: Omit<AgentOptions, "toolExecution">) {
  if (typeof options.streamFn !== "function") throw new Error("Agent 必须提供 gateway streamFn。");
  return new Agent({ ...options, streamFn: options.streamFn, toolExecution: "sequential" });
}
export function gatewayToolStream(model: Model<"openai-completions">) {
  const stream = createAssistantMessageEventStream();
  const message: AssistantMessage = { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id, stopReason: "pending", timestamp: Date.now(), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
  const done = (actions: Array<{ name: string; arguments: JsonObject; id: string }>, usage: NormalizedTokenUsage) => {
    message.usage.input = usage.inputTokens ?? 0; message.usage.output = usage.outputTokens ?? 0; message.usage.totalTokens = usage.totalTokens ?? 0;
    message.content = actions.map(action => ({ type: "toolCall", ...action })); message.stopReason = "toolUse";
    stream.push({ type: "start", partial: message }); stream.push({ type: "done", reason: "toolUse", message });
  };
  return { stream, message, done };
}
