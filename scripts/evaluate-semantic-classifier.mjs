#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { readDecisionEnvironment } from "../config/decision-environment.mjs";

const HIGH_PRECISION_THRESHOLD = 0.95;
const HIGH_MEDIUM_RECALL_THRESHOLD = 0.9;
const BANDS = ["high", "medium", "low"];

const ratio = (numerator, denominator, empty = 1) =>
  denominator === 0 ? empty : numerator / denominator;

const fixed = (value) => Number(value.toFixed(6));

const validateSample = (sample) => {
  if (
    sample === null ||
    typeof sample !== "object" ||
    typeof sample.id !== "string" ||
    !["codex", "claude-code"].includes(sample.sourceClient) ||
    !["zh-CN", "en"].includes(sample.locale) ||
    typeof sample.assistantText !== "string" ||
    typeof sample.userText !== "string" ||
    !BANDS.includes(sample.expectedBand) ||
    !["answers", "mixed", "new_task", "uncertain"].includes(
      sample.expectedRelation,
    )
  ) {
    throw new Error("Semantic evaluation sample is invalid");
  }
};

const validatePrediction = (prediction) => {
  if (
    prediction === null ||
    typeof prediction !== "object" ||
    !BANDS.includes(prediction.band) ||
    !["answers", "mixed", "new_task", "uncertain"].includes(
      prediction.relation,
    ) ||
    !(
      prediction.question === null ||
      typeof prediction.question === "string"
    ) ||
    !(
      prediction.answerExcerpt === null ||
      typeof prediction.answerExcerpt === "string"
    )
  ) {
    throw new Error("Semantic evaluation prediction is invalid");
  }
  if (
    prediction.provider !== undefined &&
    (typeof prediction.provider !== "string" ||
      prediction.provider.trim().length === 0 ||
      prediction.provider.length > 200)
  ) {
    throw new Error("Semantic evaluation provider is invalid");
  }
  if (
    prediction.latencyMs !== undefined &&
    (!Number.isInteger(prediction.latencyMs) ||
      prediction.latencyMs < 0 ||
      prediction.latencyMs > 120_000)
  ) {
    throw new Error("Semantic evaluation latency is invalid");
  }
  if (prediction.usage !== undefined) {
    const usage = prediction.usage;
    const tokenFields = [
      "inputTokens",
      "cachedInputTokens",
      "outputTokens",
      "reasoningOutputTokens",
      "totalTokens",
    ];
    if (
      usage === null ||
      typeof usage !== "object" ||
      ![
        "provider_reported",
        "runtime_measured",
        "estimated",
        "unavailable",
      ].includes(usage.source) ||
      tokenFields.some(
        (field) =>
          usage[field] !== undefined &&
          (!Number.isInteger(usage[field]) ||
            usage[field] < 0),
      ) ||
      (usage.costUsd !== undefined &&
        (typeof usage.costUsd !== "number" ||
          !Number.isFinite(usage.costUsd) ||
          usage.costUsd < 0))
    ) {
      throw new Error(
        "Semantic evaluation token usage is invalid",
      );
    }
  }
};

const metricsFor = (rows) => {
  const predictedHigh = rows.filter(
    ({ prediction }) => prediction.band === "high",
  );
  const expectedPositive = rows.filter(
    ({ sample }) => sample.expectedBand !== "low",
  );
  const detectedPositive = expectedPositive.filter(
    ({ prediction }) => prediction.band !== "low",
  );
  const trueHigh = predictedHigh.filter(
    ({ sample }) => sample.expectedBand !== "low",
  );
  const relationCorrect = rows.filter(
    ({ sample, prediction }) =>
      sample.expectedRelation === prediction.relation,
  );
  const predictedQuestions = rows.filter(
    ({ prediction }) => prediction.question !== null,
  );
  const locatedQuestions = predictedQuestions.filter(
    ({ sample, prediction }) =>
      sample.assistantText.includes(prediction.question),
  );
  const predictedAnswers = rows.filter(
    ({ prediction }) => prediction.answerExcerpt !== null,
  );
  const locatedAnswers = predictedAnswers.filter(
    ({ sample, prediction }) =>
      sample.userText.includes(prediction.answerExcerpt),
  );

  return {
    samples: rows.length,
    highPrecision: fixed(
      ratio(trueHigh.length, predictedHigh.length),
    ),
    highMediumRecall: fixed(
      ratio(
        detectedPositive.length,
        expectedPositive.length,
      ),
    ),
    relationAccuracy: fixed(
      ratio(relationCorrect.length, rows.length),
    ),
    questionExtractability: fixed(
      ratio(
        locatedQuestions.length,
        predictedQuestions.length,
      ),
    ),
    answerExtractability: fixed(
      ratio(
        locatedAnswers.length,
        predictedAnswers.length,
      ),
    ),
  };
};

