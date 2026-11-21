import { useEffect, useId, useState, type ReactNode } from "react";
import {
  parseTodoItemSourceKey,
  type ExperienceBody,
  type RedactedModelProviderProfile,
  type SuggestionChoice,
  type SuggestionDraft,
  type SuggestionSourceView,
  type SuggestionUndoResult,
  type SuggestionView,
} from "@cognelis/decision-protocol";

import { ActionIcon } from "../../IconButton.js";
import { OUTCOME_LABEL, ROLE_LABEL, SOURCE_KIND_LABEL, STALE_TEXT, TYPE_LABEL, deferPresets, localDayOf, shortDate, verificationText } from "./organization-text.js";

export interface Notice {
  tone: "ok" | "warn" | "error";
  text: string;
  /** 撤销需要先看差异：这份差异连同它的哈希，确认时原样带回。 */
  undo?: SuggestionUndoResult;
}

export interface DetailActions {
  edits: Readonly<Record<string, SuggestionDraft>>;
  setEdit(id: string, draft: SuggestionDraft | null): void;
  saveEdit(view: SuggestionView): Promise<void>;
  adopt(view: SuggestionView, choice?: SuggestionChoice): Promise<void>;
  defer(view: SuggestionView, day: string): Promise<void>;
  reject(view: SuggestionView): Promise<void>;
  undo(view: SuggestionView, diffHash?: string): Promise<void>;
  regenerate(view: SuggestionView, profileId: string): Promise<void>;
  openSource(key: string, relativePath: string | null): void;
  canOpen(key: string, relativePath: string | null): boolean;
  notices: Readonly<Record<string, Notice>>;
  busy: ReadonlySet<string>;
  profiles: readonly RedactedModelProviderProfile[];
  readOnly: boolean;
}

const Section = ({ title, children }: { title: string; children: ReactNode }) => <div className="org-section"><h4>{title}</h4>{children}</div>;
const Badge = ({ children, tone }: { children: ReactNode; tone?: "accent" | "warn" | "ok" | "error" | undefined }) => <span className={`org-badge${tone === undefined ? "" : ` org-badge-${tone}`}`}>{children}</span>;

const itemLabel = (key: string): string => {
  const parsed = parseTodoItemSourceKey(key);
  return parsed === null ? key : `事项 #${parsed.item}`;
};

const definedOnly = (body: { [K in keyof ExperienceBody]?: string | undefined } | undefined): Partial<ExperienceBody> =>
  Object.fromEntries(Object.entries(body ?? {}).filter(([, value]) => value !== undefined)) as Partial<ExperienceBody>;

const BODY_FIELDS: readonly { field: keyof ExperienceBody; label: string; rows: number }[] = [
  { field: "title", label: "标题", rows: 1 },
  { field: "scene", label: "场景", rows: 3 },
  { field: "action", label: "行动", rows: 3 },
  { field: "observation", label: "观察 / 验证", rows: 3 },
  { field: "inference", label: "启示（归纳，与观察分开）", rows: 3 },
  { field: "exceptions", label: "例外与未覆盖", rows: 3 },
];

