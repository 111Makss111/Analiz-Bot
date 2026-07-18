import type { AnalysisCandle } from "./types.js";

export function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

export function sign(value: number, deadZone = 0): -1 | 0 | 1 {
  if (value > deadZone) return 1;
  if (value < -deadZone) return -1;
  return 0;
}

export function average(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function ema(values: number[], period: number): number | null {
  if (values.length < period || period < 1) return null;
  const seed = average(values.slice(0, period));
  const multiplier = 2 / (period + 1);
  return values.slice(period).reduce((current, value) => current + (value - current) * multiplier, seed);
}

export function linearSlope(values: number[]): number {
  if (values.length < 2) return 0;
  const xMean = (values.length - 1) / 2;
  const yMean = average(values);
  let numerator = 0;
  let denominator = 0;
  for (let index = 0; index < values.length; index += 1) {
    const xDistance = index - xMean;
    numerator += xDistance * (values[index]! - yMean);
    denominator += xDistance * xDistance;
  }
  return denominator === 0 ? 0 : numerator / denominator;
}

export function trueRange(candle: AnalysisCandle, previousClose: number | null): number {
  if (previousClose === null) return candle.high - candle.low;
  return Math.max(
    candle.high - candle.low,
    Math.abs(candle.high - previousClose),
    Math.abs(candle.low - previousClose)
  );
}

export function atr(candles: AnalysisCandle[], period: number): number | null {
  if (candles.length < period + 1) return null;
  const ranges = candles.map((candle, index) =>
    trueRange(candle, index === 0 ? null : candles[index - 1]!.close)
  );
  return average(ranges.slice(-period));
}

export function candlePressure(candle: AnalysisCandle): number {
  const range = candle.high - candle.low;
  if (range <= 0) return 0;
  return clamp((candle.close - candle.open) / range, -1, 1);
}

export function wickRatios(candle: AnalysisCandle): { upper: number; lower: number } {
  const range = candle.high - candle.low;
  if (range <= 0) return { upper: 0, lower: 0 };
  const bodyHigh = Math.max(candle.open, candle.close);
  const bodyLow = Math.min(candle.open, candle.close);
  return {
    upper: clamp((candle.high - bodyHigh) / range, 0, 1),
    lower: clamp((bodyLow - candle.low) / range, 0, 1)
  };
}

export function directionalStreak(candles: AnalysisCandle[]): number {
  if (candles.length === 0) return 0;
  const latestDirection = sign(candles.at(-1)!.close - candles.at(-1)!.open);
  if (latestDirection === 0) return 0;
  let count = 0;
  for (let index = candles.length - 1; index >= 0; index -= 1) {
    const candle = candles[index]!;
    if (sign(candle.close - candle.open) !== latestDirection) break;
    count += 1;
  }
  return count * latestDirection;
}
