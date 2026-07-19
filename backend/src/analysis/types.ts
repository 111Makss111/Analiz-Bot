import type { AssetDataState, MarketType } from "../market-data/types.js";

export type AnalysisExpirationMinutes = 1 | 2 | 3;
export type AnalysisDirection = "up" | "down";
export type AnalysisStrength = "stronger" | "normal" | "risky" | "very_risky";
export type AnalysisRegime =
  | "trend"
  | "range"
  | "breakout"
  | "reversal"
  | "impulse"
  | "exhaustion"
  | "volatile"
  | "mixed";
export type AnalysisVolatility = "low" | "normal" | "high";

export type AnalysisAsset = {
  id: string;
  pocketSymbol: string;
  displayName: string;
  marketType: MarketType;
  isAvailable: boolean;
  payoutPercent: number | null;
  dataState: AssetDataState;
  lastQuote: number | null;
  lastQuoteAt: string | null;
};

export type AnalysisTick = {
  timeMs: number;
  receivedAtMs: number;
  price: number;
};

export type AnalysisCandle = {
  timeframeSeconds: 30 | 60 | 300;
  openTimeMs: number;
  closeTimeMs: number;
  open: number;
  high: number;
  low: number;
  close: number;
  tickCount: number;
  isComplete: boolean;
};

export type AnalysisSnapshot = {
  asset: AnalysisAsset | null;
  ticks: AnalysisTick[];
  candles30s: AnalysisCandle[];
  candlesM1: AnalysisCandle[];
  candlesM5: AnalysisCandle[];
  capturedAtMs: number;
};

export type AnalysisFeatures = {
  quote: number;
  quoteAgeMs: number;
  atrM1: number;
  ema9: number;
  ema20: number;
  ema21: number;
  priceVsEma21: number;
  emaSpread: number;
  slopeFast: number;
  slopeSlow: number;
  acceleration: number;
  m5Slope: number;
  candlePressure: number;
  currentCandlePressure: number;
  upperWickRatio: number;
  lowerWickRatio: number;
  directionalStreak: number;
  volatilityRatio: number;
  volatility: AnalysisVolatility;
  support: number;
  resistance: number;
  distanceToSupportAtr: number;
  distanceToResistanceAtr: number;
  rangePosition: number;
  breakoutDirection: -1 | 0 | 1;
  rejectionDirection: -1 | 0 | 1;
  impulseDirection: -1 | 0 | 1;
  exhaustionDirection: -1 | 0 | 1;
  tickMomentum: number;
  tickRecentMomentum: number;
  tickDirectionBias: number;
  tickSpeed: number;
  tickReversalDirection: -1 | 0 | 1;
  pullbackRisk: boolean;
  falseBreakout: boolean;
  exhaustion: boolean;
  regime: AnalysisRegime;
  dataQualityScore: number;
  complete30s: number;
  completeM1: number;
  completeM5: number;
  recentTicks: number;
};

export type SignalContribution = {
  key: string;
  value: number;
  reasonUp: string;
  reasonDown: string;
};

export type EngineDecision = {
  direction: AnalysisDirection;
  signedScore: number;
  strengthScore: number;
  strength: AnalysisStrength;
  explanation: string;
  reasons: string[];
  risks: string[];
  algorithmVersion: string;
  features: AnalysisFeatures;
};

export type AnalysisResult = {
  asset: {
    id: string;
    pocketSymbol: string;
    displayName: string;
    marketType: MarketType;
  };
  direction: AnalysisDirection;
  expirationMinutes: AnalysisExpirationMinutes;
  expirationSeconds: 60 | 120 | 180;
  quote: {
    price: number;
    pocketTime: string;
    ageMs: number;
  };
  payoutPercent: number | null;
  strengthScore: number;
  strength: AnalysisStrength;
  strengthIsProbability: false;
  regime: AnalysisRegime;
  volatility: AnalysisVolatility;
  explanation: string;
  reasons: string[];
  risks: string[];
  algorithmVersion: string;
  createdAt: string;
  durationMs: number;
  data: {
    recentTicks: number;
    candles30s: number;
    candlesM1: number;
    candlesM5: number;
    qualityScore: number;
  };
};

export type AnalyzeRequest = {
  assetId: string;
  expirationMinutes: AnalysisExpirationMinutes;
};

export type AnalyzeResponse =
  | {
      ok: true;
      analysis: AnalysisResult;
    }
  | {
      ok: false;
      error: { code: string; message: string };
    };
