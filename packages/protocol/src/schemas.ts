import { z } from "zod";

export const PROTOCOL_VERSION = 1 as const;

export const runtimeDescriptorSchema = z
  .object({
    protocolVersion: z.literal(PROTOCOL_VERSION),
    port: z.number().int().min(1_024).max(65_535),
    token: z.string().min(32).max(512),
    pid: z.number().int().positive(),
    startedAt: z.string().datetime(),
  })
  .strict();

export type RuntimeDescriptor = z.infer<
  typeof runtimeDescriptorSchema
>;
