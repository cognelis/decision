import { describe, expect, it } from "vitest";

import { ModelProviderError } from "../src/main/model/http-model-transport.js";
import { buildSemanticUserPrompt, semanticOutputJsonSchema } from "../src/main/model/semantic-prompt.js";
import { isStrictJsonSchema, parseStructuredJson } from "../src/main/model/structured-provider.js";

describe("buildSemanticUserPrompt", () => {
  it("never cuts an emoji in half where it shortens a turn", () => {
    const prompt = buildSemanticUserPrompt({
      pairId: "pair-1",
      // The last 1,800 characters start inside 🚀; the first 700 of the answer end inside 😀.
      assistantText: `🚀${"问".repeat(1_799)}`,
      userText: `${"答".repeat(699)}😀后面`,
      locale: "zh-CN",
    });
    // Half a surrogate pair is what stricter APIs refuse the whole request over.
    expect(prompt).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
  });
});

describe("isStrictJsonSchema", () => {
  it("takes only schemas whose every object requires all it has and allows nothing else", () => {
    expect(isStrictJsonSchema(semanticOutputJsonSchema)).toBe(true);
    const closed = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({
      type: "object", additionalProperties: false, properties, required,
    });
    expect(isStrictJsonSchema(closed({ items: { type: "array", items: closed({ id: { type: "string" } }) } }))).toBe(true);
    // The assistant's step: one required key of five. OpenAI refuses it as strict before the model runs.
    expect(isStrictJsonSchema(closed({ action: { type: "string" }, query: { type: "string" } }, ["action"]))).toBe(false);
    expect(isStrictJsonSchema({ type: "object", properties: { title: { type: "string" } }, required: ["title"] })).toBe(false);
    expect(isStrictJsonSchema(closed({ list: { type: "array", items: { type: "object", properties: {} } } }))).toBe(false);
    expect(isStrictJsonSchema(closed({ choice: { anyOf: [{ type: "string" }, closed({ a: { type: "integer" } }, [])] } }))).toBe(false);
  });
});

const diagnosticFor = (
  visibleOutput: string,
  finishReason?: string | null,
): string => {
  try {
    parseStructuredJson(visibleOutput, undefined, finishReason);
  } catch (error) {
    return (error as ModelProviderError).diagnosticExcerpt;
  }
  throw new Error("expected malformed output to be rejected");
};

describe("parseStructuredJson", () => {
  it("returns the parsed document when the output is JSON", () => {
    expect(parseStructuredJson('{"action":"answer"}')).toEqual({
      action: "answer",
    });
  });

  it("says which way the output was malformed", () => {
    // A trace that says only "malformed" tells the reader the one thing they
    // already knew. These three failures need three different fixes.
    expect(diagnosticFor('```json\n{"action":"answer"}\n```')).toContain(
      "wrapped in a markdown fence",
    );
    expect(diagnosticFor('{"action":"answer"')).toContain(
      "stops before it closes",
    );
    expect(diagnosticFor("我建议先检索一次。")).toContain(
      "never opens as JSON",
    );
  });

  it("carries the provider's finish reason when it reports one", () => {
    // Shape says the JSON stopped early; only the provider can say whether it
    // stopped because the output budget ran out. Together they name the fix.
    expect(diagnosticFor('{"action":"ans', "length")).toContain(
      "finish_reason=length",
    );
    expect(diagnosticFor('{"action":"ans')).not.toContain("finish_reason");
    expect(diagnosticFor('{"action":"ans', null)).not.toContain(
      "finish_reason",
    );
  });

  it("carries what the failed call cost, when the provider reported it", () => {
    // A call that was billed and then rejected is filed as costing nothing
    // otherwise — and it is exactly the call whose token counts explain why
    // the output was cut off.
    const usage = {
      source: "provider_reported" as const,
      inputTokens: 9_152,
      outputTokens: 3_072,
      reasoningOutputTokens: 3_000,
      totalTokens: 12_224,
    };
    try {
      parseStructuredJson('{"action":"ans', undefined, "length", usage);
    } catch (error) {
      expect((error as ModelProviderError).usage).toEqual(usage);
      return;
    }
    throw new Error("expected malformed output to be rejected");
  });

  it("keeps the unusable output itself, apart from the diagnostic", () => {
    // The shape line says it opens and closes as JSON and still will not
    // parse; only the text itself says why. It rides on `visibleOutput`, which
    // reaches the trace's content-gated `output` field rather than the
    // diagnostic that survives with trace content switched off.
    const answer = '{"action":"answer","answer":"第一行\n第二行"}';
    try {
      parseStructuredJson(answer);
    } catch (error) {
      const failure = error as ModelProviderError;
      expect(failure.visibleOutput).toBe(answer);
      expect(failure.diagnosticExcerpt).not.toContain("第一行");
      return;
    }
    throw new Error("expected malformed output to be rejected");
  });

  it("describes the output without quoting it", () => {
    // `diagnosticExcerpt` survives with trace content turned off, so it may
    // report shape and length and never a character of what the model wrote.
    const secret = '{"answer":"部署密钥在 vault/prod 里"';
    const diagnostic = diagnosticFor(secret);
    expect(diagnostic).toContain(`length=${secret.length}`);
    expect(diagnostic).not.toContain("vault");
    expect(diagnostic).not.toContain("部署");
  });
});
