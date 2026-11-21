export type ParaselfEnvironmentSource = "current" | "legacy" | "default";

export interface ParaselfEnvironmentResolution {
  value: string | undefined;
  source: ParaselfEnvironmentSource;
}

export declare const readParaselfEnvironmentWithSource: (
  environment: NodeJS.ProcessEnv,
  suffix: string,
) => ParaselfEnvironmentResolution;

export declare const readParaselfEnvironment: (
  environment: NodeJS.ProcessEnv,
  suffix: string,
) => string | undefined;
