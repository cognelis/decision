import { z } from "zod";

const label = z.string().trim().min(1).max(500);
export const repositoryRelativePathSchema = z.string().trim().min(1).max(1_000).refine((path) =>
  !path.startsWith("/") && !/^[A-Za-z]:/u.test(path) && !/[\\\0\r\n*?]/u.test(path) &&
  path.split("/").every((part) => part.length > 0 && part !== "." && part !== ".."),
"Expected a literal repository-relative path without traversal or glob syntax");
export const decisionLayerSchema = z.enum(["frontend", "backend", "infrastructure", "shared"]);
export const decisionScopeSchema = z.object({
  projects: z.array(label).max(10).default([]),
  repositoryIds: z.array(z.string().regex(/^repo:[a-f0-9]{64}$/u)).max(10).default([]),
  modules: z.array(repositoryRelativePathSchema).max(20).default([]),
  layers: z.array(decisionLayerSchema).max(4).default([]),
  paths: z.array(repositoryRelativePathSchema).max(20).default([]),
  excludedPaths: z.array(repositoryRelativePathSchema).max(20).default([]),
  exceptions: z.array(z.string().trim().min(1).max(1_000)).max(10).default([]),
}).strict();
export const decisionRepositorySchema = z.object({
  id: z.string().regex(/^repo:[a-f0-9]{64}$/u),
  project: label,
  relativeDirectory: repositoryRelativePathSchema.or(z.literal("")),
  identitySource: z.enum(["remote", "git_common_directory"]),
}).strict();
export const decisionTaskScopeSchema = z.object({
  repository: decisionRepositorySchema.optional(),
  module: repositoryRelativePathSchema.optional(),
  layer: decisionLayerSchema.optional(),
  files: z.array(repositoryRelativePathSchema).max(100).default([]),
}).strict();
/** Why the scope check ruled a record out, one per dimension: what ruled it out is read back from its reasons by these. */
export const DECISION_SCOPE_REJECTIONS = {
  repository: "当前仓库身份不在记录明确限定的仓库中。",
  project: "当前项目不在记录的适用项目范围内。",
  layer: "当前技术层次不在记录明确限定的范围内。",
  module: "当前模块不在记录明确限定的范围内。",
  paths: "本次文件全部位于适用路径之外，或命中明确排除路径。",
} as const;
export const decisionApplicabilitySchema = z.object({
  status: z.enum(["scope_match", "needs_review", "out_of_scope"]),
  reasons: z.array(z.string().max(1_000)).max(20),
  scope: decisionScopeSchema,
}).strict();

export type DecisionScope = z.infer<typeof decisionScopeSchema>;
export const decisionScopeUpdateSchema = z.object({
  source: z.enum(["summarize", "decisions", "principles"]),
  recordId: z.string().trim().min(1).max(200),
  expectedContentHash: z.string().regex(/^[a-f0-9]{64}$/u),
  expectedRevision: z.number().int().min(0),
  scope: decisionScopeSchema,
  changeReason: z.string().trim().min(1).max(2_000),
}).strict();
export const decisionScopeUpdateResultSchema = z.object({
  status: z.enum(["saved", "unchanged", "source_changed", "revision_conflict", "source_unavailable"]),
  revision: z.number().int().nonnegative(),
  originalNoteUnchanged: z.literal(true),
}).strict();
export type DecisionScopeUpdate = z.infer<typeof decisionScopeUpdateSchema>;
export type DecisionScopeUpdateResult = z.infer<typeof decisionScopeUpdateResultSchema>;
export type DecisionRepository = z.infer<typeof decisionRepositorySchema>;
export type DecisionTaskScope = z.infer<typeof decisionTaskScopeSchema>;
export type DecisionApplicability = z.infer<typeof decisionApplicabilitySchema>;
