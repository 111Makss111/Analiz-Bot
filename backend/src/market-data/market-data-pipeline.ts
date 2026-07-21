import { CandleEngine, type CandleIngestResult } from "./candle-engine.js";
import type { MarketDataWriter } from "./market-data-writer.js";
import type { MarketCandle, PocketTick, TimeframeSeconds } from "./types.js";

const DEFAULT_FLUSH_INTERVAL_MS = 15_000;
const DEFAULT_TICK_RETENTION_MS = 10 * 60 * 1_000;
const DEFAULT_MAX_TICKS_PER_ASSET = 2_000;
const DEFAULT_MAX_PENDING_CANDLES = 1_000;
const HISTORY_LIMITS: Record<TimeframeSeconds, number> = { 30: 240, 60: 180, 300: 72 };

type PipelineOptions = {
  flushIntervalMs?: number;
  tickRetentionMs?: number;
  maxTicksPerAsset?: number;
  maxPendingCandles?: number;
  now?: () => number;
};

export type MarketDataPipelineStatus = {
  persistence: "unavailable" | "idle" | "ready" | "backoff";
  retainedAssets: number;
  retainedTicks: number;
  retainedCandles: number;
  pendingCompletedCandles: number;
  consecutiveFailures: number;
  retryAt: string | null;
  lastPersistedAt: string | null;
  lastPersistError: string | null;
  droppedCompletedCandles: number;
};

function candleKey(candle: MarketCandle): string {
  return `${candle.assetId}:${candle.timeframeSeconds}:${candle.openTimeMs}`;
}

function seriesKey(assetId: string, timeframeSeconds: TimeframeSeconds): string {
  return `${assetId}:${timeframeSeconds}`;
}

function safeMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error ?? "Unknown persistence error"))
    .replace(/[\r\n]+/g, " ")
    .slice(0, 240);
}

function mergeCandle(previous: MarketCandle, incoming: MarketCandle): MarketCandle {
  const incomingIsLater = incoming.lastTickTimeMs >= previous.lastTickTimeMs;
  return {
    ...previous,
    closeTimeMs: Math.max(previous.closeTimeMs, incoming.closeTimeMs),
    lastTickTimeMs: Math.max(previous.lastTickTimeMs, incoming.lastTickTimeMs),
    high: Math.max(previous.high, incoming.high),
    low: Math.min(previous.low, incoming.low),
    close: incomingIsLater ? incoming.close : previous.close,
    tickCount: Math.max(previous.tickCount, incoming.tickCount),
    isComplete: previous.isComplete || incoming.isComplete
  };
}

export function persistenceBackoffMs(consecutiveFailures: number): number {
  const attempt = Math.max(1, Math.trunc(consecutiveFailures));
  return Math.min(5 * 60_000, 30_000 * 2 ** Math.min(4, attempt - 1));
}

export class MarketDataPipeline {
  private readonly engine = new CandleEngine();
  private readonly ticksByAsset = new Map<string, PocketTick[]>();
  private readonly completedBySeries = new Map<string, Map<number, MarketCandle>>();
  private readonly pendingCompleted = new Map<string, MarketCandle>();
  private readonly flushIntervalMs: number;
  private readonly tickRetentionMs: number;
  private readonly maxTicksPerAsset: number;
  private readonly maxPendingCandles: number;
  private readonly now: () => number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private flushInFlight: Promise<void> | null = null;
  private consecutiveFailures = 0;
  private retryAtMs = 0;
  private lastPersistedAtMs: number | null = null;
  private lastPersistError: string | null = null;
  private droppedCompletedCandles = 0;

  constructor(
    private readonly writer: MarketDataWriter | null,
    private readonly onError: (error: unknown) => void = () => undefined,
    options: PipelineOptions = {}
  ) {
    this.flushIntervalMs = options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
    this.tickRetentionMs = options.tickRetentionMs ?? DEFAULT_TICK_RETENTION_MS;
    this.maxTicksPerAsset = options.maxTicksPerAsset ?? DEFAULT_MAX_TICKS_PER_ASSET;
    this.maxPendingCandles = options.maxPendingCandles ?? DEFAULT_MAX_PENDING_CANDLES;
    this.now = options.now ?? Date.now;
  }

