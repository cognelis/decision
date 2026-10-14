import { expect, it } from "vitest";
import { z } from "zod";
import { codexOutputSchema, restoreCodexOptionalFields } from "../src/main/model/cli/codex-output-schema.js";
import { isStrictJsonSchema } from "../src/main/model/structured-provider.js";

it("makes nested review actions strict and restores omitted fields without weakening the original validator", () => {
  const logical = z.object({ actions: z.array(z.object({
    action: z.enum(["read_file", "finish_review"]), path: z.string().optional(), startLine: z.number().int().optional(),
    findings: z.array(z.object({ title: z.string(), detail: z.string().optional() }).strict()).optional(),
  }).strict()) }).strict();
  const schema = z.toJSONSchema(logical);
  const original = structuredClone(schema);
  const wire = codexOutputSchema(schema);
  expect(isStrictJsonSchema(wire)).toBe(true);
  expect(schema).toEqual(original);
  const restored = restoreCodexOptionalFields({ actions: [{ action: "finish_review", path: null, startLine: null, findings: [{ title: "问题", detail: null }] }] }, schema);
  expect(logical.parse(restored)).toEqual({ actions: [{ action: "finish_review", findings: [{ title: "问题" }] }] });
  expect(() => logical.parse(restoreCodexOptionalFields({ actions: [{ action: "invalid", path: null, startLine: null, findings: null }] }, schema))).toThrow();
});

it("preserves explicit optional nulls and required nulls through refs and discriminated unions", () => {
  const schema = { type: "object", properties: { items: { type: "array", items: { anyOf: [
    { $ref: "#/$defs/text" }, { $ref: "#/$defs/clear" },
  ] } } }, required: ["items"], additionalProperties: false, $defs: {
    text: { type: "object", properties: { kind: { const: "text" }, note: { type: "string" } }, required: ["kind"], additionalProperties: false },
    clear: { type: "object", properties: { kind: { const: "clear" }, note: { type: ["string", "null"] }, optional: { anyOf: [{ type: "string" }, { type: "null" }] } }, required: ["kind", "note"], additionalProperties: false },
  } };
  expect(isStrictJsonSchema(codexOutputSchema(schema))).toBe(true);
  expect(restoreCodexOptionalFields({ items: [{ kind: "text", note: null }, { kind: "clear", note: null, optional: null }] }, schema)).toEqual({ items: [{ kind: "text" }, { kind: "clear", note: null, optional: null }] });
});

it("does not silently close a dynamic dictionary and does not strip unknown fields or required nulls", () => {
  expect(() => codexOutputSchema({ type: "object", additionalProperties: { type: "string" } })).toThrow("dynamic object");
  const schema = { type: "object", properties: { name: { type: "string" } }, required: ["name"], additionalProperties: false };
  expect(restoreCodexOptionalFields({ name: null, extra: null }, schema)).toEqual({ name: null, extra: null });
});

it("prefers a union branch that already permits explicit nulls over deleting them for another branch", () => {
  const schema = { anyOf: [
    { type: "object", properties: { note: { type: "string" } }, required: [], additionalProperties: false },
    { type: "object", properties: { note: { type: ["string", "null"] } }, required: ["note"], additionalProperties: false },
  ] };
  expect(restoreCodexOptionalFields({ note: null }, schema)).toEqual({ note: null });
});