export const SuggestionDetail = ({ view, actions, versions = [] }: { view: SuggestionView; actions: DetailActions; versions?: SuggestionView[] }) => {
  const prefix = useId();
  const busy = actions.busy.has(view.id);
  const content = view.content;
  const edit = actions.edits[view.id];
  const notice = actions.notices[view.id];
  const [editing, setEditing] = useState(false);
  const [deferOpen, setDeferOpen] = useState(false);
  const [deferDay, setDeferDay] = useState("");
  const [showChange, setShowChange] = useState(view.stale !== null);
  const [choice, setChoice] = useState<SuggestionChoice | null>(content?.type === "judgment" ? content.recommendation : view.choices[0] ?? null);
  const [regenProfile, setRegenProfile] = useState(actions.profiles[0]?.profileId ?? "");
  useEffect(() => { if (regenProfile === "" && actions.profiles[0] !== undefined) setRegenProfile(actions.profiles[0].profileId); }, [actions.profiles, regenProfile]);
  useEffect(() => { if (choice === null || !view.choices.includes(choice)) setChoice(view.choices[0] ?? null); }, [view.choices, choice]);

  const tomorrow = (() => { const date = new Date(); date.setDate(date.getDate() + 1); return localDayOf(date); })();
  const disabled = busy || actions.readOnly;
  const pending = view.state === "pending";
  const attribution = verificationText(view);
  const editable = (pending || view.state === "applied") && (view.type === "experience" || view.type === "todo_acceptance" || view.type === "conflict");
  const stateAdopted = view.state === "applied";

  const sourceRow = (source: SuggestionSourceView, extra?: ReactNode) => (
    <li key={source.key} className="org-source">
      <span className="org-source-label"><Badge>{SOURCE_KIND_LABEL[source.kind]}</Badge> {source.label}
        {source.itemStatus === null ? null : <Badge>{{ open: "待处理", in_progress: "处理中", done: "已完成", dropped: "已放弃" }[source.itemStatus]}{source.priority === null ? "" : ` · ${source.priority.toUpperCase()}`}</Badge>}
        <Badge>{ROLE_LABEL[source.role]}</Badge>
        {source.status === "current" ? null : <Badge tone="warn">{{ changed: "来源已更新", gone: "来源已删除", unreadable: "这次没能读取", current: "" }[source.status]}</Badge>}
      </span>
      {source.excerpt === null ? <span className="org-muted">{source.status === "gone" ? "原文已清除。" : "没有摘录。"}</span> : <q>{source.excerpt}</q>}
      {extra}
      {actions.canOpen(source.key, source.relativePath) ? <button type="button" className="text-button" onClick={() => actions.openSource(source.key, source.relativePath)}><ActionIcon name="open" />查看原文</button> : null}
    </li>
  );
  const sourceList = (items: readonly SuggestionSourceView[], differences?: ReadonlyMap<string, string>) => (
    <ul className="org-sources">{items.map((source) => sourceRow(source, differences?.get(source.key) === undefined ? null : <p className="org-difference"><strong>与另外几条的差异：</strong>{differences.get(source.key)}</p>))}</ul>
  );

  const body = (() => {
    if (view.redacted || content === null) {
      return <p className="org-banner org-banner-warn" role="status">来源已删除，内容已清除。这条建议只保留状态记录，不能应用。</p>;
    }
    switch (content.type) {
      case "todo_group": {
        const differences = new Map(content.members.map((member) => [member.key, member.difference]));
        return (
          <>
            <p className="org-notice"><ActionIcon name="help" /><span><strong>采纳只是把这 {content.members.length} 条放进一个主题组，一起阅读。</strong>不合并事项，不改状态、编号、优先级、截止日期，也不改所属清单；可随时取消分组。</span></p>
            <Section title={`${content.members.length} 条来源与差异（采纳前可见）`}>{sourceList(view.sources, differences)}</Section>
          </>
        );
      }
      case "todo_context":
        return (
          <Section title={`${itemLabel(content.item)}开始前要看`}>
            <ul className="org-sources">
              {content.links.map((link) => {
                const linked = view.sources.find((source) => source.key === link.key);
                return (
                  <li key={link.key} className="org-source">
                    <span className="org-source-label"><Badge>{linked === undefined ? "记录" : SOURCE_KIND_LABEL[linked.kind]}</Badge> {link.title}</span>
                    <p>{link.whyRelevant}</p>
                    <p className="org-difference"><strong>范围与例外：</strong>{link.scopeNote ?? "没有标明范围，使用前需核对。"}（相关不等于适用）</p>
                    {actions.canOpen(link.key, linked?.relativePath ?? null) ? <button type="button" className="text-button" onClick={() => actions.openSource(link.key, linked?.relativePath ?? null)}><ActionIcon name="open" />查看原文</button> : null}
                  </li>
                );
              })}
            </ul>
          </Section>
        );
      case "triage": return <><Section title="自动分诊"><Badge>{content.disposition === "linked" ? "已关联证据" : content.disposition === "unknown" ? "保留未知" : "等待后续证据"}</Badge><p>{content.explanation}</p>{content.links.map((link) => <blockquote key={link.key}><strong>{link.title}</strong><p>{link.whyRelevant}</p></blockquote>)}</Section><Section title="来源"><ul className="org-sources">{view.sources.map((source) => sourceRow(source))}</ul></Section></>;
      case "judgment": return <><Section title="为什么现在需要判断"><p>{content.impact}</p></Section><Section title="未知与边界"><p>{content.unknowns}</p></Section><Section title="已知依据"><ul className="org-sources">{view.sources.map((source) => sourceRow(source))}</ul></Section><fieldset className="org-choices" disabled={disabled || stateAdopted}><legend>选择处理方向</legend>{content.options.map((option, index) => { const value = index === 0 ? "option_a" : "option_b"; return <label key={value}><input type="radio" name={`${prefix}-choice`} checked={choice === value} onChange={() => setChoice(value)} />{option}{content.recommendation === value ? <Badge>系统建议</Badge> : null}</label>; })}<label><input type="radio" name={`${prefix}-choice`} checked={choice === "hold"} onChange={() => setChoice("hold")} />暂不判断，等待更多证据</label></fieldset><p className="org-muted">建议依据：{content.recommendationReason}</p></>;
      case "todo_acceptance": {
        const current = edit?.type === "todo_acceptance" ? edit.draftDetail : view.draft?.type === "todo_acceptance" ? view.draft.draftDetail : content.draftDetail;
        return (
          <>
            <Section title="缺什么"><p>{content.missing}</p></Section>
            <div className="org-compare">
              <div><h4>现在的说明</h4><p className="org-pre">{content.currentDetail ?? "（没有写说明）"}</p></div>
              <div>
                <h4>改写草稿{view.draft === null && edit === undefined ? "" : " · 含你的编辑"}</h4>
                {editing ? (
                  <textarea aria-label="改写草稿" rows={6} maxLength={4_000} value={current} onChange={(event) => actions.setEdit(view.id, { type: "todo_acceptance", draftDetail: event.currentTarget.value })} />
                ) : <p className="org-pre">{current}</p>}
              </div>
            </div>
            <p className="org-muted">你确认后才改原事项的说明；处置备注、状态、标题都不动。</p>
          </>
        );
      }
      case "todo_recheck":
        return (
          <Section title="为什么现在提示">
            <p>{content.reason === "overdue" ? `${itemLabel(content.item)}已逾期 ${content.days} 天。` : `${itemLabel(content.item)}已有 ${content.days} 天没有变化。`}</p>
            {content.similarDone === null ? null : <p className="org-difference">清单里有相似事项已完成（{itemLabel(content.similarDone)}），但这不能证明本项完成。</p>}
            <p className="org-muted">这里只能记下「已重新判断」，不会自动延期、完成或放弃。</p>
          </Section>
        );
      case "experience": {
        const draftBody = edit?.type === "experience" ? edit.body : view.draft?.type === "experience" ? view.draft.body : undefined;
        const merged: ExperienceBody = { ...content.body, ...definedOnly(draftBody) };
        return (
          <>
            <dl className="org-attribution">
              <div><dt>谁说的</dt><dd><Badge>{attribution.reporter}</Badge></dd></div>
              <div><dt>是否核验</dt><dd><Badge tone={view.attribution.verification === "agent_reported_unverified" ? "warn" : undefined}>{attribution.verification}</Badge></dd></div>
              <div><dt>状态</dt><dd><Badge tone="accent">{attribution.adoption}</Badge></dd></div>
              <div><dt>来源状态</dt><dd><Badge tone={view.stale === null ? undefined : "warn"}>{attribution.source}</Badge></dd></div>
            </dl>
            <p className="org-muted">是否适用，以下面的「场景」和「例外」为准；「未发现来源变更」不等于现在仍然适用。{view.independentEvidence === 0 ? "没有独立观察来源。" : `独立观察来源 ${view.independentEvidence} 份。`}结果：{OUTCOME_LABEL[content.outcome]}。</p>
            <div className="org-experience">
              {BODY_FIELDS.map(({ field, label, rows }) => (
                <div key={field} className="org-section">
                  <h4>{label}</h4>
                  {editing ? (
                    <textarea aria-label={label} rows={rows} maxLength={field === "title" ? 300 : 3_000} value={merged[field]}
                      onChange={(event) => actions.setEdit(view.id, { type: "experience", body: { ...(edit?.type === "experience" ? edit.body : view.draft?.type === "experience" ? view.draft.body : {}), [field]: event.currentTarget.value } })} />
                  ) : (() => {
                    const text = field === "observation" && content.verification === "agent_reported_unverified" && !merged[field].startsWith("Agent 报告") ? `Agent 报告：${merged[field]}` : merged[field];
                    // 用户改过的字段以浅黄底标出，和「已保留，未被覆盖」的说明对得上。
                    return draftBody?.[field] === undefined ? <p className="org-pre">{text}</p> : <p className="org-pre"><mark className="org-edited">{text}</mark></p>;
                  })()}
                  {field === "observation" && content.verification === "agent_reported_unverified" ? <p className="org-warn-text">未附原始日志或检验材料，尚未独立核验。</p> : null}
                </div>
              ))}
            </div>
            <Section title="来源">{sourceList(view.sources)}</Section>
            {view.attribution.generated === null ? null : <p className="org-muted"><ActionIcon name="star" /> 生成：模型整理 · {view.attribution.generated.model}</p>}
            <p className="org-notice"><ActionIcon name="help" /><span><strong>采纳经验只表示「愿意保存供以后参考」：</strong>不是采纳原则，不证明因果，也不会变成偏好或待办。</span></p>
          </>
        );
      }
      case "conflict": {
        const proposal = content.proposal;
        const edited = edit?.type === "conflict" ? edit : view.draft?.type === "conflict" ? view.draft : null;
        const after = { a: edited === null ? proposal.a : edited.a, b: edited === null ? proposal.b : edited.b };
        const side = (label: "A" | "B", data: typeof content.a) => (
          <div className="org-side">
            <h4><Badge>结论 {label}</Badge> {data.title}</h4>
            <dl>
              <div><dt>项目</dt><dd>{data.project ?? "未标明"}</dd></div>
              <div><dt>时间</dt><dd>{data.at === null ? "未标明" : shortDate(data.at)}</dd></div>
              <div><dt>来源</dt><dd>{data.sourceLabel}</dd></div>
              <div><dt>条件</dt><dd>{data.condition ?? "未写明条件"}</dd></div>
              <div><dt>适用范围</dt><dd>{data.appliesWhen ?? "未限定（范围字段为空）"}</dd></div>
            </dl>
            {actions.canOpen(data.key, view.sources.find((source) => source.key === data.key)?.relativePath ?? null)
              ? <button type="button" className="secondary-button" onClick={() => actions.openSource(data.key, view.sources.find((source) => source.key === data.key)?.relativePath ?? null)}><ActionIcon name="open" />查看原文</button> : null}
          </div>
        );
        return (
          <>
            <p className="org-notice org-notice-warn"><ActionIcon name="warning" /><span><strong>两条结论方向相反，但先别判断谁对。</strong>{content.sameScope ? "它们看起来在同一范围，需要你判断。" : "它们可能来自不同模块或场景，只是适用范围不同。"}请先核对条件；不会按时间新旧自动选一条。</span></p>
            <div className="org-sides">{side("A", content.a)}{side("B", content.b)}</div>
            <fieldset className="org-choices" disabled={disabled || !pending}>
              <legend>选择处理方式</legend>
              {view.choices.length === 0 ? <p className="org-muted">{view.blockedReason ?? "这条冲突现在没有可在此应用的处理方式；请打开原记录自行处理。"}</p> : null}
              {view.choices.includes("keep_scopes") ? (
                <label><input type="radio" name={`${prefix}-choice`} checked={choice === "keep_scopes"} onChange={() => setChoice("keep_scopes")} /> <strong>保留各自范围：</strong>{after.a ?? "A 不改"}；{after.b ?? "B 不改"}，两条并存。</label>
              ) : null}
              {view.choices.includes("hold") ? (
                <label><input type="radio" name={`${prefix}-choice`} checked={choice === "hold"} onChange={() => setChoice("hold")} /> <strong>暂不判断：</strong>不改任何记录，冲突保持打开，有新材料时再提示。</label>
              ) : null}
            </fieldset>
            <Section title="应用「保留各自范围」会改哪些字段（应用前预览）">
              <table className="org-table">
                <thead><tr><th>记录</th><th>字段</th><th>现在</th><th>应用后</th></tr></thead>
                <tbody>
                  {(["a", "b"] as const).map((which) => {
                    const data = content[which];
                    const next = after[which];
                    return (
                      <tr key={which}>
                        <td>结论 {which.toUpperCase()}</td><td>适用范围</td><td>{data.appliesWhen ?? "未限定"}</td>
                        <td>
                          {!data.scopeEditable ? <span className="org-muted">不能在这里改（{data.sourceLabel}）</span> : editing ? (
                            <input aria-label={`结论 ${which.toUpperCase()} 的适用范围`} maxLength={2_000} value={next ?? ""} onChange={(event) => {
                              const text = event.currentTarget.value;
                              actions.setEdit(view.id, { type: "conflict", a: which === "a" ? (text === "" ? null : text) : after.a, b: which === "b" ? (text === "" ? null : text) : after.b });
                            }} />
                          ) : <strong>{next ?? "不改"}</strong>}
                        </td>
                      </tr>
                    );
                  })}
                  {proposal.relation === null ? null : <tr><td>A 与 B 的关系</td><td>关系</td><td>冲突待复核</td><td><strong>范围不同，并不冲突</strong></td></tr>}
                  <tr><td>不会改</td><td colSpan={3}>结论正文、时间、来源、状态；不标哪条胜出，不标「已被替代」。两项之一若确实被取代，需要在决策详情里逐条确认，不在此一键处理。</td></tr>
                </tbody>
              </table>
            </Section>
          </>
        );
      }
    }
  })();

  const undoReview = notice?.undo;
  const adoptLabel = view.type === "judgment" ? (choice === "hold" ? "暂不判断" : "确认选择") : view.type === "experience" ? "采纳经验" : view.type === "todo_recheck" ? "记为已重新判断" : view.type === "conflict" ? (choice === "hold" ? "暂不判断" : "保留各自范围") : view.type === "todo_group" ? "采纳所选" : "采纳";
  const dirty = edit !== undefined;

  return (
    <article className="org-article" aria-label={view.title}>
      <div className="org-badges">
        <Badge tone="accent">{view.type === "experience" ? (stateAdopted ? "记忆 · 已写入 Memory" : "候选经验 · 未写入 Memory") : TYPE_LABEL[view.type]}</Badge>
        {view.type === "todo_group" ? <Badge>仅分组阅读 · 不合并</Badge> : null}
        {view.stale === null ? null : <Badge tone="warn">{STALE_TEXT[view.stale.reason]}</Badge>}
        {view.type === "conflict" ? <Badge>1 项待核对</Badge> : null}
      </div>
      <h3>{view.title}</h3>
      {view.reopenReason === null ? null : <p className="org-banner org-banner-accent" role="status"><strong>重新出现：</strong>{view.reopenReason}</p>}
      {view.type === "todo_group" || view.type === "experience" || view.type === "conflict" ? null : <p className="org-why"><strong>为什么现在提示：</strong>{view.why}</p>}
      {view.type === "todo_group" ? <p className="org-why"><strong>为什么现在提示：</strong>{view.why}</p> : null}

      {view.stale === null ? null : (
        <div className="org-banner org-banner-warn" role="alert">
          <strong>{view.automatic ? "来源待自动核对，暂缓使用。" : "来源已变化，请重新核对。"}</strong>
          {view.stale.reason === "source_unreadable" ? "这次没能读取来源，不等于它被删除。" : view.stale.reason === "source_gone" ? "来源已经删除或移走。" : "没有写入任何内容，原建议和你的编辑都还在；只是在重新核对前不能采纳。"}
          {view.blockedReason === null ? null : <span> {view.blockedReason}</span>}
        </div>
      )}
      {view.stale !== null && (view.draft !== null || dirty) ? <p className="org-draft-kept">你编辑过的内容已保留，未被覆盖（以浅黄底标出）。</p> : null}

      {body}
      {versions.length === 0 ? null : <details className="org-section"><summary>来源与版本记录（{versions.length + 1} 版）</summary>{versions.map((version) => <section key={version.id}><h4>{version.title} · {shortDate(version.updatedAt)} · {version.automatic ? "自动整理" : "含用户纠正"}</h4>{version.content?.type === "experience" ? <><p className="org-pre">观察：{version.content.body.observation}</p><p className="org-pre">推断：{version.draft?.type === "experience" ? version.draft.body.inference ?? version.content.body.inference : version.content.body.inference}</p><p className="org-pre">边界：{version.content.body.exceptions}</p></> : <p>{version.effect}</p>}</section>)}</details>}

      {view.stale !== null && showChange ? (
        <Section title="来源变化（采纳前对照）">
          {[...view.sources, ...view.counter].filter((source) => source.status !== "current").length === 0 ? <p className="org-muted">没有逐条的变化记录。</p> : (
            <ul className="org-changes">
              {[...view.sources, ...view.counter].filter((source) => source.status !== "current").map((source) => (
                <li key={source.key}>
                  <strong>{source.label}</strong>
                  <p className="org-diff-old"><span>原</span> {source.excerpt ?? "（原文已清除）"}</p>
                  <p className="org-diff-new"><span>现</span> {source.status === "changed" ? (source.currentText ?? "（现在的原文没能读取）") : source.status === "gone" ? "来源已删除" : "这次没能读取"}</p>
                </li>
              ))}
              <li className="org-muted">原建议基于「原」的内容生成；来源改后，原结论可能不再成立。</li>
            </ul>
          )}
        </Section>
      ) : null}

      {view.state === "partially_applied" || view.steps.length > 0 ? (
        <Section title="写入情况">
          <ul className="org-steps">{view.steps.map((step, index) => <li key={`${step.kind}-${index}`}><Badge tone={step.state === "written" ? "ok" : step.state === "planned" ? undefined : "warn"}>{{ planned: "未写入", writing: "写入中", written: "已写入", failed: "失败", conflict: "冲突" }[step.state]}</Badge> {{ todo_detail: "补充说明", amendment_revise: "记录修订", relation_save: "关联关系", experience_create: "保存记忆版本", experience_activate: "启用记忆", experience_archive: "保留旧版", annotation_put: "阅读层更新" }[step.kind as "experience_create"] ?? "更新记录"}{step.message === null ? "" : ` · ${step.message}`}</li>)}</ul>
          {view.state === "partially_applied" ? <p className="org-warn-text">只写入了一部分：未写入的不会生效，已写入的可以撤销。</p> : null}
        </Section>
      ) : null}

      {view.type === "todo_group" || view.type === "todo_context" || view.type === "todo_acceptance" || view.type === "todo_recheck" ? (
        <div className="org-effect">
          <div><h4>处理结果</h4><p>{view.effect}</p></div>
          <div><h4>不会改</h4><p>{view.unchanged}</p></div>
        </div>
      ) : view.type === "conflict" ? null : (
        <div className="org-effect">
          <div><h4>处理结果</h4><p>{view.effect}</p></div>
          <div><h4>不会改</h4><p>{view.unchanged}</p></div>
        </div>
      )}

      {notice === undefined ? null : (
        <div className={`org-banner org-banner-${notice.tone}`} role={notice.tone === "error" ? "alert" : "status"}>
          {notice.text}
          {undoReview === undefined ? null : (
            <>
              <table className="org-table">
                <thead><tr><th>位置</th><th>字段</th><th>现在</th><th>恢复为</th></tr></thead>
                <tbody>{undoReview.diff.map((row, index) => <tr key={index}><td>{row.target}</td><td>{row.field}</td><td>{row.current ?? "（空）"}</td><td>{row.restoreTo ?? "（空）"}</td></tr>)}</tbody>
              </table>
              <button type="button" className="secondary-button" disabled={disabled || undoReview.diffHash === null} onClick={() => void actions.undo(view, undoReview.diffHash ?? undefined)}>
                按这份差异恢复
              </button>
              <span className="org-muted"> 恢复只改这份差异里列出的内容；之后若又有改动，会重新给出差异，不覆盖。</span>
            </>
          )}
        </div>
      )}

      {stateAdopted ? (
        <div className="org-adopted" role="status">
          <span><ActionIcon name="check" /> {view.automatic ? "已自动更新。可查看来源、纠正和回退。" : view.type === "judgment" ? "已记录你的选择，未执行任务。" : "已保存。"}</span>
          {view.applied.filter((item) => item.ok && item.relativePath !== null).map((item) => (
            <button key={item.key} type="button" className="secondary-button" onClick={() => actions.openSource(item.key, item.relativePath)}>查看</button>
          ))}
          {view.type === "experience" && view.stale === null ? editing ? <button type="button" className="primary-button" disabled={disabled || !dirty} onClick={() => void actions.adopt(view)}>保存纠正为新版本</button> : <button type="button" className="secondary-button" disabled={disabled} onClick={() => setEditing(true)}>纠正</button> : null}
          {view.canUndo ? <button type="button" className="secondary-button" disabled={disabled} onClick={() => void actions.undo(view)}><ActionIcon name="refresh" />回退</button> : null}
          <p className="org-muted">撤销只在内容还没被改动时直接恢复；之后若有编辑，会先显示恢复差异，不覆盖新改动。</p>
        </div>
      ) : view.automatic ? <p className="org-muted">{view.stale === null ? "等待自动维护完成，无需逐条采纳。" : "来源可用后会自动重新检查。"}</p> : (
        <div className="org-actions" role="group" aria-label="处理这条建议">
          {view.stale !== null ? (
            <>
              <button type="button" className="primary-button" aria-expanded={showChange} onClick={() => setShowChange((on) => !on)}><ActionIcon name="diff" />查看变化</button>
              <span className="org-regen">
                <select aria-label="重新整理用的模型" value={regenProfile} onChange={(event) => setRegenProfile(event.currentTarget.value)} disabled={actions.profiles.length === 0}>
                  {actions.profiles.length === 0 ? <option value="">没有可用的模型</option> : actions.profiles.map((profile) => <option key={profile.profileId} value={profile.profileId}>{profile.label}</option>)}
                </select>
                <button type="button" className="secondary-button" disabled={disabled || regenProfile === ""} onClick={() => void actions.regenerate(view, regenProfile)}><ActionIcon name="refresh" />重新整理</button>
              </span>
            </>
          ) : null}
          {editable && view.stale === null && view.canAdopt ? (
            editing ? (
              <>
                <button type="button" className="secondary-button" disabled={disabled || !dirty} onClick={() => void actions.saveEdit(view).then(() => setEditing(false))}>保存草稿</button>
                <button type="button" className="text-button" disabled={disabled} onClick={async () => { if (dirty) await actions.saveEdit(view); setEditing(false); }}>取消编辑</button>
              </>
            ) : <button type="button" className="secondary-button" disabled={disabled} onClick={() => setEditing(true)}><ActionIcon name="edit" />编辑后采纳</button>
          ) : null}
          <button type="button" className="primary-button" disabled={disabled || !pending || !view.canAdopt || ((view.type === "conflict" || view.type === "judgment") && choice === null)}
            title={view.canAdopt ? undefined : (view.blockedReason ?? "现在不能采纳")}
            onClick={() => void actions.adopt(view, view.type === "conflict" || view.type === "judgment" ? (choice ?? undefined) : undefined)}>
            <ActionIcon name={view.canAdopt ? "check" : "warning"} />{view.canAdopt ? adoptLabel : "采纳已禁用"}
          </button>
          <button type="button" className="secondary-button" disabled={disabled || !pending} aria-expanded={deferOpen} onClick={() => setDeferOpen((on) => !on)}>稍后</button>
          <button type="button" className="text-button" disabled={disabled || !pending} onClick={() => void actions.reject(view)}>不采纳</button>
          {!view.canAdopt && view.blockedReason !== null && view.stale === null ? <p className="org-muted org-blocked">采纳已禁用：{view.blockedReason}</p> : null}
          {view.stale !== null ? <p className="org-muted org-blocked">采纳已禁用：需先重新核对来源。重新整理会生成新修订，不覆盖当前草稿。</p> : <p className="org-muted org-blocked">稍后：到你选的日期再提示。不采纳：记住，同样的问题不再提示。</p>}
        </div>
      )}

      {deferOpen && !stateAdopted ? (
        <div className="org-defer" role="group" aria-label="选择再提示的日期">
          {deferPresets(new Date()).map((preset) => (
            <button key={preset.day} type="button" className="secondary-button" disabled={disabled} onClick={() => { setDeferOpen(false); void actions.defer(view, preset.day); }}>{preset.label}（{shortDate(preset.day)}）</button>
          ))}
          <label>选日期 <input type="date" min={tomorrow} value={deferDay} onChange={(event) => setDeferDay(event.currentTarget.value)} /></label>
          <button type="button" className="primary-button" disabled={disabled || deferDay === "" || deferDay < tomorrow} onClick={() => { setDeferOpen(false); void actions.defer(view, deferDay); }}>
            {deferDay === "" || deferDay < tomorrow ? "稍后到所选日期" : `稍后到 ${shortDate(deferDay)}`}
          </button>
        </div>
      ) : null}
    </article>
  );
};
