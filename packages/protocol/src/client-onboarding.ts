import { z } from "zod";

import { clientCommandNameSchema, customClientSchema, customHookFileSchema, hookEventNameSchema, hookFieldPathSchema } from "./custom-client.js";

/**
 * The formats a 接入新工具 conversation may use, read off the schema a client is saved by: a format the engine learns
 * is one the assistant may propose, with nothing listed here.
 */
export const hookFormatSchema = customClientSchema.shape.hooks.shape.format;
const transcriptReply = customClientSchema.shape.reply.options.find(
  (option): option is Extract<typeof option, { shape: { format: unknown } }> => "format" in option.shape,
)!;
export const transcriptFormatSchema = transcriptReply.shape.format;
export const supportedHookFormats = (): string[] => [...hookFormatSchema.options];
export const supportedTranscriptFormats = (): string[] => [...transcriptFormatSchema.options];

/** How much one probe may record, and for how long: the bridge holds every probe to these whatever its marker says. */
export const CLIENT_PROBE_LIMITS = {
  /** One hook input, in bytes: one past it is not recorded. */
  inputBytes: 64 * 1_024,
  records: 20,
  lifetimeMs: 15 * 60_000,
  /** Transcript reads kept in one record (those that read the secret): past it, only how many more is said. */
  transcripts: 40,
} as const;

/** A probe's id, as its hook command names it: a client id's shape, so a probe's hook is taken for this app's. */
export const clientProbeIdSchema = z.string().regex(/^probe-[a-z0-9]{8,24}$/u);
export const clientProbeSecretSchema = z.string().regex(/^DECISION-[A-Z0-9]{4,12}$/u);

/** Written by the App under its own data before a probe's hooks go in; the bridge records an event only while it stands. */
export const clientProbeMarkerSchema = z
  .object({
    version: z.literal(1),
    id: clientProbeIdSchema,
    secret: clientProbeSecretSchema,
    hooks: z.object({ file: customHookFileSchema, format: hookFormatSchema }).strict(),
    events: z.array(hookEventNameSchema).min(1).max(8),
    createdAt: z.number().int().nonnegative(),
    expiresAt: z.number().int().nonnegative(),
  })
  .strict();
export type ClientProbeMarker = z.infer<typeof clientProbeMarkerSchema>;

/**
 * One event a probe saw, as the bridge wrote it: the input as the client sent it, and which transcript format, read off
 * which field, held the secret in its last reply. The transcript itself is not kept.
 */
export const clientProbeRecordSchema = z
  .object({
    event: hookEventNameSchema,
    receivedAt: z.number().int().nonnegative(),
    input: z.unknown(),
    transcripts: z
      .array(z.object({ field: hookFieldPathSchema, format: z.string().min(1).max(40), matched: z.boolean() }).strict())
      .max(CLIENT_PROBE_LIMITS.transcripts),
    /** Reads that held the secret past the limit, not kept. */
    transcriptsCut: z.number().int().nonnegative().optional(),
  })
  .strict();
export type ClientProbeRecord = z.infer<typeof clientProbeRecordSchema>;

export const ONBOARDING_MAX_MESSAGE_CHARS = 2_000;

export const onboardingSessionIdSchema = z.string().regex(/^onb-[a-z0-9]{6,32}$/u);

/**
 * The one card a confirmation answers: issued with it, and taken back by the App the moment it is answered, replaced,
 * or the conversation ends. An answer naming any other is refused.
 */
export const onboardingCardTokenSchema = z.string().regex(/^[a-z0-9]{16,32}$/u);

/** What the reader does in a 接入新工具 conversation: a message, or an answer to the card on show. */
export const onboardingEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("message"), text: z.string().trim().min(1).max(ONBOARDING_MAX_MESSAGE_CHARS) }).strict(),
  /** `none`: the tool has no command to run in a terminal; nothing is checked. */
  z.object({ type: z.literal("command"), token: onboardingCardTokenSchema, answer: z.enum(["confirm", "reject", "none"]) }).strict(),
  z.object({ type: z.literal("probe"), token: onboardingCardTokenSchema, answer: z.enum(["confirm", "reject"]) }).strict(),
  /** Waits for the probe on show to end (the App ends it, and takes it out, whether or not this is sent). */
  z.object({ type: z.literal("await-probe") }).strict(),
  /** Stops the wait and drops what it caught. */
  z.object({ type: z.literal("cancel-probe") }).strict(),
  /** Stops the wait and works out the fields from what it caught so far. */
  z.object({ type: z.literal("finish-probe") }).strict(),
  z.object({ type: z.literal("plan"), token: onboardingCardTokenSchema, answer: z.enum(["confirm", "reject"]) }).strict(),
  /** The conversation left for good (deleted): its probe, if any, goes. */
  z.object({ type: z.literal("close") }).strict(),
]);
export type OnboardingEvent = z.infer<typeof onboardingEventSchema>;

