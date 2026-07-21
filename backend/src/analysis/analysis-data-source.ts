import type { SupabaseClient } from "@supabase/supabase-js";
import type { CandleStore } from "../market-data/candle-store.js";
import type { MarketDataPipeline } from "../market-data/market-data-pipeline.js";
import type {
  AssetDataState,
  MarketCandle,
  MarketType,
  StoredCandle,
  TimeframeSeconds
} from "../market-data/types.js";
import type {
  AnalysisAsset,
  AnalysisCandle,
  AnalysisSnapshot,
  AnalysisTick
} from "./types.js";

type AssetRow = {
  id: unknown;
  pocket_symbol: unknown;
  display_name: unknown;
  market_type: unknown;
  is_available: unknown;
  payout_percent: unknown;
  data_state: unknown;
  last_quote: unknown;
  last_quote_at: unknown;
};

function nullableNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function mapAsset(row: AssetRow | null): AnalysisAsset | null {
  if (!row) return null;
  return {
    id: String(row.id),
    pocketSymbol: String(row.pocket_symbol),
    displayName: String(row.display_name),
    marketType: row.market_type === "otc" ? "otc" : "regular" as MarketType,
    isAvailable: row.is_available === true,
    payoutPercent: nullableNumber(row.payout_percent),
    dataState: String(row.data_state) as AssetDataState,
    lastQuote: nullableNumber(row.last_quote),
    lastQuoteAt: typeof row.last_quote_at === "string" ? row.last_quote_at : null
  };
}

function mapCandle(candle: StoredCandle): AnalysisCandle {
  return {
    timeframeSeconds: candle.timeframeSeconds,
    openTimeMs: Date.parse(candle.openTime),
    closeTimeMs: Date.parse(candle.closeTime),
    open: candle.open,
    high: candle.high,
    low: candle.low,
    close: candle.close,
    tickCount: candle.tickCount,
    isComplete: candle.isComplete
  };
}

function mapLiveCandle(candle: MarketCandle): AnalysisCandle {
  return {
    timeframeSeconds: candle.timeframeSeconds,
    openTimeMs: candle.openTimeMs,
    closeTimeMs: candle.closeTimeMs,
    open: candle.open,
    high: candle.high,
    low: candle.low,
    close: candle.close,
    tickCount: candle.tickCount,
    isComplete: candle.isComplete
  };
}

function mergeCandles(
  stored: StoredCandle[],
  live: MarketCandle[],
  timeframeSeconds: TimeframeSeconds,
  limit: number
): AnalysisCandle[] {
  const merged = new Map<number, AnalysisCandle>();
  for (const candle of stored.map(mapCandle)) merged.set(candle.openTimeMs, candle);
  for (const candle of live.map(mapLiveCandle)) merged.set(candle.openTimeMs, candle);
  return [...merged.values()]
    .filter((candle) => candle.timeframeSeconds === timeframeSeconds)
    .sort((left, right) => left.openTimeMs - right.openTimeMs)
    .slice(-limit);
}

export interface AnalysisDataSource {
  load(assetId: string, capturedAtMs: number): Promise<AnalysisSnapshot>;
}

export class UnavailableAnalysisDataSource implements AnalysisDataSource {
  async load(): Promise<AnalysisSnapshot> {
    throw new Error("Supabase analysis data source is unavailable");
  }
}

export class SupabaseAnalysisDataSource implements AnalysisDataSource {
  constructor(
    private readonly client: SupabaseClient,
    private readonly candleStore: CandleStore,
    private readonly liveData: MarketDataPipeline
  ) {}

  async load(assetId: string, capturedAtMs: number): Promise<AnalysisSnapshot> {
    const assetRequest = this.client
      .from("assets")
      .select(
        "id,pocket_symbol,display_name,market_type,is_available,payout_percent,data_state,last_quote,last_quote_at"
      )
      .eq("id", assetId)
      .maybeSingle();
    const [assetResult, candles30s, candlesM1, candlesM5] = await Promise.all([
      assetRequest,
      this.candleStore.list(assetId, 30, 90),
      this.candleStore.list(assetId, 60, 90),
      this.candleStore.list(assetId, 300, 30)
    ]);

    if (assetResult.error) throw new Error(`Supabase analysis asset query failed: ${assetResult.error.message}`);
    const asset = mapAsset(assetResult.data as AssetRow | null);
    const quote = this.liveData.getQuote(assetId, capturedAtMs, 15_000);
    if (asset) {
      asset.lastQuote = quote?.tick.price ?? null;
      asset.lastQuoteAt = quote ? new Date(quote.tick.pocketTimeMs).toISOString() : null;
      asset.dataState = quote?.isFresh ? "ready" : quote ? "stale" : "warming";
    }

    const ticks: AnalysisTick[] = this.liveData
      .getRecentTicks(assetId, capturedAtMs - 45_000)
      .map((tick) => ({ timeMs: tick.pocketTimeMs, receivedAtMs: tick.receivedAtMs, price: tick.price }));
    return {
      asset,
      ticks,
      candles30s: mergeCandles(
        candles30s.candles,
        this.liveData.getCandles(assetId, 30, 90),
        30,
        90
      ),
      candlesM1: mergeCandles(
        candlesM1.candles,
        this.liveData.getCandles(assetId, 60, 90),
        60,
        90
      ),
      candlesM5: mergeCandles(
        candlesM5.candles,
        this.liveData.getCandles(assetId, 300, 30),
        300,
        30
      ),
      capturedAtMs
    };
  }
}
