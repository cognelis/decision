import {
  LOCAL_REVIEW_TOOLS_VERSION,
  localReviewJobRecordSchema,
  modelKindSupportsGeneration,
  type LocalReviewAction,
  type LocalReviewFromPr,
  type LocalReviewJob,
  type LocalReviewJobRecord,
  type LocalReviewJobRecordResult,
  type LocalReviewJobRequest,
  type LocalReviewJobResult,
  type LocalReviewJobSummary,
  type LocalReviewJobsQuery,
  type LocalReviewJobsResult,
  type LocalReviewJobUpdate,
  type LocalReviewJobUpdateResult,
  type LocalReviewState,
  type LocalReviewWorkerKind,
  type ModelProviderProfile,
  type PrConnection,
} from "@cognelis/decision-protocol";

import { resolveConnection } from "./pr-description-tools.js";

/**
 * 本地审阅 for an agent (record_local_review_job, list_local_review_jobs, get_local_review_job, update_local_review_job),
 * through the same service the 本地审阅 page and 我创建的's 修 use. A push onto a PR's branch and the approval of a risky
 * change are not here: those are the user's, in the App.
 */
export interface LocalReviewToolSources {
  state(): LocalReviewState;
  newSession(repositoryId: string): Promise<string>;
  annotate(input: { repositoryId: string; sessionId: string; path: string; side: "old" | "new"; startLine: number; endLine: number; body: string }): Promise<string>;
  submit(repositoryId: string, sessionId: string, profileId: string, worker?: LocalReviewWorkerKind): Promise<string>;
  submitFromPr(input: LocalReviewFromPr): Promise<string>;
  action(input: LocalReviewAction): Promise<void>;
  profiles(): Promise<ModelProviderProfile[]>;
  connections(): Promise<PrConnection[]>;
}

const said = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 2_000);
const RUNNING = new Set(["queued", "evaluating", "preparing_dependencies", "running_groups"]);
/** The worker a profile runs as: its own CLI, or Pi for any other model; and whether it fits a repository's worker. */
const workerOf = (profile: ModelProviderProfile): LocalReviewWorkerKind => profile.kind === "codex-cli" ? "codex" : profile.kind === "claude-code-cli" ? "claude-code" : "pi";
const fits = (profile: ModelProviderProfile, worker: LocalReviewWorkerKind) => worker === "pi" ? modelKindSupportsGeneration(profile.kind) : workerOf(profile) === worker;
const labelOf = (profile: ModelProviderProfile) => [profile.label, "model" in profile ? profile.model : null].filter(Boolean).join(" · ");

const repositoryOf = (state: LocalReviewState, named: string) =>
  state.repositories.find((item) => item.id === named) ?? state.repositories.find((item) => item.snapshot.path === named || item.name === named) ?? null;

export const jobSummary = (state: LocalReviewState, job: LocalReviewJob): LocalReviewJobSummary => ({
  id: job.id, repository: state.repositories.find((item) => item.id === job.repositoryId)?.name ?? job.repositoryId, state: job.state, createdAt: job.createdAt,
  comments: job.annotations.length, pr: job.pr ? { reference: job.pr.reference, sourceBranch: job.pr.sourceBranch } : null,
  groups: job.groups.map((group) => ({ ordinal: group.ordinal, title: group.title, state: group.state, branch: group.branch, pr: group.pr?.url ?? null, pushed: group.pushObservedSha !== null })),
  needsAttention: job.groups.filter((group) => ["failed", "blocked", "interrupted", "pushed_no_pr"].includes(group.state)).length + job.verdicts.filter((verdict) => verdict.verdict === "needs_input").length,
  error: job.error,
});

