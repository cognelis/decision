import type { OnboardingCard, OnboardingEntry, OnboardingRequest, OnboardingView } from "@cognelis/decision-protocol";

const PHRASE = "请原样回复：DECISION-7F3K";

const PLAN: Extract<OnboardingCard, { kind: "plan" }> = {
  kind: "plan",
  token: "previewplantoken0001",
  client: {
    id: "kimi",
    name: "Kimi CLI",
    shortName: "KM",
    command: "kimi",
    hooks: { file: "~/.kimi/hooks.json", format: "claude" },
    prompt: { event: "UserPromptSubmit", field: "prompt" },
    reply: { event: "Stop", source: "field", field: "last_assistant_message" },
    fields: { sessionId: "session_id", cwd: "cwd", turnId: "turn_id" },
    complete: { field: "reason", values: ["end_turn"] },
    mcp: { mode: "none" },
  },
  preview: {
    prompt: PHRASE,
    reply: "DECISION-7F3K",
    sessionId: "3f2c9a1e-preview",
    cwd: "/work/app",
    turnId: "turn-1",
    complete: true,
  },
};

/**
 * The 接入新工具 conversation in the preview: a scripted walk through its four cards, the probe's wait a few seconds
 * long, so each can be looked at and captured. Nothing is run or written.
 */
export const previewOnboarding = () => {
  const entries: OnboardingEntry[] = [];
  let card: OnboardingCard | null = null;
  let status: OnboardingView["status"] = "idle";
  let release: ((cancelled: boolean) => void) | null = null;
  const view = (): OnboardingView => ({ sessionId: "onb-preview01", entries: [...entries], card, status, weakModel: false });
  const say = (role: OnboardingEntry["role"], text: string) => entries.push({ role, text });
  return async ({ event }: OnboardingRequest): Promise<OnboardingView> => {
    await new Promise((resolve) => setTimeout(resolve, 120));
    switch (event.type) {
      case "message":
        say("user", event.text);
        say("assistant", "听起来是 Kimi CLI。先确认一下它在终端里的命令名。");
        card = { kind: "command", token: "previewcommandtoken1", command: "kimi", path: "/usr/local/bin/kimi" };
        break;
      case "command":
        card = null;
        say("user", event.answer === "confirm" ? "确认命令名：kimi" : event.answer === "none" ? "这个工具没有命令行" : "不是 kimi");
        say("notice", "运行了 kimi --version");
        say("notice", "运行了 kimi hooks --help");
        say("notice", "看了 ~/.kimi 里的文件名");
        say("assistant", "kimi 支持钩子，配置在 ~/.kimi/hooks.json，写法和 Claude Code 一样。我想先装个探针，看看它的钩子会送来哪些字段。");
        card = { kind: "probe", token: "previewprobetoken001", file: "~/.kimi/hooks.json", format: "claude", events: ["UserPromptSubmit", "Stop"] };
        break;
      case "probe":
        card = null;
        say("user", event.answer === "confirm" ? "同意装探针" : "先不装探针");
        if (event.answer === "confirm") {
          say("assistant", `探针装好了。请在这个工具里新开一轮对话，原样发送：${PHRASE}`);
          card = { kind: "waiting", phrase: PHRASE, file: "~/.kimi/hooks.json", events: ["UserPromptSubmit", "Stop"], expiresAt: Date.now() + 10 * 60_000 };
          status = "waiting";
        }
        break;
      case "await-probe": {
        const cancelled = await new Promise<boolean>((resolve) => {
          const timer = setTimeout(() => resolve(false), 6_000);
          release = (dropped) => { clearTimeout(timer); resolve(dropped); };
        });
        release = null;
        status = "idle";
        card = null;
        say("notice", `探针已结束（${cancelled ? "用户取消" : "收到事件"}），收到 ${cancelled ? 0 : 3} 个事件。探针已移除。`);
        if (!cancelled) {
          say("assistant", "抓到了：提问在 UserPromptSubmit 的 prompt 里，回复在 Stop 的 last_assistant_message 里。下面是接入方案，请看一下。");
          card = PLAN;
        }
        break;
      }
      case "cancel-probe":
      case "finish-probe":
        release?.(event.type === "cancel-probe");
        break;
      case "plan":
        card = null;
        say("user", event.answer === "confirm" ? "确认接入" : "先不接入");
        if (event.answer === "confirm") {
          say("assistant", "已接入 Kimi CLI。以后在这个工具里的对话会自动记录；它在「接入」页里可以编辑和删除。");
          status = "ended";
        }
        break;
      default:
        break;
    }
    return view();
  };
};
