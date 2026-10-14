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

  return { value: undefined, source: "default" };
};

export const readDecisionEnvironment = (environment, suffix) =>
  readDecisionEnvironmentWithSource(environment, suffix).value;
