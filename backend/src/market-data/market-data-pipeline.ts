import { CandleEngine, type CandleIngestResult } from "./candle-engine.js";
import type { MarketDataWriter } from "./market-data-writer.js";
import type { MarketCandle, PocketTick } from "./types.js";

const FLUSH_INTERVAL_MS = 1_000;
const FLUSH_TICK_THRESHOLD = 500;
const MAX_BUFFERED_TICKS = 5_000;

function candleKey(candle: MarketCandle): string {
  return `${candle.assetId}:${candle.timeframeSeconds}:${candle.openTimeMs}`;
}

function newerTick(left: PocketTick, right: PocketTick): PocketTick {
  return left.pocketTimeMs >= right.pocketTimeMs ? left : right;
}

export class MarketDataPipeline {
  private readonly engine = new CandleEngine();
  private readonly ticks: PocketTick[] = [];
  private readonly candles = new Map<string, MarketCandle>();
  private readonly quotes = new Map<string, PocketTick>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private flushInFlight: Promise<void> | null = null;

  constructor(
    private readonly writer: MarketDataWriter | null,
    private readonly onError: (error: unknown) => void = () => undefined
  ) {}

  start(): void {
    if (!this.writer || this.timer) return;
    this.timer = setInterval(() => this.requestFlush(), FLUSH_INTERVAL_MS);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.flushInFlight) await this.flushInFlight;
    await this.flushNow();
  }

  ingest(tick: PocketTick): CandleIngestResult {
    const result = this.engine.ingest(tick);
    if (!result.accepted) return result;

    this.ticks.push(result.tick);
    if (this.ticks.length > MAX_BUFFERED_TICKS) {
      this.ticks.splice(0, this.ticks.length - MAX_BUFFERED_TICKS);
      this.onError(new Error("Pocket tick buffer overflow; oldest ticks were dropped"));
    }

    for (const candle of [...result.completed, ...result.current]) {
      this.candles.set(candleKey(candle), candle);
    }
    const previousQuote = this.quotes.get(tick.assetId);
    this.quotes.set(tick.assetId, previousQuote ? newerTick(previousQuote, tick) : tick);

    if (this.ticks.length >= FLUSH_TICK_THRESHOLD) this.requestFlush();
    return result;
  }

  getQuote(assetId: string, nowMs: number, maxAgeMs: number) {
    return this.engine.getQuote(assetId, nowMs, maxAgeMs);
  }

  restoreCurrentCandles(candles: MarketCandle[]): void {
    this.engine.restoreCurrent(candles);
  }

  async persistHistoricalCandles(candles: MarketCandle[]): Promise<void> {
    if (!this.writer || candles.length === 0) return;
    await this.writer.persist([], candles, []);
  }

  requestFlush(): void {
    if (!this.writer || this.flushInFlight) return;
    this.flushInFlight = this.flushNow()
      .catch(this.onError)
      .finally(() => {
        this.flushInFlight = null;
      });
  }

  async flushNow(): Promise<void> {
    if (!this.writer) return;

    const ticks = this.ticks.splice(0);
    const candles = [...this.candles.values()];
    const quotes = [...this.quotes.values()];
    this.candles.clear();
    this.quotes.clear();
    if (ticks.length === 0 && candles.length === 0 && quotes.length === 0) return;

    try {
      await this.writer.persist(ticks, candles, quotes);
    } catch (error) {
      this.ticks.unshift(...ticks);
      if (this.ticks.length > MAX_BUFFERED_TICKS) {
        this.ticks.splice(0, this.ticks.length - MAX_BUFFERED_TICKS);
      }
      for (const candle of candles) {
        const key = candleKey(candle);
        const queued = this.candles.get(key);
        if (!queued || candle.tickCount > queued.tickCount || candle.isComplete) {
          this.candles.set(key, candle);
        }
      }
      for (const quote of quotes) {
        const queued = this.quotes.get(quote.assetId);
        this.quotes.set(quote.assetId, queued ? newerTick(queued, quote) : quote);
      }
      throw error;
    }
  }
}
