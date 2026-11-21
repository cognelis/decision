import { describe, expect, it } from "vitest";
import { z } from "zod";
import { anthropicOutputSchema } from "../src/main/model/adapters/anthropic-output-schema.js";
import { semanticOutputJsonSchema } from "../src/main/model/semantic-prompt.js";

describe("Anthropic output schemas", () => {
  it("adapts the health-check schema without changing the schema other providers use", () => {
    const original = structuredClone(semanticOutputJsonSchema);
    const result = anthropicOutputSchema(semanticOutputJsonSchema);
    expect(result).toMatchObject({
      required: original.required,
      additionalProperties: false,
      properties: {
        question: { type: ["string", "null"], description: 'Constraints: {"maxLength":160}' },
        optionLabels: { type: "array", description: 'Constraints: {"maxItems":8}', items: { type: "string", description: 'Constraints: {"maxLength":80}' } },
      },
    });
    const properties = result.properties as Record<string, Record<string, unknown>>;
    expect(properties.question).not.toHaveProperty("maxLength");
    expect(properties.optionLabels).not.toHaveProperty("maxItems");
    expect(properties.optionLabels!.items).not.toHaveProperty("maxLength");
    expect(semanticOutputJsonSchema).toEqual(original);
  });

  it("adapts nested Zod bounds and retains them alongside existing descriptions", () => {
    const schema = z.toJSONSchema(z.object({
      entries: z.array(z.object({ score: z.number().min(0).max(1), title: z.string().min(1).max(80).describe("Exact title") })).min(2).max(4),
    }));
    const original = structuredClone(schema);
    const result = anthropicOutputSchema(schema);
    expect(result).not.toHaveProperty("$schema");
    expect(result).toMatchObject({ properties: { entries: {
      description: 'Constraints: {"maxItems":4,"minItems":2}',
      items: { additionalProperties: false, properties: {
        score: { type: "number", description: 'Constraints: {"minimum":0,"maximum":1}' },
        title: { type: "string", description: 'Exact title\nConstraints: {"minLength":1,"maxLength":80}' },
      } },
    } } });
    const entry = (result.properties as Record<string, Record<string, unknown>>).entries!;
    expect(entry).not.toHaveProperty("minItems");
    expect(entry).not.toHaveProperty("maxItems");
    expect(schema).toEqual(original);
  });

  it.each([0, 1])("keeps the supported minItems=%s constraint", (minItems) => {
    expect(anthropicOutputSchema({ type: "array", minItems, items: { type: "string" } })).toEqual({ type: "array", minItems, items: { type: "string" } });
  });

  it("traverses schema definitions and unions without changing field names, references or literal values", () => {
    const literal = { maxItems: 2, minimum: 1 };
    const result = anthropicOutputSchema({
      type: "object", required: ["maxItems"], properties: { maxItems: { type: "integer", minimum: 1, default: 2 } },
      $defs: { bounded: { type: "string", maxLength: 5 } },
      definitions: { bounded: { type: "number", exclusiveMinimum: 0, multipleOf: 2 } },
      anyOf: [{ $ref: "#/$defs/bounded" }, { type: "array", uniqueItems: true, items: { type: "string", format: "regex" } }],
      const: literal, default: literal, enum: [literal],
    });
    expect(result).toMatchObject({
      properties: { maxItems: { type: "integer", default: 2, description: 'Constraints: {"minimum":1}' } },
      $defs: { bounded: { type: "string", description: 'Constraints: {"maxLength":5}' } },
      definitions: { bounded: { type: "number", description: 'Constraints: {"exclusiveMinimum":0,"multipleOf":2}' } },
      anyOf: [{ $ref: "#/$defs/bounded" }, { type: "array", description: 'Constraints: {"uniqueItems":true}', items: { type: "string", description: 'Constraints: {"format":"regex"}' } }],
      required: ["maxItems"], const: literal, default: literal, enum: [literal],
    });
    expect(anthropicOutputSchema({ type: "string", format: "uuid" })).toEqual({ type: "string", format: "uuid" });
  });

  it("refuses dynamic object properties instead of silently losing their values", () => {
    expect(() => anthropicOutputSchema({ type: "object", additionalProperties: { type: "string" } }))
      .toThrow("Anthropic structured output does not support dynamic object properties");
  });
});
