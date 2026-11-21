import { modelKindSupportsGeneration, type LocalReviewWorkerKind, type ModelProviderProfile } from "@cognelis/decision-protocol";
import type { AssistantGatewayLike } from "./decision-assistant-service.js";
import { LocalReviewAgent } from "./local-review-agent.js";
import { ClaudeReviewWorker } from "./local-review-claude-worker.js";
import { PiReviewWorker } from "./local-review-pi-worker.js";
import type { LocalReviewWorker } from "./local-review-worker.js";

export function createLocalReviewWorker(worker: LocalReviewWorkerKind, profile: ModelProviderProfile, environment: NodeJS.ProcessEnv, gateway?: AssistantGatewayLike, requestId?: string): LocalReviewWorker {
  if (!profile.enabled) throw new Error("审阅模型档案尚未启用。");
  switch (worker) {
    case "codex":
      if (profile.kind !== "codex-cli") throw new Error("模型档案与所选执行方式不匹配。");
      return new LocalReviewAgent(profile, environment);
    case "pi":
      if (!modelKindSupportsGeneration(profile.kind)) throw new Error(`所选档案（${profile.kind}）不支持生成，不能用于 Pi 审阅；意见仍保留在草稿。`);
      if (!gateway) throw new Error("审阅模型 gateway 不可用。");
      return new PiReviewWorker(profile, gateway, environment, requestId);
    case "claude-code":
      if (profile.kind !== "claude-code-cli") throw new Error("模型档案与所选执行方式不匹配。");
      return new ClaudeReviewWorker(profile, environment);
    default: throw new Error("不支持的审阅执行方式。");
  }
}
