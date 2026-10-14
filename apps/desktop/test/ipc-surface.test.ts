import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

/**
 * `DecisionApi` (what the renderer may call) and `DecisionIpcOperations` (what
 * main must answer) are two hand-written interfaces describing one set of ~95
 * operations. TypeScript only notices a mismatch where the two are wired
 * together, which is late and, for an operation nobody wired yet, never.
 *
 * Adding a capability already costs four edits across four files. This makes
 * the third and fourth of them tell you immediately, and forces every
 * divergence to be a named one rather than an oversight.
 */

const RENDERER_ONLY = new Set([
  // Push subscriptions, not request/response operations: main sends these.
  "onSnapshot",
  "onAssistantProgress",
  "onPrReviewProgress",
  // Served by the rationale queue rather than the operations object.
  "submitRationale",
  "retryPersistence",
]);

const MAIN_ONLY = new Set([
  // Reached through the rationale queue's own channels, not the renderer API.
  "completeDeferredRationale",
  "discardDeferredRationale",
  "skipDeferredRationale",
  "keepLocalRationale",
  "validateDecisionAppliedPrinciples",
]);

/** Member names declared directly in one interface body. */
const membersOf = (source: string, name: string): Set<string> => {
  const start = source.indexOf(`interface ${name}`);
  if (start < 0) throw new Error(`interface ${name} not found`);
  const open = source.indexOf("{", start);
  let depth = 0;
  let cursor = open;
  while (cursor < source.length) {
    if (source[cursor] === "{") depth += 1;
    else if (source[cursor] === "}") {
      depth -= 1;
      if (depth === 0) break;
    }
    cursor += 1;
  }
  const body = source.slice(open, cursor);
  // Two-space indent is the interface's own members; deeper lines belong to
  // nested object types and are not operations.
  return new Set(
    [...body.matchAll(/^ {2}([a-zA-Z][A-Za-z0-9]*)\??[(:]/gmu)].map(
      (match) => match[1]!,
    ),
  );
};

const surfaces = async (): Promise<{
  renderer: Set<string>;
  main: Set<string>;
}> => {
  const [rendererSource, mainSource] = await Promise.all([
    readFile("apps/desktop/src/shared/renderer-api.ts", "utf8"),
    readFile("apps/desktop/src/main/ipc.ts", "utf8"),
  ]);
  return {
    renderer: membersOf(rendererSource, "DecisionApi"),
    main: membersOf(mainSource, "DecisionIpcOperations"),
  };
};

describe("IPC surface", () => {
  it("keeps the renderer API and the main operations in correspondence", async () => {
    const { renderer, main } = await surfaces();

    const unmatchedRenderer = [...renderer].filter(
      (name) => !main.has(name) && !RENDERER_ONLY.has(name),
    );
    const unmatchedMain = [...main].filter(
      (name) => !renderer.has(name) && !MAIN_ONLY.has(name),
    );

    // Naming the strays is the point: a count would say the surfaces drifted,
    // this says which operation has nobody on the other end.
    expect({ unmatchedRenderer, unmatchedMain }).toEqual({
      unmatchedRenderer: [],
      unmatchedMain: [],
    });
  });

  it("keeps every documented exception real", async () => {
    const { renderer, main } = await surfaces();

    // An exception list that outlives what it excused quietly starts excusing
    // something else.
    expect([...RENDERER_ONLY].filter((name) => !renderer.has(name))).toEqual([]);
    expect([...MAIN_ONLY].filter((name) => !main.has(name))).toEqual([]);
    expect([...RENDERER_ONLY].filter((name) => main.has(name))).toEqual([]);
    expect([...MAIN_ONLY].filter((name) => renderer.has(name))).toEqual([]);
  });
});