const slicesFor = (rows, field) => {
  const values = [
    ...new Set(rows.map(({ sample }) => sample[field])),
  ].sort();
  return Object.fromEntries(
    values.map((value) => [
      value,
      metricsFor(
        rows.filter(({ sample }) => sample[field] === value),
      ),
    ]),
  );
};

const sumPresent = (values) => {
  const present = values.filter(
    (value) => typeof value === "number",
  );
  return present.length === 0
    ? null
    : fixed(present.reduce((total, value) => total + value, 0));
};

const median = (values) => {
  const sorted = values
    .filter((value) => typeof value === "number")
    .sort((left, right) => left - right);
  if (sorted.length === 0) {
    return null;
  }
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? fixed((sorted[middle - 1] + sorted[middle]) / 2)
    : sorted[middle];
};

const providerMetricsFor = (provider, rows) => {
  const usages = rows.map(
    ({ prediction }) => prediction.usage,
  );
  return {
    provider,
    ...metricsFor(rows),
    medianLatencyMs: median(
      rows.map(({ prediction }) => prediction.latencyMs),
    ),
    inputTokens: sumPresent(
      usages.map((usage) => usage?.inputTokens),
    ),
    outputTokens: sumPresent(
      usages.map((usage) => usage?.outputTokens),
    ),
    totalTokens: sumPresent(
      usages.map((usage) => usage?.totalTokens),
    ),
    costUsd: sumPresent(
      usages.map((usage) => usage?.costUsd),
    ),
    tokenUsageUnavailable: usages.filter(
      (usage) =>
        usage === undefined ||
        usage.source === "unavailable",
    ).length,
  };
};

const providersFor = (rows) => {
  const providers = [
    ...new Set(
      rows
        .map(({ prediction }) => prediction.provider)
        .filter((value) => value !== undefined),
    ),
  ].sort();
  return Object.fromEntries(
    providers.map((provider) => [
      provider,
      providerMetricsFor(
        provider,
        rows.filter(
          ({ prediction }) =>
            prediction.provider === provider,
        ),
      ),
    ]),
  );
};

export const evaluateSemanticCorpus = async ({
  samples,
  predictor,
}) => {
  if (!Array.isArray(samples) || typeof predictor !== "function") {
    throw new Error("Semantic evaluation input is invalid");
  }
  const ids = new Set();
  const rows = [];
  for (const sample of samples) {
    validateSample(sample);
    if (ids.has(sample.id)) {
      throw new Error(`Duplicate semantic sample: ${sample.id}`);
    }
    ids.add(sample.id);
    const prediction = await predictor(
      Object.freeze({ ...sample }),
    );
    validatePrediction(prediction);
    rows.push({
      sample,
      prediction: { ...prediction },
    });
  }

  const summaryMetrics = metricsFor(rows);
  const confusion = Object.fromEntries(
    BANDS.map((expected) => [
      expected,
      Object.fromEntries(
        BANDS.map((predicted) => [
          predicted,
          rows.filter(
            ({ sample, prediction }) =>
              sample.expectedBand === expected &&
              prediction.band === predicted,
          ).length,
        ]),
      ),
    ]),
  );
  const thresholdsMet =
    summaryMetrics.highPrecision >=
      HIGH_PRECISION_THRESHOLD &&
    summaryMetrics.highMediumRecall >=
      HIGH_MEDIUM_RECALL_THRESHOLD;
  return {
    version: 1,
    thresholds: {
      highPrecision: HIGH_PRECISION_THRESHOLD,
      highMediumRecall: HIGH_MEDIUM_RECALL_THRESHOLD,
    },
    summary: {
      ...summaryMetrics,
      thresholdsMet,
    },
    confusion,
    providers: providersFor(rows),
    slices: {
      locale: slicesFor(rows, "locale"),
      sourceClient: slicesFor(rows, "sourceClient"),
    },
  };
};

