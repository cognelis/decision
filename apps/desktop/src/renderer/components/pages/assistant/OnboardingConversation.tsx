import {
  ONBOARDING_MAX_MESSAGE_CHARS,
  type OnboardingCard,
  type OnboardingEntry,
  type OnboardingEvent,
  type OnboardingView,
  type RetrievalAnswerProvider,
} from "@cognelis/decision-protocol";
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";

import type { DecisionApi } from "../../../../shared/renderer-api.js";
import { ActionIcon, IconButton } from "../../IconButton.js";

/** A 接入新工具 conversation as it is kept: what was said, and (in memory only) the card on show. */
export interface OnboardingTranscript {
  sessionId: string | null;
  entries: OnboardingEntry[];
  ended?: boolean | undefined;
  /** Not saved with the conversation: the App's side of it does not outlive a restart either. */
  card?: OnboardingCard | null | undefined;
  weakModel?: boolean | undefined;
}

export type OnboardingApi = Pick<DecisionApi, "sendOnboarding">;

const remaining = (until: number, now: number): string => {
  const seconds = Math.max(0, Math.round((until - now) / 1_000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
};

const Row = ({ label, children }: { label: string; children: ReactNode }) => (
  <div className="onboarding-row"><dt>{label}</dt><dd>{children}</dd></div>
);

const PlanCard = ({ card }: { card: Extract<OnboardingCard, { kind: "plan" }> }) => {
  const { client, preview } = card;
  const mcp = client.mcp.mode === "none"
    ? "不注册（只自动记录对话，代理在给出选项前读不到原则）"
    : client.mcp.mode === "command"
      ? `用 ${client.command ?? ""} 自己的命令注册：${client.mcp.add.join(" ")}`
      : client.mcp.mode === "file"
        ? `写进它的 MCP 配置文件 ${client.mcp.file}（只写 mcpServers.decision 这一项，不动别的内容）`
        : JSON.stringify(client.mcp);
  return (
    <dl className="onboarding-fields">
      <Row label="名称">{client.name}（{client.shortName}，id {client.id}）</Row>
      <Row label="命令">{client.command === undefined ? "没有命令行" : <code>{client.command}</code>}</Row>
      <Row label="钩子文件"><code>{client.hooks.file}</code> · {client.hooks.format}</Row>
      <Row label="事件">提问 {client.prompt.event} · 回复 {client.reply.event}</Row>
      <Row label="字段">
        提问 <code>{client.prompt.field}</code> · 回复 {client.reply.source === "transcript" ? <>从 <code>{client.reply.field}</code> 指向的会话记录读（{client.reply.format}）</> : <code>{client.reply.field}</code>} ·
        会话 <code>{client.fields.sessionId}</code> · 目录 <code>{client.fields.cwd}</code>
        {client.fields.turnId === undefined ? null : <> · 轮次 <code>{client.fields.turnId}</code></>}
        {client.complete === undefined ? null : <> · 正常完成：<code>{client.complete.field}</code> 为 {client.complete.values.join("、")}</>}
      </Row>
      <Row label="MCP">{mcp}</Row>
      <Row label="试解析">
        <span className="onboarding-preview">
          <span>提问：{preview.prompt}</span>
          <span>回复：{preview.reply}</span>
          <span>会话：{preview.sessionId}</span>
          <span>目录：{preview.cwd}</span>
          {preview.turnId === null ? null : <span>轮次：{preview.turnId}</span>}
          {preview.complete === null ? null : <span>正常完成：{preview.complete ? "是" : "否"}</span>}
        </span>
      </Row>
    </dl>
  );
};

/**
 * The assistant's 接入新工具 conversation: the reader says which tool, and answers each card (the command's name, the
 * probe, the plan). Nothing here is searched in the reader's records, nor rated.
 */
export const OnboardingConversation = ({
  api,
  transcript,
  onChange,
  onBusy,
  model,
  modelPicker,
  hidden,
}: {
  api: OnboardingApi;
  transcript: OnboardingTranscript;
  onChange(next: OnboardingTranscript): void;
  onBusy(busy: boolean): void;
  model: RetrievalAnswerProvider | null;
  modelPicker: ReactNode;
  hidden: boolean;
}) => {
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [copied, setCopied] = useState(false);
  const streamRef = useRef<HTMLDivElement>(null);
  // The latest, for a reply that lands after the conversation changed under it.
  const current = useRef(transcript);
  current.current = transcript;
  const card = transcript.card ?? null;
  const ended = transcript.ended === true;

  useEffect(() => {
    if (card?.kind !== "waiting") return;
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [card?.kind]);
  useEffect(() => {
    if (!hidden && streamRef.current) streamRef.current.scrollTop = streamRef.current.scrollHeight;
  }, [transcript.entries.length, card, busy, hidden]);

  const apply = (view: OnboardingView): OnboardingTranscript => ({
    sessionId: view.sessionId,
    entries: view.entries,
    card: view.card,
    ended: view.status === "ended",
    weakModel: view.weakModel,
  });

  const send = async (event: OnboardingEvent): Promise<void> => {
    // Ending or cancelling a wait goes alongside the wait already sent; the wait's own reply brings the result.
    const aside = event.type === "cancel-probe" || event.type === "finish-probe";
    if (busy && !aside) return;
    if (!aside) { setBusy(true); onBusy(true); }
    setError(null);
    try {
      let view = await api.sendOnboarding({
        sessionId: current.current.sessionId,
        ...(model === null ? {} : { profileId: model.profileId }),
        event,
      });
      if (aside) return;
      onChange(apply(view));
      // Installed: wait here for the tool's events, the card saying what to send meanwhile.
      while (view.status === "waiting" && view.card?.kind === "waiting") {
        view = await api.sendOnboarding({ sessionId: view.sessionId, event: { type: "await-probe" } });
        onChange(apply(view));
      }
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "这一步没能完成，请稍后再试。";
      setError(message);
      // The App no longer knows it (restarted since): nothing more can be sent.
      if (/已经结束/u.test(message)) onChange({ ...current.current, card: null, ended: true });
    } finally {
      if (!aside) { setBusy(false); onBusy(false); }
    }
  };

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    const text = input.trim();
    if (text.length === 0 || text.length > ONBOARDING_MAX_MESSAGE_CHARS || busy || ended || model === null) return;
    // Shown at once; the App's reply brings the whole conversation back with it.
    onChange({ ...current.current, entries: [...current.current.entries, { role: "user", text }], card: null });
    setInput("");
    void send({ type: "message", text });
  };

  const waiting = card?.kind === "waiting";
  return (
    <>
      <div className="assistant-stream-frame">
        <div className="assistant-stream onboarding-stream" ref={streamRef} role="log" aria-label="接入对话" tabIndex={0} aria-live={hidden ? "off" : "polite"}>
          {transcript.entries.length === 0 ? (
            <div className="assistant-empty">
              <strong>接入一个新工具</strong>
              <span>
                说说你想接入哪个 AI 编程工具，比如「我想接入 Kimi CLI」。助手会先请你确认它的命令名，看看它的帮助，再临时装一个探针，请你在那个工具里发一句带暗号的话，看清它的钩子送来什么，最后给出接入方案请你确认。不会在这台电脑上安装任何程序，探针用完就移除。
              </span>
            </div>
          ) : null}
          {transcript.weakModel === true ? (
            <p className="assistant-notice onboarding-weak" role="status">现在用的是本机小模型，接入这种多步任务它可能做不好；不顺利时可以换一个远端模型再试。</p>
          ) : null}
          {transcript.entries.map((entry, index) =>
            entry.role === "user" ? (
              <article key={index} className="assistant-turn user"><p>{entry.text}</p></article>
            ) : entry.role === "assistant" ? (
              <article key={index} className="assistant-turn assistant"><p className="onboarding-text">{entry.text}</p></article>
            ) : (
              <p key={index} className="assistant-notice onboarding-note">{entry.text}</p>
            ))}

          {card?.kind === "command" ? (
            <section className="onboarding-card" aria-label="确认命令名">
              <h3>确认命令名</h3>
              <p>这个工具在终端里的命令是 <code>{card.command}</code> 吗？确认后，助手只会用 <code>--version</code>、<code>--help</code> 这类参数运行它，不会运行别的命令。</p>
              <dl className="onboarding-fields"><Row label="程序">{card.path === null ? "PATH 里没找到这个命令" : <code>{card.path}</code>}</Row></dl>
              <div className="onboarding-actions">
                <button type="button" className="primary-button" disabled={busy} onClick={() => void send({ type: "command", token: card.token, answer: "confirm" })}>是这个命令</button>
                <button type="button" className="secondary-button" disabled={busy} onClick={() => void send({ type: "command", token: card.token, answer: "reject" })}>不是</button>
                <button type="button" className="secondary-button" disabled={busy} onClick={() => void send({ type: "command", token: card.token, answer: "none" })}>它没有命令行</button>
              </div>
            </section>
          ) : null}

          {card?.kind === "probe" ? (
            <section className="onboarding-card" aria-label="确认探针">
              <h3>临时装一个探针</h3>
              <dl className="onboarding-fields">
                <Row label="钩子文件"><code>{card.file}</code></Row>
                <Row label="格式">{card.format}</Row>
                <Row label="监听事件">{card.events.join("、")}</Row>
              </dl>
              <p>Paraself 会在这个文件里临时加几条自己的钩子，只记录这个工具送来的事件。收到事件、你取消或超时后会自动移除，文件里你自己的内容不会改动。</p>
              <div className="onboarding-actions">
                <button type="button" className="primary-button" disabled={busy} onClick={() => void send({ type: "probe", token: card.token, answer: "confirm" })}>装探针</button>
                <button type="button" className="secondary-button" disabled={busy} onClick={() => void send({ type: "probe", token: card.token, answer: "reject" })}>先不</button>
              </div>
            </section>
          ) : null}

          {waiting ? (
            <section className="onboarding-card onboarding-waiting" aria-label="等待探针">
              <h3>在那个工具里发这句话</h3>
              <p>请在这个工具里新开一轮对话，原样发送：</p>
              <div className="onboarding-phrase">
                <code>{card.phrase}</code>
                <IconButton aria-label="复制这句话" onClick={() => { void navigator.clipboard?.writeText(card.phrase).then(() => setCopied(true), () => undefined); }}><ActionIcon name={copied ? "check" : "copy"} /></IconButton>
              </div>
              <p className="assistant-notice" role="status">正在等待 {card.events.join("、")} 事件… 还剩 {remaining(card.expiresAt, now)}，到时探针会自动移除。</p>
              <p>已经在工具里发过、它也回复完了，但这里还在等？点「结束等待」，用已经收到的事件推断。点「取消探针」会丢掉收到的事件。两种都会移除探针。</p>
              <div className="onboarding-actions">
                <button type="button" className="primary-button" onClick={() => void send({ type: "finish-probe" })}>结束等待</button>
                <button type="button" className="secondary-button" onClick={() => void send({ type: "cancel-probe" })}>取消探针</button>
              </div>
            </section>
          ) : null}

          {card?.kind === "plan" ? (
            <section className="onboarding-card" aria-label="确认接入方案">
              <h3>接入方案</h3>
              <PlanCard card={card} />
              <p>确认后会把它保存为自定义客户端并接入：在钩子文件里写入 Paraself 的钩子{card.client.mcp.mode === "none" ? "" : "，并注册 MCP 服务"}。以后可以在「接入」页编辑或删除。</p>
              <div className="onboarding-actions">
                <button type="button" className="primary-button" disabled={busy} onClick={() => void send({ type: "plan", token: card.token, answer: "confirm" })}>确认接入</button>
                <button type="button" className="secondary-button" disabled={busy} onClick={() => void send({ type: "plan", token: card.token, answer: "reject" })}>先不</button>
              </div>
            </section>
          ) : null}

          {busy && !waiting ? <div className="assistant-running" role="status"><p>{model?.leavesDevice === true ? `已发送给 ${model.label}，正在处理…` : "正在处理…"}</p></div> : null}
        </div>
      </div>
      <div className="assistant-status">
        {error === null ? null : <p className="error-message assistant-error" role="alert">{error}</p>}
        {ended ? <p className="assistant-notice" role="status">这个接入对话已经结束。要接入别的工具，点「接入新工具」开一个新对话。</p> : null}
      </div>
      <form className="assistant-composer" onSubmit={submit}>
        <div className="assistant-compose-box">
          <textarea
            className="glass-input"
            rows={2}
            value={input}
            aria-label="和接入助手说"
            placeholder={ended ? "对话已结束" : waiting ? "先在那个工具里发上面那句话" : model === null ? "先在“模型”里启用一个可用的模型" : "说一句，⌘↩ 发送"}
            readOnly={busy}
            disabled={ended || waiting || model === null}
            maxLength={ONBOARDING_MAX_MESSAGE_CHARS}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return;
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); submit(event as unknown as FormEvent); }
            }}
          />
          <div className="assistant-compose-tools">
            {modelPicker}
            <div className="assistant-send-actions">
              <IconButton className="assistant-send" type="submit" aria-label="发送" disabled={busy || ended || waiting || model === null || input.trim().length === 0}><ActionIcon name="send" /></IconButton>
            </div>
          </div>
        </div>
        <p className="assistant-compose-hint">
          <span>{model === null ? "请选择可用模型" : model.leavesDevice ? "对话、命令帮助和目录里的文件名会发送给远端模型；工具送来的内容不会" : "在本机处理"}</span>
          <span>⌘ / Ctrl + Enter 发送</span>
        </p>
      </form>
    </>
  );
};
