import type { MarketType } from "../market-data/types.js";
import { clamp, sign } from "./indicators.js";
import type {
  AnalysisDirection,
  AnalysisExpirationMinutes,
  AnalysisFeatures,
  AnalysisStrength,
  EngineDecision,
  SignalContribution
} from "./types.js";

type WeightProfile = {
  tick: number;
  trend: number;
  structure: number;
  context: number;
};

function profile(marketType: MarketType, expiration: AnalysisExpirationMinutes): WeightProfile {
  const horizon =
    expiration === 1
      ? { tick: 1.25, trend: 0.86, context: 0.55 }
      : expiration === 2
        ? { tick: 1.05, trend: 1.02, context: 0.75 }
        : { tick: 0.84, trend: 1.18, context: 1 };
  return marketType === "otc"
    ? { tick: horizon.tick * 1.08, trend: horizon.trend * 0.92, structure: 1.16, context: horizon.context }
    : { tick: horizon.tick, trend: horizon.trend * 1.08, structure: 1, context: horizon.context * 1.05 };
}

function strengthLabel(score: number): AnalysisStrength {
  if (score >= 72) return "stronger";
  if (score >= 48) return "normal";
  if (score >= 28) return "risky";
  return "very_risky";
}

function directionFromScore(score: number, features: AnalysisFeatures): AnalysisDirection {
  const direct = sign(score, 0.5);
  if (direct !== 0) return direct > 0 ? "up" : "down";
  for (const fallback of [
    features.tickRecentMomentum,
    features.tickDirectionBias,
    features.slopeFast,
    features.emaSpread,
    features.currentCandlePressure,
    features.priceVsEma21
  ]) {
    const fallbackDirection = sign(fallback, 0.01);
    if (fallbackDirection !== 0) return fallbackDirection > 0 ? "up" : "down";
  }
  return features.quote >= features.ema21 ? "up" : "down";
}