export const evaluationExitCode = (
  report,
  { reportOnly = false } = {},
) => (reportOnly || report.summary.thresholdsMet ? 0 : 1);

const percentage = (value) => `${(value * 100).toFixed(1)}%`;

export const formatHumanReport = (report) => {
  const lines = [
    "Decision semantic evaluation",
    "",
    `Samples              ${report.summary.samples}`,
    `High precision       ${percentage(report.summary.highPrecision)} (target ${percentage(report.thresholds.highPrecision)})`,
    `High+medium recall   ${percentage(report.summary.highMediumRecall)} (target ${percentage(report.thresholds.highMediumRecall)})`,
    `Relation accuracy    ${percentage(report.summary.relationAccuracy)}`,
    `Question located     ${percentage(report.summary.questionExtractability)}`,
    `Answer located       ${percentage(report.summary.answerExtractability)}`,
    `Activation threshold ${report.summary.thresholdsMet ? "PASS" : "NOT MET"}`,
  ];
  for (const provider of Object.values(
    report.providers ?? {},
  )) {
    lines.push(
      "",
      `Provider ${provider.provider}`,
      `  Samples            ${provider.samples}`,
      `  Median latency     ${
        provider.medianLatencyMs === null
          ? "unavailable"
          : `${provider.medianLatencyMs} ms`
      }`,
      `  Tokens             ${
        provider.inputTokens === null
          ? "unavailable"
          : `${provider.inputTokens} input / ${provider.outputTokens ?? 0} output`
      }`,
      `  Usage unavailable  ${provider.tokenUsageUnavailable}`,
    );
  }
  return lines.join("\n");
};

const mixedAnswer = (value) =>
  /(?:另外|同时|顺便|并且|以及|also|and (?:also|then|please|explain|why))/iu.test(
    value,
  );

const relationFromRule = (completed, userText) => {
  if (completed.signals.includes("unrelated_new_task")) {
    return "new_task";
  }
  if (completed.signals.includes("answer_is_mixed")) {
    return "mixed";
  }
  if (completed.signals.includes("answer_relation_uncertain")) {
    return "uncertain";
  }
  return mixedAnswer(userText) ? "mixed" : "answers";
};

export const createRulePredictor = async () => {
  const repositoryRoot = fileURLToPath(
    new URL("../", import.meta.url),
  );
  const { createServer } = await import("vite");
  const server = await createServer({
    root: repositoryRoot,
    configFile: false,
    appType: "custom",
    logLevel: "silent",
    server: { middlewareMode: true },
    resolve: {
      alias: {
        "@cognelis/decision-protocol": resolve(
          repositoryRoot,
          "packages/protocol/src/index.ts",
        ),
      },
    },
  });
  const core = await server.ssrLoadModule(
    resolve(
      repositoryRoot,
      "packages/core/src/text-decision-analyzer.ts",
    ),
  );
  const analyzer = new core.TextDecisionAnalyzer();
  return {
    predict: async (sample) => {
      const pending = analyzer.analyze({
        userText: sample.taskBackground ?? null,
        assistantText: sample.assistantText,
      });
      if (pending === null) {
        return {
          band: "low",
          relation: "new_task",
          question: null,
          answerExcerpt: null,
        };
      }
      const completed = analyzer.complete(
        pending,
        sample.userText,
      );
      const relation = relationFromRule(
        completed,
        sample.userText,
      );
      return {
        band: completed.band,
        relation,
        question: completed.question,
        answerExcerpt:
          relation === "new_task" ? null : sample.userText,
      };
    },
    close: () => server.close(),
  };
};

