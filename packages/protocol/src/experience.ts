import { z } from "zod";

/**
 * 执行经验：一次有来源的行动、它的观察结果和归纳出的启示（IMP-191）。采纳后写进 Vault 的
 * `Decision Journal/experiences/`；采纳只表示愿意留着以后参考，不是原则、不证明因果，也不是偏好或待办。
 */
export const EXPERIENCE_VERSION = 1 as const;

export const EXPERIENCE_LIMITS = {
  title: 300,
  scene: 2_000,
  action: 2_000,
  observation: 3_000,
  inference: 2_000,
  exceptions: 2_000,
  excerpt: 600,
  sources: 20,
} as const;

const text = (maximum: number) => z.string().trim().min(1).max(maximum);

/** Who reported the result: the actor of the todo status event that carried it. Never inferred from wording. */
export const experienceReporterSchema = z.enum(["agent", "user"]);
/**
 * Whether anyone checked it. There is no "verified" value on purpose: an agent's report stays unverified however it is
 * worded, and the user's own note is their report, not an independent check.
 */
export const experienceVerificationSchema = z.enum(["agent_reported_unverified", "user_reported", "machine_synthesis"]);
/** pending: written during an adoption whose dependencies are still being re-checked; never searched. */
export const experienceStatusSchema = z.enum(["pending", "active", "archived"]);

/** The five parts of an experience; observation and inference are kept apart. */
export const experienceBodySchema = z.object({
  title: text(EXPERIENCE_LIMITS.title).regex(/^[^\r\n]*$/u, "must be a single line"),
  scene: text(EXPERIENCE_LIMITS.scene),
  action: text(EXPERIENCE_LIMITS.action),
  observation: text(EXPERIENCE_LIMITS.observation),
  inference: text(EXPERIENCE_LIMITS.inference),
  /** Conditions and exceptions: never left out (「例外与未覆盖」). */
  exceptions: text(EXPERIENCE_LIMITS.exceptions),
}).strict();

/** Where an adopted experience came from, kept with it: the todo history it was taken from may be trimmed later. */
export const experienceSourceSchema = z.object({
  key: z.string().min(1).max(260),
  label: z.string().max(500),
  /** The excerpt the experience rests on; null once the source was deleted (and `deleted` is set). */
  excerpt: z.string().max(EXPERIENCE_LIMITS.excerpt).nullable(),
  hash: z.string().regex(/^[a-f0-9]{64}$/u).nullable(),
  /** 来源时间照原记录保留：可以只有日期或尚未核实；记忆自身时间仍是严格 ISO。 */
  at: z.string().max(100).nullable(),
  deleted: z.literal(true).optional(),
}).strict();

/** An experience as search answers it (search_decision_context with source experiences, shape 3). */
export const experienceViewSchema = z.object({
  reporter: experienceReporterSchema,
  verification: experienceVerificationSchema,
  scene: z.string().max(EXPERIENCE_LIMITS.scene),
  observation: z.string().max(EXPERIENCE_LIMITS.observation),
  inference: z.string().max(EXPERIENCE_LIMITS.inference),
  exceptions: z.string().max(EXPERIENCE_LIMITS.exceptions),
  sources: z.array(z.object({ key: z.string().max(260), label: z.string().max(500), deleted: z.literal(true).optional() }).strict()).max(EXPERIENCE_LIMITS.sources),
  adoptedFrom: z.string().max(200).nullable(),
});

export type ExperienceReporter = z.infer<typeof experienceReporterSchema>;
export type ExperienceVerification = z.infer<typeof experienceVerificationSchema>;
export type ExperienceStatus = z.infer<typeof experienceStatusSchema>;
export type ExperienceBody = z.infer<typeof experienceBodySchema>;
export type ExperienceSource = z.infer<typeof experienceSourceSchema>;
export type ExperienceView = z.infer<typeof experienceViewSchema>;
