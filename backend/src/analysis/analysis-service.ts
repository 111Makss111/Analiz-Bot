import { decideDirection } from "./decision-engine.js";
import { extractAnalysisFeatures } from "./feature-extractor.js";
import type { AnalysisDataSource } from "./analysis-data-source.js";
import type {
  AnalyzeRequest,
  AnalysisResult,
  AnalysisSnapshot
} from "./types.js";

export class AnalysisError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly statusCode: 404 | 409 | 422 | 503
  ) {
    super(message);
    this.name = "AnalysisError";
  }
}

export interface AnalysisRuntime {
  analyze(request: AnalyzeRequest): Promise<AnalysisResult>;
}

function completeCount(snapshot: AnalysisSnapshot, timeframe: 30 | 60 | 300): number {
  const candles =
    timeframe === 30
      ? snapshot.candles30s
      : timeframe === 60
        ? snapshot.candlesM1
        : snapshot.candlesM5;
  return candles.filter((candle) => candle.isComplete).length;
}

export class AnalysisService implements AnalysisRuntime {
  constructor(
    private readonly source: AnalysisDataSource,
    private readonly now: () => number = Date.now
  ) {}

  async analyze(request: AnalyzeRequest): Promise<AnalysisResult> {
    const startedAtMs = this.now();
    let snapshot: AnalysisSnapshot;
    try {
      snapshot = await this.source.load(request.assetId, startedAtMs);
    } catch (error) {
      if (error instanceof AnalysisError) throw error;
      throw new AnalysisError(
        "ANALYSIS_DATA_UNAVAILABLE",
        "Не вдалося отримати дані Pocket для аналізу",
        503
      );
    }

    const asset = snapshot.asset;
    if (!asset) throw new AnalysisError("ASSET_NOT_FOUND", "Актив відсутній у каталозі Pocket", 404);
    if (!asset.isAvailable) {
      throw new AnalysisError("ASSET_UNAVAILABLE", "Вибраний актив зараз недоступний у Pocket", 409);
    }
    if (asset.lastQuote === null || asset.lastQuote <= 0 || !asset.lastQuoteAt) {
      throw new AnalysisError("QUOTE_MISSING", "Pocket ще не передав актуальну котировку", 503);
    }

    const quoteTimeMs = Date.parse(asset.lastQuoteAt);
    const quoteAgeMs = startedAtMs - quoteTimeMs;
    if (!Number.isFinite(quoteTimeMs) || quoteAgeMs < -2_000) {
      throw new AnalysisError("POCKET_CLOCK_INVALID", "Час котировки Pocket технічно пошкоджений", 503);
    }
    if (quoteAgeMs > 15_000 || asset.dataState === "stale" || asset.dataState === "error") {
      throw new AnalysisError("QUOTE_STALE", "Котировка Pocket застаріла; повторіть після оновлення", 503);
    }

    const count30s = completeCount(snapshot, 30);
    const countM1 = completeCount(snapshot, 60);
    const countM5 = completeCount(snapshot, 300);
    const recentTicks = snapshot.ticks.filter((tick) => tick.timeMs >= startedAtMs - 30_000).length;
    if (countM1 < 21) {
      throw new AnalysisError(
        "M1_HISTORY_INSUFFICIENT",
        `Недостатньо M1-історії Pocket: ${countM1} із потрібних 21 свічки`,
        422
      );
    }
    if (count30s < 12) {
      throw new AnalysisError(
        "S30_HISTORY_INSUFFICIENT",
        `Недостатньо 30s-історії Pocket: ${count30s} із потрібних 12 свічок`,
        422
      );
    }
    if (recentTicks < 8) {
      throw new AnalysisError(
        "TICK_CONTEXT_INSUFFICIENT",
        `Недостатньо свіжих тиків Pocket: ${recentTicks} із потрібних 8`,
        422
      );
    }

    const features = extractAnalysisFeatures(snapshot, asset.lastQuote, Math.max(0, quoteAgeMs));
    const decision = decideDirection(features, asset.marketType, request.expirationMinutes);
    const finishedAtMs = this.now();
    return {
      asset: {
        id: asset.id,
        pocketSymbol: asset.pocketSymbol,
        displayName: asset.displayName,
        marketType: asset.marketType
      },
      direction: decision.direction,
      expirationMinutes: request.expirationMinutes,
      expirationSeconds: (request.expirationMinutes * 60) as 60 | 120 | 180,
      quote: {
        price: asset.lastQuote,
        pocketTime: new Date(quoteTimeMs).toISOString(),
        ageMs: Math.max(0, quoteAgeMs)
      },
      // Payout is display-only. It is deliberately absent from feature extraction and scoring.
      payoutPercent: asset.payoutPercent,
      strengthScore: decision.strengthScore,
      strength: decision.strength,
      strengthIsProbability: false,
      regime: decision.features.regime,
      volatility: decision.features.volatility,
      explanation: decision.explanation,
      reasons: decision.reasons,
      risks: decision.risks,
      algorithmVersion: decision.algorithmVersion,
      createdAt: new Date(finishedAtMs).toISOString(),
      durationMs: Math.max(0, finishedAtMs - startedAtMs),
      data: {
        recentTicks: decision.features.recentTicks,
        candles30s: count30s,
        candlesM1: countM1,
        candlesM5: countM5,
        qualityScore: decision.features.dataQualityScore
      }
    };
  }
}

export class UnavailableAnalysisRuntime implements AnalysisRuntime {
  async analyze(): Promise<AnalysisResult> {
    throw new AnalysisError(
      "ANALYSIS_UNAVAILABLE",
      "Математичний аналіз недоступний без Supabase",
      503
    );
  }
}