export const onboardingRequestSchema = z
  .object({
    /** None for a conversation's first message. */
    sessionId: onboardingSessionIdSchema.nullable(),
    profileId: z.string().min(1).max(200).optional(),
    event: onboardingEventSchema,
  })
  .strict();
export type OnboardingRequest = z.infer<typeof onboardingRequestSchema>;

export const onboardingEntrySchema = z
  .object({ role: z.enum(["user", "assistant", "notice"]), text: z.string().min(1).max(4_000) })
  .strict();
export type OnboardingEntry = z.infer<typeof onboardingEntrySchema>;

const readingText = z.string().max(4_000);

/** What the reader is asked to look at and confirm. A plan's preview is the reader's own sample, shown only to them. */
export const onboardingCardSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("command"),
      token: onboardingCardTokenSchema,
      command: clientCommandNameSchema,
      /** The program the name runs, as the PATH finds it now: what the reader confirms. None where it is not found. */
      path: z.string().max(2_000).nullable(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("probe"),
      token: onboardingCardTokenSchema,
      file: customHookFileSchema,
      format: hookFormatSchema,
      events: z.array(hookEventNameSchema).min(1).max(8),
    })
    .strict(),
  z
    .object({
      kind: z.literal("waiting"),
      /** What the reader sends in the tool. */
      phrase: z.string().min(1).max(200),
      file: customHookFileSchema,
      events: z.array(hookEventNameSchema).min(1).max(8),
      expiresAt: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("plan"),
      token: onboardingCardTokenSchema,
      client: customClientSchema,
      preview: z
        .object({
          prompt: readingText,
          reply: readingText,
          sessionId: readingText,
          cwd: readingText,
          turnId: readingText.nullable(),
          complete: z.boolean().nullable(),
        })
        .strict(),
    })
    .strict(),
]);
export type OnboardingCard = z.infer<typeof onboardingCardSchema>;

export const onboardingViewSchema = z
  .object({
    sessionId: onboardingSessionIdSchema,
    entries: z.array(onboardingEntrySchema).max(400),
    card: onboardingCardSchema.nullable(),
    /** `ended`: nothing more is sent (connected, given up on, or the App restarted since). */
    status: z.enum(["idle", "waiting", "ended"]),
    /** The model runs on this machine and is small: the reader is told it may not do well. */
    weakModel: z.boolean(),
  })
  .strict();
export type OnboardingView = z.infer<typeof onboardingViewSchema>;

/**
 * Each field of a hook input a client's description could name, as readHookField reads it: by dotted path, a list by
 * its first item (a list of objects by `.0.` into it). Keys no field path can hold are left out, as is anything past
 * the depth or the count.
 */
export const hookInputFields = (input: unknown, limits: { depth?: number; count?: number } = {}): { path: string; value: unknown }[] => {
  const depth = limits.depth ?? 5;
  const count = limits.count ?? 200;
  const fields: { path: string; value: unknown }[] = [];
  const visit = (value: unknown, path: string, level: number): void => {
    if (fields.length >= count) return;
    if (Array.isArray(value)) {
      const first: unknown = value[0];
      if (typeof first === "object" && first !== null && !Array.isArray(first)) visit(first, `${path}.0`, level);
      else if (path !== "") fields.push({ path, value: first });
      return;
    }
    if (typeof value === "object" && value !== null) {
      if (path !== "") fields.push({ path, value });
      if (level >= depth) return;
      for (const [key, child] of Object.entries(value)) {
        const next = path === "" ? key : `${path}.${key}`;
        if (hookFieldPathSchema.safeParse(next).success) visit(child, next, level + 1);
      }
      return;
    }
    if (path !== "") fields.push({ path, value });
  };
  visit(input, "", 0);
  return fields;
};
