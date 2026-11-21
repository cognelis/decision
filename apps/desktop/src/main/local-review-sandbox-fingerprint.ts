import { randomBytes, randomInt } from "node:crypto";
import { z } from "zod";

export const reviewSandboxFingerprintSchema = z.object({
  names: z.array(z.string().regex(/^[a-f0-9]{64}$/u)).length(32),
  allowed: z.array(z.boolean()).length(32),
}).strict().refine(value => new Set(value.names).size === 32 && value.allowed.filter(Boolean).length >= 8 && value.allowed.filter(Boolean).length <= 24, "沙箱指纹必须包含唯一随机名称及至少各 8 位允许/拒绝。");
export type ReviewSandboxFingerprint = z.infer<typeof reviewSandboxFingerprintSchema>;
export function createReviewSandboxFingerprint(): ReviewSandboxFingerprint {
  const names: string[] = [];
  while (names.length < 32) { const value = randomBytes(32).toString("hex"); if (!names.includes(value)) names.push(value); }
  let allowed: boolean[];
  do { allowed = Array.from({ length: 32 }, () => randomInt(2) === 1); } while (allowed.filter(Boolean).length < 8 || allowed.filter(Boolean).length > 24);
  return { names, allowed };
}
/** Names are never registered. These rules must follow all baseline Mach rules. */
export function reviewSandboxFingerprintRules(fingerprint: ReviewSandboxFingerprint): string[] {
  const checked = reviewSandboxFingerprintSchema.parse(fingerprint);
  return checked.names.map((name, index) => `(${checked.allowed[index] ? "allow" : "deny"} mach-lookup (global-name ${JSON.stringify(name)}))`);
}
