import { ModelProviderError } from "../http-model-transport.js";

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

/** Codex always enforces strict output schemas; omitted fields must be represented by nullable required fields. */
export const codexOutputSchema = (schema: Record<string, unknown>): Record<string, unknown> => {
  const convert = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(convert);
    if (!object(value)) return value;
    const node = { ...value };
    for (const key of ["$defs", "definitions"]) if (object(node[key])) node[key] = Object.fromEntries(Object.entries(node[key]).map(([name, child]) => [name, convert(child)]));
    for (const key of ["items", "anyOf", "oneOf", "allOf"]) if (node[key] !== undefined) node[key] = convert(node[key]);
    if (node.type === "object" || (Array.isArray(node.type) && node.type.includes("object")) || object(node.properties)) {
      if (node.additionalProperties !== undefined && node.additionalProperties !== false) throw new ModelProviderError("invalid_configuration", "Codex strict output does not support dynamic object properties");
      const required = Array.isArray(node.required) ? node.required : [];
      const properties = object(node.properties) ? node.properties : {};
      node.properties = Object.fromEntries(Object.entries(properties).map(([key, child]) => [key,
        required.includes(key) ? convert(child) : { anyOf: [convert(child), { type: "null" }] }]));
      node.required = Object.keys(properties);
      node.additionalProperties = false;
    }
    return node;
  };
  return convert(schema) as Record<string, unknown>;
};

/** Remove only synthetic nulls for optional non-nullable fields. Explicit nulls (for example clearing an outcome) survive. */
export const restoreCodexOptionalFields = (value: unknown, schema: Record<string, unknown>): unknown => {
  const resolve = (node: unknown): unknown => {
    const seen = new Set<string>();
    while (object(node) && typeof node.$ref === "string") {
      const ref = node.$ref;
      if (!ref.startsWith("#/") || seen.has(ref)) return node;
      seen.add(ref);
      node = ref.slice(2).split("/").reduce<unknown>((at, part) => object(at) ? at[part.replace(/~1/gu, "/").replace(/~0/gu, "~")] : undefined, schema);
    }
    return node;
  };
  const nullable = (source: unknown): boolean => {
    const node = resolve(source);
    if (!object(node)) return node === true;
    if ("const" in node) return node.const === null;
    if (Array.isArray(node.enum)) return node.enum.includes(null);
    if (Array.isArray(node.anyOf)) return node.anyOf.some(nullable);
    if (Array.isArray(node.oneOf)) return node.oneOf.filter(nullable).length === 1;
    if (Array.isArray(node.allOf)) return node.allOf.every(nullable);
    return node.type === undefined ? node.$ref === undefined : node.type === "null" || (Array.isArray(node.type) && node.type.includes("null"));
  };
  const matches = (value: unknown, source: unknown, syntheticNulls = true): boolean => {
    const node = resolve(source);
    if (!object(node)) return node === true;
    if ("const" in node && node.const !== value) return false;
    if (Array.isArray(node.enum) && !node.enum.includes(value)) return false;
    const type = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
    const types = Array.isArray(node.type) ? node.type : node.type === undefined ? [] : [node.type];
    if (types.length && !types.includes(type) && !(types.includes("integer") && typeof value === "number" && Number.isInteger(value))) return false;
    if (object(value) && object(node.properties)) {
      const required = Array.isArray(node.required) ? node.required : [];
      if (required.some(key => typeof key === "string" && !(key in value))) return false;
      return Object.entries(node.properties).every(([key, child]) => !(key in value) || (syntheticNulls && value[key] === null && !required.includes(key)) || matches(value[key], child, syntheticNulls));
    }
    if (Array.isArray(node.anyOf)) return node.anyOf.some(child => matches(value, child, syntheticNulls));
    return true;
  };
  const restore = (value: unknown, source: unknown): unknown => {
    const node = resolve(source);
    if (!object(node)) return value;
    const alternatives = node.anyOf ?? node.oneOf;
    if (Array.isArray(alternatives)) {
      const branch = alternatives.find(child => matches(value, child, false)) ?? alternatives.find(child => matches(value, child));
      return branch === undefined ? value : restore(value, branch);
    }
    if (Array.isArray(node.allOf)) value = node.allOf.reduce<unknown>((result, child) => restore(result, child), value);
    if (Array.isArray(value)) return value.map((entry, index) => restore(entry, Array.isArray(node.items) ? node.items[index] : node.items));
    if (!object(value) || !object(node.properties)) return value;
    const properties = node.properties;
    const required = Array.isArray(node.required) ? node.required : [];
    return Object.fromEntries(Object.entries(value).flatMap(([key, entry]) =>
      key in properties && entry === null && !required.includes(key) && !nullable(properties[key]) ? [] : [[key, restore(entry, properties[key])]]));
  };
  return restore(value, schema);
};
