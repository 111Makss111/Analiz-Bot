import {
  atr,
  average,
  candlePressure,
  clamp,
  directionalStreak,
  ema,
  linearSlope,
  sign,
  trueRange,
  wickRatios
} from "./indicators.js";
import type {
  AnalysisCandle,
  AnalysisFeatures,
  AnalysisRegime,
  AnalysisSnapshot,
  AnalysisTick,
  AnalysisVolatility
} from "./types.js";

function completed(candles: AnalysisCandle[]): AnalysisCandle[] {
  return candles.filter((candle) => candle.isComplete);
}

function priceAtOrBefore(ticks: AnalysisTick[], timestampMs: number): number {
  for (let index = ticks.length - 1; index >= 0; index -= 1) {
    if (ticks[index]!.timeMs <= timestampMs) return ticks[index]!.price;
  }
  return ticks[0]?.price ?? 0;
}

function normalizedSlope(values: number[], scale: number): number {
  return scale <= 0 ? 0 : clamp(linearSlope(values) / scale, -3, 3);
}

function levelDirection(
  quote: number,
  support: number,
  resistance: number,
  atrValue: number,
  latest: AnalysisCandle,
  upperWick: number,
  lowerWick: number
): { breakout: -1 | 0 | 1; rejection: -1 | 0 | 1; falseBreakout: boolean } {
  const breakoutBuffer = atrValue * 0.12;
  const levelBuffer = atrValue * 0.28;
  const pressure = candlePressure(latest);
  const falseUp = latest.high > resistance + atrValue * 0.05 && latest.close < resistance && upperWick > 0.3;
  const falseDown = latest.low < support - atrValue * 0.05 && latest.close > support && lowerWick > 0.3;

  let breakout: -1 | 0 | 1 = 0;
  if (quote > resistance + breakoutBuffer && pressure > 0.15) breakout = 1;
  else if (quote < support - breakoutBuffer && pressure < -0.15) breakout = -1;

  let rejection: -1 | 0 | 1 = 0;
  if (falseDown || (quote - support <= levelBuffer && lowerWick > 0.34 && pressure > -0.15)) {
    rejection = 1;
  } else if (
    falseUp ||
    (resistance - quote <= levelBuffer && upperWick > 0.34 && pressure < 0.15)
  ) {
    rejection = -1;
  }

  return { breakout, rejection, falseBreakout: falseUp || falseDown };
}

function detectRegime(values: {
  breakoutDirection: number;
  rejectionDirection: number;
  falseBreakout: boolean;
  exhaustion: boolean;
  volatility: AnalysisVolatility;
  impulseDirection: number;
  tickMomentum: number;
  emaSpread: number;
  slopeSlow: number;
}): AnalysisRegime {
  if (values.breakoutDirection !== 0) return "breakout";
  if (values.falseBreakout || values.rejectionDirection !== 0) return "reversal";
  if (values.exhaustion) return "exhaustion";
  if (values.volatility === "high") return "volatile";
  if (values.impulseDirection !== 0 && Math.abs(values.tickMomentum) > 0.18) return "impulse";
  if (Math.abs(values.emaSpread) > 0.12 && Math.abs(values.slopeSlow) > 0.06) return "trend";
  if (Math.abs(values.emaSpread) < 0.16 && Math.abs(values.slopeSlow) < 0.12) return "range";
  return "mixed";
}

