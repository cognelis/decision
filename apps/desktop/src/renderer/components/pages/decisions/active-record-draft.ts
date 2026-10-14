import { z } from "zod";

const key = "decision.active-record.draft.v1";
const text = z.string().max(32_000);
const draftSchema = z.object({
  version: z.literal(1),
  kind: z.enum(["decision", "preference", "idea"]),
  title: text, content: text, project: text, rationale: text,
  expectedOutcome: text, reviewDueDate: text,
  appliesWhen: text, exceptions: text, whyInteresting: text, nextTest: text,
  sourceKind: z.enum(["app_manual", "offline_conversation", "meeting", "observation"]),
  strength: z.enum(["hard_constraint", "default", "weak_signal"]),
  // As typed; absent from a draft kept before languages were.
  languages: text.optional(),
});

export type ActiveRecordFormDraft = z.infer<typeof draftSchema>;

export const loadActiveRecordDraft = (): {
  value: ActiveRecordFormDraft | null;
  error: string | null;
} => {
  try {
    const raw = localStorage.getItem(key);
    return { value: raw === null ? null : draftSchema.parse(JSON.parse(raw)), error: null };
  } catch {
    return { value: null, error: "无法读取本机草稿，本次内容不会自动保存。请完成记录后再关闭。" };
  }
};

export const saveActiveRecordDraft = (input: ActiveRecordFormDraft): void => {
  localStorage.setItem(key, JSON.stringify(draftSchema.parse(input)));
};

export const clearActiveRecordDraft = (): void => {
  localStorage.removeItem(key);
};
