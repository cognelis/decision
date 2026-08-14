export type DecisionEnvironmentSource = "current" | "legacy" | "default";

export interface DecisionEnvironmentResolution {
  value: string | undefined;
  source: DecisionEnvironmentSource;
}

export declare const readDecisionEnvironmentWithSource: (
  environment: NodeJS.ProcessEnv,
  suffix: string,
) => DecisionEnvironmentResolution;

export declare const readDecisionEnvironment: (
  environment: NodeJS.ProcessEnv,
  suffix: string,
) => string | undefined;