export function extractAnalysisFeatures(
  snapshot: AnalysisSnapshot,
  quote: number,
  quoteAgeMs: number
): AnalysisFeatures {
  const complete30s = completed(snapshot.candles30s);
  const completeM1 = completed(snapshot.candlesM1);
  const completeM5 = completed(snapshot.candlesM5);
  const latestM1 = snapshot.candlesM1.at(-1) ?? completeM1.at(-1)!;
  const latestCompleteM1 = completeM1.at(-1)!;
  const closes = [...completeM1.map((candle) => candle.close), quote];
  const ema9Value = ema(closes, 9)!;
  const ema20Value = ema(closes, 20)!;
  const ema21Value = ema(closes, 21)!;
  const atrM1 = atr(completeM1, 14)!;
  const safeAtr = Math.max(atrM1, quote * 1e-7);

  const fastCloses = closes.slice(-6);
  const slowCloses = closes.slice(-13);
  const previousFast = closes.slice(-10, -4);
  const slopeFast = normalizedSlope(fastCloses, safeAtr);
  const slopeSlow = normalizedSlope(slowCloses, safeAtr);
  const acceleration = clamp(
    slopeFast - normalizedSlope(previousFast.length >= 2 ? previousFast : fastCloses, safeAtr),
    -3,
    3
  );
  const m5Slope = normalizedSlope(completeM5.slice(-7).map((candle) => candle.close), safeAtr * 2.2);

  const recentPressures = completeM1.slice(-4).map(candlePressure);
  const pressure = clamp(average(recentPressures), -1, 1);
  const currentPressure = candlePressure(latestM1);
  const wicks = wickRatios(latestCompleteM1);

  const referenceLevels = completeM1.slice(-17, -1);
  const support = Math.min(...referenceLevels.map((candle) => candle.low));
  const resistance = Math.max(...referenceLevels.map((candle) => candle.high));
  const rangeWidth = Math.max(resistance - support, safeAtr * 0.1);
  const rangePosition = clamp((quote - support) / rangeWidth, 0, 1);
  const levels = levelDirection(
    quote,
    support,
    resistance,
    safeAtr,
    latestCompleteM1,
    wicks.upper,
    wicks.lower
  );

  const recent30 = complete30s.slice(-5);
  const impulseValue = recent30.reduce((sum, candle) => sum + candle.close - candle.open, 0) / safeAtr;
  const impulseDirection = sign(impulseValue, 0.35);
  const bodySizes = recent30.slice(-3).map((candle) => Math.abs(candle.close - candle.open) / safeAtr);
  const bodyDecay =
    bodySizes.length === 3 && bodySizes[0]! > bodySizes[1]! && bodySizes[1]! > bodySizes[2]!;
  const oppositeWick = impulseDirection > 0 ? wicks.upper : impulseDirection < 0 ? wicks.lower : 0;
  const exhaustion = Math.abs(impulseValue) > 1.15 && (bodyDecay || oppositeWick > 0.42);
  const exhaustionDirection = exhaustion ? (impulseDirection === 1 ? -1 : impulseDirection === -1 ? 1 : 0) : 0;

  const ticks = snapshot.ticks
    .filter((tick) => tick.timeMs >= snapshot.capturedAtMs - 30_000)
    .sort((left, right) => left.timeMs - right.timeMs);
  const firstTickPrice = ticks[0]?.price ?? quote;
  const lastTickPrice = ticks.at(-1)?.price ?? quote;
  const recentStartPrice = priceAtOrBefore(ticks, snapshot.capturedAtMs - 5_000) || firstTickPrice;
  const previousStartPrice = priceAtOrBefore(ticks, snapshot.capturedAtMs - 20_000) || firstTickPrice;
  const tickMomentum = clamp((lastTickPrice - firstTickPrice) / safeAtr, -3, 3);
  const tickRecentMomentum = clamp((lastTickPrice - recentStartPrice) / safeAtr, -3, 3);
  const tickPreviousMomentum = clamp((recentStartPrice - previousStartPrice) / safeAtr, -3, 3);
  const tickReversalDirection =
    sign(tickRecentMomentum, 0.06) !== 0 &&
    sign(tickRecentMomentum, 0.06) === -sign(tickPreviousMomentum, 0.12)
      ? sign(tickRecentMomentum, 0.06)
      : 0;

  let directionalMoves = 0;
  let upwardMoves = 0;
  let absoluteTickMovement = 0;
  for (let index = 1; index < ticks.length; index += 1) {
    const delta = ticks[index]!.price - ticks[index - 1]!.price;
    absoluteTickMovement += Math.abs(delta);
    if (delta === 0) continue;
    directionalMoves += 1;
    if (delta > 0) upwardMoves += 1;
  }
  const tickDirectionBias =
    directionalMoves === 0 ? 0 : clamp((upwardMoves * 2 - directionalMoves) / directionalMoves, -1, 1);
  const tickDurationSeconds = Math.max(1, ((ticks.at(-1)?.timeMs ?? 0) - (ticks[0]?.timeMs ?? 0)) / 1_000);
  const tickSpeed = directionalMoves / tickDurationSeconds;

  const ranges = completeM1.map((candle, index) =>
    trueRange(candle, index === 0 ? null : completeM1[index - 1]!.close)
  );
  const volatilityRatio = clamp(average(ranges.slice(-5)) / safeAtr, 0, 4);
  const volatility: AnalysisVolatility =
    volatilityRatio > 1.6 ? "high" : volatilityRatio < 0.55 ? "low" : "normal";
  const pullbackRisk =
    (impulseDirection > 0 && currentPressure < -0.2) ||
    (impulseDirection < 0 && currentPressure > 0.2) ||
    exhaustion;

  const priceVsEma21 = clamp((quote - ema21Value) / safeAtr, -3, 3);
  const emaSpread = clamp((ema9Value - ema21Value) / safeAtr, -3, 3);
  const qualityFromHistory = Math.min(1, completeM1.length / 40) * 34;
  const qualityFromTicks = Math.min(1, ticks.length / 30) * 28;
  const qualityFrom30s = Math.min(1, complete30s.length / 30) * 20;
  const qualityFromFreshness = clamp(1 - quoteAgeMs / 15_000, 0, 1) * 18;
  const dataQualityScore = Math.round(
    clamp(qualityFromHistory + qualityFromTicks + qualityFrom30s + qualityFromFreshness, 0, 100)
  );

  const regime = detectRegime({
    breakoutDirection: levels.breakout,
    rejectionDirection: levels.rejection,
    falseBreakout: levels.falseBreakout,
    exhaustion,
    volatility,
    impulseDirection,
    tickMomentum,
    emaSpread,
    slopeSlow
  });

  return {
    quote,
    quoteAgeMs,
    atrM1: safeAtr,
    ema9: ema9Value,
    ema20: ema20Value,
    ema21: ema21Value,
    priceVsEma21,
    emaSpread,
    slopeFast,
    slopeSlow,
    acceleration,
    m5Slope,
    candlePressure: pressure,
    currentCandlePressure: currentPressure,
    upperWickRatio: wicks.upper,
    lowerWickRatio: wicks.lower,
    directionalStreak: directionalStreak(completeM1.slice(-8)),
    volatilityRatio,
    volatility,
    support,
    resistance,
    distanceToSupportAtr: clamp((quote - support) / safeAtr, -5, 5),
    distanceToResistanceAtr: clamp((resistance - quote) / safeAtr, -5, 5),
    rangePosition,
    breakoutDirection: levels.breakout,
    rejectionDirection: levels.rejection,
    impulseDirection,
    exhaustionDirection,
    tickMomentum,
    tickRecentMomentum,
    tickDirectionBias,
    tickSpeed,
    tickReversalDirection,
    pullbackRisk,
    falseBreakout: levels.falseBreakout,
    exhaustion,
    regime,
    dataQualityScore,
    complete30s: complete30s.length,
    completeM1: completeM1.length,
    completeM5: completeM5.length,
    recentTicks: ticks.length
  };
}
