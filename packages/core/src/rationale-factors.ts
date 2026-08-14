export const RATIONALE_FACTORS = [
  ["consistency", "遵循现有约定"],
  ["readability", "清晰易懂"],
  ["simplicity", "简单直接"],
  ["reuse", "复用现有能力"],
  ["cohesion", "职责边界清晰"],
  ["auditability", "可验证可追溯"],
] as const;

const LEGACY_RATIONALE_FACTORS = [
  ["goal-fit", "目标匹配"],
  ["maintainability", "可维护性"],
  ["risk", "风险"],
  ["implementation-cost", "实现成本"],
  ["time", "时间"],
  ["reversibility", "可逆性"],
] as const;

export const rationaleFactorLabel = (factor: string): string =>
  [...RATIONALE_FACTORS, ...LEGACY_RATIONALE_FACTORS].find(
    ([id]) => id === factor,
  )?.[1] ?? factor;
