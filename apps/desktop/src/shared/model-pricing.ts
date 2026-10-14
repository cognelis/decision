import type { ModelInvocationTrace, ModelPricing, NormalizedTokenUsage } from "@cognelis/decision-protocol";

// Official 2026 holiday arrangements; adjusted weekend workdays remain off-peak for DeepSeek.
const holidayRanges = [["01-01", "01-03"], ["02-15", "02-23"], ["04-04", "04-06"], ["05-01", "05-05"], ["06-19", "06-21"], ["09-25", "09-27"], ["10-01", "10-07"]];
export const DEEPSEEK_2026_HOLIDAYS = holidayRanges.flatMap(([start, end]) => {
  const dates: string[] = [];
  for (let day = Date.parse(`2026-${start}T00:00:00Z`); day <= Date.parse(`2026-${end}T00:00:00Z`); day += 86400000) dates.push(new Date(day).toISOString().slice(0, 10));
  return dates;
});

export const estimateModelCost = (usage: NormalizedTokenUsage, pricing: ModelPricing, startedAt: string): { minimum: number; maximum: number; period: "fixed" | "off-peak" | "peak" | "unknown-calendar"; cacheKnown: boolean } | null => {
  const { inputTokens, outputTokens, cachedInputTokens } = usage;
  if (inputTokens === undefined || outputTokens === undefined || (cachedInputTokens ?? 0) > inputTokens) return null;
  let period: "fixed" | "off-peak" | "peak" | "unknown-calendar" = "fixed";
  let rates = [pricing];
  if (pricing.peak !== undefined) {
    const timestamp = Date.parse(startedAt);
    if (!Number.isFinite(timestamp)) return null;
    const beijing = new Date(timestamp + 8 * 3600000);
    const minutes = beijing.getUTCHours() * 60 + beijing.getUTCMinutes();
    const weekday = beijing.getUTCDay();
    const day = beijing.toISOString().slice(0, 10);
    const peakHours = weekday >= 1 && weekday <= 5 && ((minutes >= 540 && minutes < 720) || (minutes >= 840 && minutes < 1080));
    period = !peakHours || pricing.peak.holidays.includes(day) ? "off-peak" : beijing.getUTCFullYear() !== pricing.peak.holidayYear ? "unknown-calendar" : "peak";
    const peakRate = { ...pricing, ...pricing.peak };
    rates = period === "peak" ? [peakRate] : period === "unknown-calendar" ? [pricing, peakRate] : [pricing];
  }
  const amounts = rates.flatMap((rate) => {
    const cachedRate = rate.cachedInputPerMillion ?? rate.inputPerMillion;
    const cacheCounts = cachedInputTokens !== undefined ? [cachedInputTokens] : cachedRate === rate.inputPerMillion ? [0] : [0, inputTokens];
    return cacheCounts.map((cached) => ((inputTokens - cached) * rate.inputPerMillion + cached * cachedRate + outputTokens * rate.outputPerMillion) / 1000000);
  });
  return { minimum: Math.min(...amounts), maximum: Math.max(...amounts), period, cacheKnown: cachedInputTokens !== undefined || rates.every((rate) => (rate.cachedInputPerMillion ?? rate.inputPerMillion) === rate.inputPerMillion) };
};

export const traceCost = (trace: ModelInvocationTrace, currentPricing?: ModelPricing) => {
  const price = trace.profile.pricing ?? currentPricing;
  if (price === undefined) return null;
  // The trace is written after completion; subtract elapsed time to estimate request start.
  const started = new Date(Date.parse(trace.createdAt) - trace.timing.totalMs);
  if (!Number.isFinite(started.getTime())) return null;
  return estimateModelCost(trace.usage, price, started.toISOString());
};

export const costAmount = (minimum: number, maximum: number): string => {
  const digits = maximum < 0.000001 ? 8 : maximum < 0.01 ? 6 : maximum < 1 ? 4 : 2;
  return minimum === maximum ? maximum.toFixed(digits) : `${minimum.toFixed(digits)}–${maximum.toFixed(digits)}`;
};