export const createProviderPredictor = ({
  provider,
  rulePredictor,
  invoke,
  validateClassification,
  routeDecision,
}) => {
  if (
    typeof provider !== "string" ||
    provider.length === 0 ||
    typeof rulePredictor !== "function" ||
    typeof invoke !== "function" ||
    typeof validateClassification !== "function" ||
    typeof routeDecision !== "function"
  ) {
    throw new Error(
      "Semantic provider predictor configuration is invalid",
    );
  }
  return async (sample) => {
    const rule = await rulePredictor(sample);
    const attempt = await invoke({
      pairId: sample.id,
      assistantText: sample.assistantText,
      userText: sample.userText,
      locale: sample.locale,
    });
    const classification = validateClassification(
      {
        assistantText: sample.assistantText,
        userText: sample.userText,
      },
      attempt.classification,
    );
    const route = routeDecision({
      ruleBand: rule.band,
      modelBand: classification.band,
      answerRelation: classification.answerRelation,
    });
    return {
      band: route.finalBand,
      relation: classification.answerRelation,
      question: classification.question,
      answerExcerpt: classification.answerExcerpt,
      provider,
      latencyMs: Math.max(
        0,
        Math.min(
          120_000,
          Math.round(attempt.providerDurationMs),
        ),
      ),
      usage: attempt.usage,
    };
  };
};

const defaultUserData = () => {
  if (process.platform === "darwin") {
    return join(
      homedir(),
      "Library",
      "Application Support",
      "Decision",
    );
  }
  if (process.platform === "win32") {
    return join(
      process.env.APPDATA ??
        join(homedir(), "AppData", "Roaming"),
      "Decision",
    );
  }
  return join(
    process.env.XDG_CONFIG_HOME ??
      join(homedir(), ".config"),
    "decision",
  );
};

const createConfiguredCliPredictor = async ({
  provider,
  userData,
}) => {
  const profilePath = join(
    userData,
    "model-provider-profiles.json",
  );
  const document = JSON.parse(
    await readFile(profilePath, "utf8"),
  );
  const profiles = Array.isArray(document.profiles)
    ? document.profiles
    : [];
  const exact = profiles.find(
    (profile) => profile.profileId === provider,
  );
  const byKind = profiles.filter(
    (profile) => profile.kind === provider,
  );
  const profile =
    exact ?? (byKind.length === 1 ? byKind[0] : undefined);
  if (profile === undefined) {
    throw new Error(
      `Configured model provider was not found: ${provider}`,
    );
  }
  if (profile.enabled !== true) {
    throw new Error(
      `Configured model provider is disabled: ${profile.profileId}`,
    );
  }
  if (
    profile.kind !== "codex-cli" &&
    profile.kind !== "claude-code-cli"
  ) {
    throw new Error(
      "Live evaluator supports Codex CLI and Claude Code CLI profiles; export predictions for API providers",
    );
  }

  const repositoryRoot = fileURLToPath(
    new URL("../", import.meta.url),
  );
  const { createServer } = await import("vite");
  const server = await createServer({
    root: repositoryRoot,
    configFile: false,
    appType: "custom",
    logLevel: "silent",
    server: { middlewareMode: true },
    resolve: {
      alias: {
        "@cognelis/decision-protocol": resolve(
          repositoryRoot,
          "packages/protocol/src/index.ts",
        ),
        "@cognelis/decision-core": resolve(
          repositoryRoot,
          "packages/core/src/index.ts",
        ),
      },
    },
  });
  const rules = await createRulePredictor();
  let adapter;
  try {
    const core = await server.ssrLoadModule(
      resolve(repositoryRoot, "packages/core/src/index.ts"),
    );
    if (profile.kind === "codex-cli") {
      const module = await server.ssrLoadModule(
        resolve(
          repositoryRoot,
          "apps/desktop/src/main/model/adapters/codex-cli-adapter.ts",
        ),
      );
      adapter = new module.CodexCliAdapter({ profile });
    } else {
      const module = await server.ssrLoadModule(
        resolve(
          repositoryRoot,
          "apps/desktop/src/main/model/adapters/claude-code-cli-adapter.ts",
        ),
      );
      adapter = new module.ClaudeCodeCliAdapter({ profile });
    }
    return {
      predict: createProviderPredictor({
        provider: profile.profileId,
        rulePredictor: rules.predict,
        invoke: (input) => adapter.invoke(input),
        validateClassification:
          core.validateSemanticClassification,
        routeDecision: core.routeSemanticDecision,
      }),
      close: async () => {
        await adapter.close();
        await rules.close();
        await server.close();
      },
    };
  } catch (error) {
    await adapter?.close?.();
    await rules.close();
    await server.close();
    throw error;
  }
};

