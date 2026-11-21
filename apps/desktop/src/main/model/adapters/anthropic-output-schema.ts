import { ModelProviderError } from "../http-model-transport.js";

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const unsupportedConstraints = ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf", "minLength", "maxLength", "maxItems", "uniqueItems"];
const supportedFormats = new Set(["date-time", "time", "date", "duration", "email", "hostname", "uri", "ipv4", "ipv6", "uuid"]);

/** Wire-only simplification for Anthropic's schema subset; callers keep their existing local output validators. */
export const anthropicOutputSchema = (schema: Record<string, unknown>): Record<string, unknown> => {
  const convert = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(convert);
    if (!object(value)) return value;
    const node = { ...value };
    delete node.$schema;
    const constraints: Record<string, unknown> = {};
    const remove = (key: string): void => {
      if (key in node) { constraints[key] = node[key]; delete node[key]; }
    };
    for (const key of unsupportedConstraints) remove(key);
    if (node.minItems !== 0 && node.minItems !== 1) remove("minItems");
    if (typeof node.format === "string" && !supportedFormats.has(node.format)) remove("format");
    if (Object.keys(constraints).length > 0) node.description = [node.description, `Constraints: ${JSON.stringify(constraints)}`].filter(Boolean).join("\n");
    // Only schema positions are traversed: fields called maxItems, and literal defaults/enums, are data.
    for (const key of ["properties", "$defs", "definitions"]) {
      if (object(node[key])) node[key] = Object.fromEntries(Object.entries(node[key]).map(([name, child]) => [name, convert(child)]));
    }
    for (const key of ["items", "anyOf", "oneOf", "allOf"]) if (node[key] !== undefined) node[key] = convert(node[key]);
    if (node.type === "object" || (Array.isArray(node.type) && node.type.includes("object")) || object(node.properties)) {
      if (node.additionalProperties !== undefined && node.additionalProperties !== false) throw new ModelProviderError("invalid_configuration", "Anthropic structured output does not support dynamic object properties");
      node.additionalProperties = false;
    }
    return node;
  };
  return convert(schema) as Record<string, unknown>;
};