export function decideDirection(
  features: AnalysisFeatures,
  marketType: MarketType,
  expiration: AnalysisExpirationMinutes
): EngineDecision {
  const weights = profile(marketType, expiration);
  const contributions: SignalContribution[] = [];
  const add = (
    key: string,
    signalValue: number,
    weight: number,
    reasonUp: string,
    reasonDown: string
  ) => {
    const value = clamp(signalValue, -1, 1) * weight;
    if (Math.abs(value) < 0.2) return;
    contributions.push({ key, value, reasonUp, reasonDown });
  };

  const rangeContrarian = clamp((0.5 - features.rangePosition) * 2, -1, 1);
  const streakSignal = clamp(features.directionalStreak / 4, -1, 1);

  if (features.regime === "breakout") {
    add("breakout", features.breakoutDirection, 34 * weights.structure, "Ціна підтверджує пробій локального опору", "Ціна підтверджує пробій локальної підтримки");
    add("tick-recent", features.tickRecentMomentum, 20 * weights.tick, "Останні тики підтримують пробій вгору", "Останні тики підтримують пробій вниз");
    add("slope-fast", features.slopeFast, 18 * weights.trend, "Короткий нахил посилюється вгору", "Короткий нахил посилюється вниз");
    add("pressure", features.currentCandlePressure, 12, "Поточна свічка закріплює рух угору", "Поточна свічка закріплює рух униз");
  } else if (features.regime === "reversal") {
    add("rejection", features.rejectionDirection, 32 * weights.structure, "Ціна відбивається від локальної підтримки", "Ціна відбивається від локального опору");
    add("tick-reversal", features.tickReversalDirection, 24 * weights.tick, "Останні тики розвернулися вгору", "Останні тики розвернулися вниз");
    add("range-position", rangeContrarian, 17 * weights.structure, "Ціна знаходиться біля нижньої межі діапазону", "Ціна знаходиться біля верхньої межі діапазону");
    add("wick", features.lowerWickRatio - features.upperWickRatio, 11, "Нижня тінь показує відхилення нижчих цін", "Верхня тінь показує відхилення вищих цін");
  } else if (features.regime === "exhaustion") {
    add("exhaustion", features.exhaustionDirection, 27 * weights.structure, "Попередній спад втрачає імпульс", "Попереднє зростання втрачає імпульс");
    add("tick-recent", features.tickRecentMomentum, 22 * weights.tick, "Тики вже зміщуються вгору", "Тики вже зміщуються вниз");
    add("range-position", rangeContrarian, 13, "Ціна наблизилась до підтримки", "Ціна наблизилась до опору");
    add("acceleration", features.acceleration, 10, "Прискорення змінилося на користь руху вгору", "Прискорення змінилося на користь руху вниз");
  } else if (features.regime === "range") {
    add("range-position", rangeContrarian, 25 * weights.structure, "Ціна ближче до підтримки локального діапазону", "Ціна ближче до опору локального діапазону");
    add("rejection", features.rejectionDirection, 24 * weights.structure, "Підтримка утримала ціну", "Опір утримав ціну");
    add("tick-recent", features.tickRecentMomentum, 17 * weights.tick, "Мікрорух зміщується вгору", "Мікрорух зміщується вниз");
    add("pressure", features.currentCandlePressure, 11, "Поточна свічка має висхідний тиск", "Поточна свічка має низхідний тиск");
    add("tick-bias", features.tickDirectionBias, 9 * weights.tick, "Серед змін тиків переважають підвищення", "Серед змін тиків переважають зниження");
  } else {
    const trendMultiplier = features.regime === "trend" || features.regime === "impulse" ? 1.18 : 0.9;
    add("ema", features.emaSpread, 17 * weights.trend * trendMultiplier, "EMA 9 розташована вище EMA 20/21", "EMA 9 розташована нижче EMA 20/21");
    add("price-ema", features.priceVsEma21, 10 * weights.trend, "Ціна тримається вище EMA 21", "Ціна тримається нижче EMA 21");
    add("slope-fast", features.slopeFast, 18 * weights.trend * trendMultiplier, "Локальний нахил спрямований вгору", "Локальний нахил спрямований вниз");
    add("slope-slow", features.slopeSlow, 10 * weights.trend, "M1-структура підтримує підйом", "M1-структура підтримує спад");
    add("tick-momentum", features.tickMomentum, 18 * weights.tick, "Тиковий імпульс спрямований вгору", "Тиковий імпульс спрямований вниз");
    add("tick-recent", features.tickRecentMomentum, 13 * weights.tick, "Останні секунди прискорюються вгору", "Останні секунди прискорюються вниз");
    add("pressure", features.candlePressure, 9, "Останні M1-свічки мають висхідний тиск", "Останні M1-свічки мають низхідний тиск");
    add("streak", streakSignal, 7, "Серія свічок підтримує рух угору", "Серія свічок підтримує рух униз");
  }

  add("m5", features.m5Slope, 8 * weights.context, "M5-контекст нахилений угору", "M5-контекст нахилений униз");
  if (features.regime === "volatile") {
    add("volatile-ticks", features.tickRecentMomentum, 16 * weights.tick, "У високій волатильності останні тики спрямовані вгору", "У високій волатильності останні тики спрямовані вниз");
    add("volatile-pressure", features.currentCandlePressure, 12, "Поточний тиск залишається висхідним", "Поточний тиск залишається низхідним");
  }

  const signedScore = clamp(
    contributions.reduce((sum, contribution) => sum + contribution.value, 0),
    -100,
    100
  );
  const direction = directionFromScore(signedScore, features);
  const directionSign = direction === "up" ? 1 : -1;
  const matching = contributions.filter((contribution) => sign(contribution.value) === directionSign);
  const opposing = contributions.filter((contribution) => sign(contribution.value) === -directionSign);
  const matchingWeight = matching.reduce((sum, contribution) => sum + Math.abs(contribution.value), 0);
  const opposingWeight = opposing.reduce((sum, contribution) => sum + Math.abs(contribution.value), 0);
  const consensus = matchingWeight + opposingWeight === 0 ? 0 : matchingWeight / (matchingWeight + opposingWeight);
  const qualityFactor = 0.72 + (features.dataQualityScore / 100) * 0.28;
  let strengthScore = Math.abs(signedScore) * qualityFactor + consensus * 12;
  if (features.volatility === "high") strengthScore -= 7;
  if (features.pullbackRisk) strengthScore -= 5;
  if (features.m5Slope * directionSign < -0.12) strengthScore -= 4;
  strengthScore = Math.round(clamp(strengthScore, 5, 95));

  const reasons = matching
    .sort((left, right) => Math.abs(right.value) - Math.abs(left.value))
    .map((contribution) => (direction === "up" ? contribution.reasonUp : contribution.reasonDown))
    .filter((reason, index, all) => all.indexOf(reason) === index)
    .slice(0, 3);
  if (reasons.length === 0) {
    reasons.push(
      direction === "up"
        ? "Сумарний короткостроковий баланс ознак зміщений угору"
        : "Сумарний короткостроковий баланс ознак зміщений униз"
    );
  }

  const risks: string[] = [];
  if (consensus < 0.62) risks.push("Короткострокові ознаки частково суперечать одна одній");
  if (features.volatility === "high") risks.push("Поточна волатильність підвищує ризик різкого розвороту");
  if (features.volatility === "low") risks.push("Низька волатильність може дати слабкий рух до експірації");
  if (features.exhaustion) risks.push("Сигнал формується після помітного імпульсу");
  if (features.pullbackRisk) risks.push("Безпосередньо перед входом присутній ризик відкату");
  if (features.m5Slope * directionSign < -0.12) risks.push("M5-контекст спрямований проти короткого сигналу");
  if (direction === "up" && features.distanceToResistanceAtr < 0.35) risks.push("Локальний опір розташований близько над ціною");
  if (direction === "down" && features.distanceToSupportAtr < 0.35) risks.push("Локальна підтримка розташована близько під ціною");
  if (risks.length === 0) risks.push("Експірація 1–3 хвилини чутлива до останніх тиків Pocket");

  return {
    direction,
    signedScore: Math.round(signedScore * 100) / 100,
    strengthScore,
    strength: strengthLabel(strengthScore),
    explanation: `${reasons.join(". ")}.`,
    reasons,
    risks: risks.slice(0, 3),
    algorithmVersion:
      marketType === "otc"
        ? "market-pulse-deterministic-otc-v1.0.0"
        : "market-pulse-deterministic-regular-v1.0.0",
    features
  };
}
