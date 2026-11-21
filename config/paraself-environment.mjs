const environmentValue = (environment, key) => {
  const candidate = environment[key];
  return typeof candidate === "string" && candidate.length > 0
    ? candidate
    : undefined;
};

/**
 * `PARASELF_<suffix>`, else the name it had as Decision (`DECISION_<suffix>`): a shell, a launcher or a script set
 * before the rename keeps working, said apart as `legacy`.
 */
export const readParaselfEnvironmentWithSource = (environment, suffix) => {
  const current = environmentValue(environment, `PARASELF_${suffix}`);
  if (current !== undefined) {
    return { value: current, source: "current" };
  }
  const legacy = environmentValue(environment, `DECISION_${suffix}`);
  if (legacy !== undefined) {
    return { value: legacy, source: "legacy" };
  }

  return { value: undefined, source: "default" };
};

export const readParaselfEnvironment = (environment, suffix) =>
  readParaselfEnvironmentWithSource(environment, suffix).value;
