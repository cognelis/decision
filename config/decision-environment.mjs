const environmentValue = (environment, key) => {
  const candidate = environment[key];
  return typeof candidate === "string" && candidate.length > 0
    ? candidate
    : undefined;
};

export const readDecisionEnvironmentWithSource = (environment, suffix) => {
  const current = environmentValue(environment, `DECISION_${suffix}`);
  if (current !== undefined) {
    return { value: current, source: "current" };
  }

  const legacy = environmentValue(
    environment,
    `DECISION_ISLAND_${suffix}`,
  );
  return legacy === undefined
    ? { value: undefined, source: "default" }
    : { value: legacy, source: "legacy" };
};

export const readDecisionEnvironment = (environment, suffix) =>
  readDecisionEnvironmentWithSource(environment, suffix).value;