  start(): void {
    if (!this.writer || this.timer) return;
    this.timer = setInterval(() => this.requestFlush(), this.flushIntervalMs);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.flushInFlight) await this.flushInFlight;
    await this.flushNow().catch(() => undefined);
  }

  ingest(tick: PocketTick): CandleIngestResult {
    const result = this.engine.ingest(tick);
    if (!result.accepted) return result;

    this.rememberTick(result.tick);
    for (const candle of result.completed) {
      this.rememberCompleted(candle);
      this.queueCompleted(candle);
    }
    return result;
  }

  getQuote(assetId: string, nowMs: number, maxAgeMs: number) {
    return this.engine.getQuote(assetId, nowMs, maxAgeMs);
  }

  getRecentTicks(assetId: string, sinceMs = Number.NEGATIVE_INFINITY): PocketTick[] {
    this.pruneTicks(assetId, this.now());
    return (this.ticksByAsset.get(assetId) ?? []).filter((tick) => tick.pocketTimeMs >= sinceMs);
  }

  getCandles(
    assetId: string,
    timeframeSeconds: TimeframeSeconds,
    limit = HISTORY_LIMITS[timeframeSeconds],
    includeCurrent = true
  ): MarketCandle[] {
    const completed = [...(this.completedBySeries.get(seriesKey(assetId, timeframeSeconds))?.values() ?? [])];
    const current = includeCurrent
      ? this.engine.getCurrent(assetId).filter((candle) => candle.timeframeSeconds === timeframeSeconds)
      : [];
    return [...completed, ...current]
      .sort((left, right) => left.openTimeMs - right.openTimeMs)
      .slice(-Math.max(1, limit));
  }

  restoreCurrentCandles(candles: MarketCandle[]): void {
    this.engine.restoreCurrent(candles);
  }

  hydrateHistoricalCandles(candles: MarketCandle[]): void {
    for (const candle of candles) {
      if (candle.isComplete) this.rememberCompleted(candle);
    }
  }

  releaseAsset(assetId: string): void {
    this.engine.release(assetId);
    this.ticksByAsset.delete(assetId);
    for (const timeframeSeconds of [30, 60, 300] as const) {
      this.completedBySeries.delete(seriesKey(assetId, timeframeSeconds));
    }
  }

  async persistHistoricalCandles(candles: MarketCandle[]): Promise<void> {
    const completed = candles.filter((candle) => candle.isComplete);
    this.hydrateHistoricalCandles(completed);
    for (const candle of completed) this.queueCompleted(candle);
    this.requestFlush();
    if (this.flushInFlight) await this.flushInFlight;
  }

  requestFlush(): void {
    if (!this.writer || this.flushInFlight || this.pendingCompleted.size === 0) return;
    if (this.now() < this.retryAtMs) return;
    this.flushInFlight = this.flushNow()
      .catch(this.onError)
      .finally(() => {
        this.flushInFlight = null;
      });
  }

  async flushNow(): Promise<void> {
    if (!this.writer || this.pendingCompleted.size === 0 || this.now() < this.retryAtMs) return;

    const batch = [...this.pendingCompleted.values()];
    this.pendingCompleted.clear();
    try {
      await this.writer.persistCompletedCandles(batch);
      this.consecutiveFailures = 0;
      this.retryAtMs = 0;
      this.lastPersistError = null;
      this.lastPersistedAtMs = this.now();
    } catch (error) {
      for (const candle of batch) this.queueCompleted(candle);
      this.consecutiveFailures += 1;
      this.retryAtMs = this.now() + persistenceBackoffMs(this.consecutiveFailures);
      this.lastPersistError = safeMessage(error);
      throw error;
    }
  }

  status(): MarketDataPipelineStatus {
    const retainedTicks = [...this.ticksByAsset.values()].reduce((sum, ticks) => sum + ticks.length, 0);
    const retainedCandles = [...this.completedBySeries.values()].reduce(
      (sum, candles) => sum + candles.size,
      0
    );
    const persistence = !this.writer
      ? "unavailable"
      : this.retryAtMs > this.now()
        ? "backoff"
        : this.lastPersistedAtMs === null
          ? "idle"
          : "ready";
    return {
      persistence,
      retainedAssets: this.ticksByAsset.size,
      retainedTicks,
      retainedCandles,
      pendingCompletedCandles: this.pendingCompleted.size,
      consecutiveFailures: this.consecutiveFailures,
      retryAt: this.retryAtMs > this.now() ? new Date(this.retryAtMs).toISOString() : null,
      lastPersistedAt: this.lastPersistedAtMs ? new Date(this.lastPersistedAtMs).toISOString() : null,
      lastPersistError: this.lastPersistError,
      droppedCompletedCandles: this.droppedCompletedCandles
    };
  }

  private rememberTick(tick: PocketTick): void {
    const ticks = this.ticksByAsset.get(tick.assetId) ?? [];
    ticks.push(tick);
    this.ticksByAsset.set(tick.assetId, ticks);
    this.pruneTicks(tick.assetId, tick.receivedAtMs);
  }

  private pruneTicks(assetId: string, nowMs: number): void {
    const ticks = this.ticksByAsset.get(assetId);
    if (!ticks) return;
    const cutoff = nowMs - this.tickRetentionMs;
    let firstRetained = 0;
    while (firstRetained < ticks.length && ticks[firstRetained]!.receivedAtMs < cutoff) firstRetained += 1;
    if (firstRetained > 0) ticks.splice(0, firstRetained);
    if (ticks.length > this.maxTicksPerAsset) ticks.splice(0, ticks.length - this.maxTicksPerAsset);
    if (ticks.length === 0) this.ticksByAsset.delete(assetId);
  }

  private rememberCompleted(candle: MarketCandle): void {
    if (!candle.isComplete) return;
    const key = seriesKey(candle.assetId, candle.timeframeSeconds);
    const series = this.completedBySeries.get(key) ?? new Map<number, MarketCandle>();
    const previous = series.get(candle.openTimeMs);
    series.set(candle.openTimeMs, previous ? mergeCandle(previous, candle) : candle);
    const limit = HISTORY_LIMITS[candle.timeframeSeconds];
    while (series.size > limit) {
      const oldest = [...series.keys()].sort((left, right) => left - right)[0];
      if (oldest === undefined) break;
      series.delete(oldest);
    }
    this.completedBySeries.set(key, series);
  }

  private queueCompleted(candle: MarketCandle): void {
    if (!candle.isComplete) return;
    const key = candleKey(candle);
    const previous = this.pendingCompleted.get(key);
    this.pendingCompleted.set(key, previous ? mergeCandle(previous, candle) : candle);
    while (this.pendingCompleted.size > this.maxPendingCandles) {
      const oldestKey = this.pendingCompleted.keys().next().value as string | undefined;
      if (!oldestKey) break;
      this.pendingCompleted.delete(oldestKey);
      this.droppedCompletedCandles += 1;
    }
  }
}
