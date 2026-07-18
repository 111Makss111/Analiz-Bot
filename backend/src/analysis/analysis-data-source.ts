import type { SupabaseClient } from "@supabase/supabase-js";
import type { CandleStore } from "../market-data/candle-store.js";
import type { AssetDataState, MarketType, StoredCandle } from "../market-data/types.js";
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

type TickRow = {
  pocket_time: unknown;
  received_at: unknown;
  price: unknown;
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

function mapTick(row: TickRow): AnalysisTick | null {
  const timeMs = Date.parse(String(row.pocket_time));
  const receivedAtMs = Date.parse(String(row.received_at));
  const price = Number(row.price);
  return Number.isFinite(timeMs) && Number.isFinite(receivedAtMs) && Number.isFinite(price) && price > 0
    ? { timeMs, receivedAtMs, price }
    : null;
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
    private readonly candleStore: CandleStore
  ) {}

  async load(assetId: string, capturedAtMs: number): Promise<AnalysisSnapshot> {
    const assetRequest = this.client
      .from("assets")
      .select(
        "id,pocket_symbol,display_name,market_type,is_available,payout_percent,data_state,last_quote,last_quote_at"
      )
      .eq("id", assetId)
      .maybeSingle();
    const tickRequest = this.client
      .from("ticks")
      .select("pocket_time,received_at,price")
      .eq("asset_id", assetId)
      .gte("pocket_time", new Date(capturedAtMs - 45_000).toISOString())
      .order("pocket_time", { ascending: false })
      .limit(500);

    const [assetResult, tickResult, candles30s, candlesM1, candlesM5] = await Promise.all([
      assetRequest,
      tickRequest,
      this.candleStore.list(assetId, 30, 90),
      this.candleStore.list(assetId, 60, 90),
      this.candleStore.list(assetId, 300, 30)
    ]);

    if (assetResult.error) throw new Error(`Supabase analysis asset query failed: ${assetResult.error.message}`);
    if (tickResult.error) throw new Error(`Supabase analysis tick query failed: ${tickResult.error.message}`);

    const ticks = ((tickResult.data ?? []) as TickRow[])
      .map(mapTick)
      .filter((tick): tick is AnalysisTick => tick !== null)
      .reverse();
    return {
      asset: mapAsset(assetResult.data as AssetRow | null),
      ticks,
      candles30s: candles30s.candles.map(mapCandle),
      candlesM1: candlesM1.candles.map(mapCandle),
      candlesM5: candlesM5.candles.map(mapCandle),
      capturedAtMs
    };
  }
}
