import { QuoteBook, type TickRejectionReason } from "./quote-book.js";
import {
  SUPPORTED_TIMEFRAMES,
  type MarketCandle,
  type PocketTick,
  type TimeframeSeconds
} from "./types.js";

export type CandleIngestResult =
  | {
      accepted: true;
      tick: PocketTick;
      current: MarketCandle[];
      completed: MarketCandle[];
    }
  | { accepted: false; reason: TickRejectionReason };

function candleKey(assetId: string, timeframeSeconds: TimeframeSeconds): string {
  return `${assetId}:${timeframeSeconds}`;
}

export function candleOpenTime(pocketTimeMs: number, timeframeSeconds: TimeframeSeconds): number {
  const durationMs = timeframeSeconds * 1000;
  return Math.floor(pocketTimeMs / durationMs) * durationMs;
}

function createCandle(tick: PocketTick, timeframeSeconds: TimeframeSeconds): MarketCandle {
  const openTimeMs = candleOpenTime(tick.pocketTimeMs, timeframeSeconds);
  return {
    assetId: tick.assetId,
    timeframeSeconds,
    openTimeMs,
    closeTimeMs: openTimeMs + timeframeSeconds * 1000,
    lastTickTimeMs: tick.pocketTimeMs,
    open: tick.price,
    high: tick.price,
    low: tick.price,
    close: tick.price,
    tickCount: 1,
    isComplete: false
  };
}

function updateCandle(candle: MarketCandle, tick: PocketTick): MarketCandle {
  return {
    ...candle,
    high: Math.max(candle.high, tick.price),
    low: Math.min(candle.low, tick.price),
    close: tick.price,
    lastTickTimeMs: tick.pocketTimeMs,
    tickCount: candle.tickCount + 1
  };
}

export class CandleEngine {
  private readonly quoteBook = new QuoteBook();
  private readonly current = new Map<string, MarketCandle>();

  restoreCurrent(candles: MarketCandle[]): void {
    for (const candle of candles) {
      if (
        candle.isComplete ||
        !SUPPORTED_TIMEFRAMES.includes(candle.timeframeSeconds) ||
        !Number.isFinite(candle.openTimeMs) ||
        candle.closeTimeMs !== candle.openTimeMs + candle.timeframeSeconds * 1000 ||
        !Number.isFinite(candle.lastTickTimeMs) ||
        candle.lastTickTimeMs < candle.openTimeMs ||
        candle.lastTickTimeMs >= candle.closeTimeMs ||
        !Number.isFinite(candle.open) ||
        !Number.isFinite(candle.high) ||
        !Number.isFinite(candle.low) ||
        !Number.isFinite(candle.close) ||
        candle.low <= 0 ||
        candle.high < candle.low ||
        candle.open < candle.low ||
        candle.open > candle.high ||
        candle.close < candle.low ||
        candle.close > candle.high ||
        !Number.isInteger(candle.tickCount) ||
        candle.tickCount < 1
      ) {
        continue;
      }

      const key = candleKey(candle.assetId, candle.timeframeSeconds);
      const existing = this.current.get(key);
      if (!existing || candle.openTimeMs > existing.openTimeMs) this.current.set(key, candle);
    }
  }

  ingest(tick: PocketTick): CandleIngestResult {
    const restoredLatest = this.getCurrent(tick.assetId).reduce<MarketCandle | null>((latest, candle) => {
      return !latest || candle.lastTickTimeMs > latest.lastTickTimeMs ? candle : latest;
    }, null);
    if (restoredLatest && tick.pocketTimeMs < restoredLatest.lastTickTimeMs) {
      return { accepted: false, reason: "out_of_order" };
    }
    if (
      restoredLatest &&
      tick.pocketTimeMs === restoredLatest.lastTickTimeMs &&
      tick.price === restoredLatest.close
    ) {
      return { accepted: false, reason: "duplicate" };
    }

    const acceptance = this.quoteBook.accept(tick);
    if (!acceptance.accepted) return acceptance;

    const completed: MarketCandle[] = [];
    const current: MarketCandle[] = [];

    for (const timeframeSeconds of SUPPORTED_TIMEFRAMES) {
      const key = candleKey(tick.assetId, timeframeSeconds);
      const existing = this.current.get(key);
      const targetOpenTime = candleOpenTime(tick.pocketTimeMs, timeframeSeconds);
      let next: MarketCandle;

      if (!existing) {
        next = createCandle(tick, timeframeSeconds);
      } else if (targetOpenTime === existing.openTimeMs) {
        next = updateCandle(existing, tick);
      } else {
        completed.push({ ...existing, isComplete: true });
        next = createCandle(tick, timeframeSeconds);
      }

      this.current.set(key, next);
      current.push(next);
    }

    return { accepted: true, tick, current, completed };
  }

  getCurrent(assetId: string): MarketCandle[] {
    return SUPPORTED_TIMEFRAMES.flatMap((timeframeSeconds) => {
      const candle = this.current.get(candleKey(assetId, timeframeSeconds));
      return candle ? [candle] : [];
    });
  }

  getQuote(assetId: string, nowMs: number, maxAgeMs: number) {
    return this.quoteBook.get(assetId, nowMs, maxAgeMs);
  }
}