export const parseEvaluatorArgs = (args) => {
  const options = {
    corpus: fileURLToPath(
      new URL(
        "../apps/desktop/test/fixtures/semantic-evaluation.json",
        import.meta.url,
      ),
    ),
    format: "both",
    predictions: null,
    provider: "rules",
    reportOnly: false,
    userData:
      readDecisionEnvironment(process.env, "USER_DATA") ??
      defaultUserData(),
  };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--report-only") {
      options.reportOnly = true;
    } else if (
      argument === "--corpus" ||
      argument === "--format" ||
      argument === "--predictions" ||
      argument === "--provider" ||
      argument === "--user-data"
    ) {
      const value = args[++index];
      if (value === undefined) {
        throw new Error(`${argument} requires a value`);
      }
      const optionName =
        argument === "--user-data"
          ? "userData"
          : argument.slice(2);
      options[optionName] = value;
    } else if (argument === "--help") {
      options.help = true;
    } else {
      throw new Error(`Unknown evaluator option: ${argument}`);
    }
  }
  if (
    !["json", "human", "both"].includes(options.format) ||
    typeof options.provider !== "string" ||
    options.provider.trim().length === 0 ||
    options.provider.length > 200
  ) {
    throw new Error(
      "Evaluator format or provider is invalid",
    );
  }
  return options;
};

const loadSamples = async (path) => {
  const value = JSON.parse(await readFile(path, "utf8"));
  return Array.isArray(value) ? value : value.samples;
};

const runCli = async () => {
  const options = parseEvaluatorArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(
      "Usage: evaluate-semantic-classifier.mjs [--report-only] [--corpus PATH] [--predictions PATH] [--provider rules|PROFILE_ID] [--user-data PATH] [--format human|json|both]\n",
    );
    return;
  }
  const samples = await loadSamples(options.corpus);
  let close = async () => undefined;
  let predictor;
  if (options.predictions !== null) {
    const predictions = JSON.parse(
      await readFile(options.predictions, "utf8"),
    );
    predictor = async (sample) => {
      const prediction = predictions[sample.id];
      return options.provider === "rules"
        ? prediction
        : { ...prediction, provider: options.provider };
    };
  } else if (options.provider !== "rules") {
    const configured = await createConfiguredCliPredictor({
      provider: options.provider,
      userData: options.userData,
    });
    predictor = configured.predict;
    close = configured.close;
  } else {
    const rules = await createRulePredictor();
    predictor = rules.predict;
    close = rules.close;
  }
  try {
    const report = await evaluateSemanticCorpus({
      samples,
      predictor,
    });
    if (options.format === "human" || options.format === "both") {
      process.stdout.write(`${formatHumanReport(report)}\n`);
    }
    if (options.format === "json" || options.format === "both") {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    }
    process.exitCode = evaluationExitCode(report, {
      reportOnly: options.reportOnly,
    });
  } finally {
    await close();
  }
};

export const formatEvaluationError = (error) => {
  const object =
    error !== null && typeof error === "object"
      ? error
      : {};
  const message =
    typeof object.message === "string"
      ? object.message
      : String(error);
  const code =
    typeof object.code === "string" &&
    /^[a-z][a-z0-9_]{0,99}$/u.test(object.code)
      ? object.code
      : null;
  const exitCode = Number.isInteger(object.processExitCode)
    ? object.processExitCode
    : null;
  const diagnostic =
    code !== null &&
    typeof object.diagnosticExcerpt === "string"
      ? object.diagnosticExcerpt.trim().slice(0, 2_000)
      : "";
  const metadata =
    code === null
      ? ""
      : ` [${[
          code,
          ...(exitCode === null ? [] : [`exit ${exitCode}`]),
        ].join(", ")}]`;
  return `${message}${metadata}${
    diagnostic.length === 0 ? "" : `: ${diagnostic}`
  }`;
};

const invokedPath =
  process.argv[1] === undefined
    ? null
    : pathToFileURL(resolve(process.argv[1])).href;
if (invokedPath === import.meta.url) {
  runCli().catch((error) => {
    process.stderr.write(
      `semantic evaluation failed: ${formatEvaluationError(error)}\n`,
    );
    process.exitCode = 2;
  });
}