/** record_local_review_job: comments on a local repository's changes, or on the user's own PR (修), handed to the local review. */
export const recordLocalReviewJob = async (input: LocalReviewJobRecord, sources: LocalReviewToolSources): Promise<LocalReviewJobRecordResult> => {
  const request = localReviewJobRecordSchema.parse(input);
  const state = sources.state();
  const profiles = (await sources.profiles()).filter((profile) => profile.enabled && modelKindSupportsGeneration(profile.kind));
  const base = {
    localReviewToolsVersion: LOCAL_REVIEW_TOOLS_VERSION,
    repositories: state.repositories.map((item) => ({ id: item.id, name: item.name, path: item.snapshot.path })),
    connections: [] as LocalReviewJobRecordResult["connections"],
    models: profiles.map((profile) => ({ id: profile.profileId, label: labelOf(profile) })),
    jobId: null,
  };
  const repository = request.repository ? repositoryOf(state, request.repository) : null;
  if (request.repository && !repository) return { ...base, status: "repository_not_found", reason: null };
  const worker = repository?.settings.worker;
  const usable = worker ? profiles.filter((profile) => fits(profile, worker)) : profiles;
  const profile = request.model ? usable.find((item) => item.profileId === request.model || item.label === request.model || labelOf(item) === request.model) : usable[0];
  if (!profile) return { ...base, models: usable.map((item) => ({ id: item.profileId, label: labelOf(item) })), status: "model_not_found", reason: request.model ? null : "没有适用的模型档案：先在 Paraself 的模型设置里启用一个。" };
  try {
    if (request.reference) {
      const { connection, connections, status } = await resolveConnection(sources, request.connection);
      if (!connection) return { ...base, connections, status, reason: null };
      const jobId = await sources.submitFromPr({ connectionId: connection.id, reference: request.reference, commentIds: request.comments!, profileId: profile.profileId, worker: workerOf(profile), ...(repository ? { repositoryId: repository.id } : {}) });
      return { ...base, connections, status: "submitted", reason: null, jobId };
    }
    // A session of the repository as it stands now, its lines checked as the page checks them, then submitted as one.
    const sessionId = await sources.newSession(repository!.id);
    for (const annotation of request.annotations!) {
      await sources.annotate({ repositoryId: repository!.id, sessionId, path: annotation.path, side: annotation.side, startLine: annotation.line, endLine: annotation.endLine ?? annotation.line, body: annotation.body });
    }
    return { ...base, status: "submitted", reason: null, jobId: await sources.submit(repository!.id, sessionId, profile.profileId, worker) };
  } catch (error) {
    return { ...base, status: "refused", reason: said(error) };
  }
};

export const listLocalReviewJobs = (query: LocalReviewJobsQuery, sources: Pick<LocalReviewToolSources, "state">): LocalReviewJobsResult => {
  const state = sources.state();
  const repository = query.repository ? repositoryOf(state, query.repository) : null;
  const jobs = state.jobs.filter((job) => !query.repository || job.repositoryId === repository?.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return { localReviewToolsVersion: LOCAL_REVIEW_TOOLS_VERSION, jobs: jobs.slice(0, query.limit).map((job) => jobSummary(state, job)), total: jobs.length };
};

export const getLocalReviewJob = (request: LocalReviewJobRequest, sources: Pick<LocalReviewToolSources, "state">): LocalReviewJobResult => {
  const state = sources.state();
  const job = state.jobs.find((item) => item.id === request.id);
  if (!job) return { localReviewToolsVersion: LOCAL_REVIEW_TOOLS_VERSION, job: null };
  return { localReviewToolsVersion: LOCAL_REVIEW_TOOLS_VERSION, job: {
    ...jobSummary(state, job), worker: job.worker, model: job.actualModel ?? ("model" in job.profile ? job.profile.model : null) ?? job.profile.label,
    annotations: job.annotations.map((annotation) => {
      const verdict = job.verdicts.find((item) => item.id === annotation.id);
      const outcome = job.groups.flatMap((group) => group.fix?.outcomes ?? []).find((item) => item.id === annotation.id);
      return { path: annotation.path, line: annotation.startLine, body: annotation.body, verdict: verdict?.verdict ?? null, reason: verdict?.reason ?? null, outcome: outcome?.outcome ?? null, summary: outcome?.summary ?? null };
    }),
    details: job.groups.map((group) => ({ ordinal: group.ordinal, commit: group.artifact?.commitOid ?? null, changedFiles: group.artifact?.changes.map((change) => change.path) ?? [], risks: group.artifact?.risks ?? [],
      verification: group.fix?.verification.slice(0, 4_000) ?? null, error: group.error })),
    followUp: job.pr ? { replied: job.pr.replied.length, described: job.pr.described, error: job.pr.followUpError } : null,
  } };
};

/** update_local_review_job: cancel, or retry a group (by its number) or the evaluation. */
export const updateLocalReviewJob = async (request: LocalReviewJobUpdate, sources: Pick<LocalReviewToolSources, "state" | "action">): Promise<LocalReviewJobUpdateResult> => {
  const base = { localReviewToolsVersion: LOCAL_REVIEW_TOOLS_VERSION } as const;
  const job = sources.state().jobs.find((item) => item.id === request.id);
  if (!job) return { ...base, status: "not_found", reason: null, job: null };
  const group = request.group === undefined ? undefined : job.groups.find((item) => item.ordinal === request.group);
  if (request.group !== undefined && !group) return { ...base, status: "refused", reason: `这个任务没有第 ${request.group} 组。`, job: jobSummary(sources.state(), job) };
  if (request.action === "cancel" && !RUNNING.has(job.state)) return { ...base, status: "refused", reason: "任务已经结束，不用取消。", job: jobSummary(sources.state(), job) };
  try {
    await sources.action({ repositoryId: job.repositoryId, jobId: job.id, action: request.action, ...(group && request.action === "retry" ? { groupId: group.id } : {}) });
  } catch (error) {
    return { ...base, status: "refused", reason: said(error), job: jobSummary(sources.state(), job) };
  }
  const now = sources.state();
  return { ...base, status: "done", reason: null, job: jobSummary(now, now.jobs.find((item) => item.id === job.id) ?? job) };
};
