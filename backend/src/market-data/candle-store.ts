import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  CandleHistoryResponse,
  MarketCandle,
  StoredCandle,
  TimeframeSeconds
} from "./types.js";

type CandleRow = {
  asset_id: unknown;
  timeframe_seconds: unknown;
  open_time: unknown;
  close_time: unknown;
  last_tick_at: unknown;
  open: unknown;
  high: unknown;
  low: unknown;
  close: unknown;
  tick_count: unknown;
  is_complete: unknown;
  received_at: unknown;
};

function mapRow(row: CandleRow): StoredCandle {
  return {
    assetId: String(row.asset_id),
    timeframeSeconds: Number(row.timeframe_seconds) as TimeframeSeconds,
    openTime: String(row.open_time),
    closeTime: String(row.close_time),
    lastTickAt: String(row.last_tick_at),
    open: Number(row.open),
    high: Number(row.high),
    low: Number(row.low),
    close: Number(row.close),
    tickCount: Number(row.tick_count),
    isComplete: row.is_complete === true,
    receivedAt: String(row.received_at)
  };
}

export interface CandleStore {
  list(assetId: string, timeframeSeconds: TimeframeSeconds, limit: number): Promise<CandleHistoryResponse>;
  loadCurrent(assetId: string): Promise<MarketCandle[]>;
  loadCurrentForAssets(assetIds: string[]): Promise<MarketCandle[]>;
  upsert(candles: MarketCandle[]): Promise<void>;
}

export class UnavailableCandleStore implements CandleStore {
  async list(
    assetId: string,
    timeframeSeconds: TimeframeSeconds
  ): Promise<CandleHistoryResponse> {
    return { ok: true, status: "unavailable", assetId, timeframeSeconds, candles: [] };
  }

  async upsert(): Promise<void> {}

  async loadCurrent(): Promise<MarketCandle[]> {
    return [];
  }

  async loadCurrentForAssets(): Promise<MarketCandle[]> {
    return [];
  }
}

export class SupabaseCandleStore implements CandleStore {
  constructor(private readonly client: SupabaseClient) {}

  async list(
    assetId: string,
    timeframeSeconds: TimeframeSeconds,
    limit: number
  ): Promise<CandleHistoryResponse> {
    const { data, error } = await this.client
      .from("candles")
      .select(
        "asset_id,timeframe_seconds,open_time,close_time,last_tick_at,open,high,low,close,tick_count,is_complete,received_at"
      )
      .eq("asset_id", assetId)
      .eq("timeframe_seconds", timeframeSeconds)
      .order("open_time", { ascending: false })
      .limit(limit);

    if (error) throw new Error(`Supabase candle query failed: ${error.message}`);

    const candles = ((data ?? []) as CandleRow[]).map(mapRow).reverse();
    return {
      ok: true,
      status: candles.length > 0 ? "ready" : "warming",
      assetId,
      timeframeSeconds,
      candles
    };
  }

  async upsert(candles: MarketCandle[]): Promise<void> {
    if (candles.length === 0) return;

    const { error } = await this.client.from("candles").upsert(
      candles.map((candle) => ({
        asset_id: candle.assetId,
        timeframe_seconds: candle.timeframeSeconds,
        open_time: new Date(candle.openTimeMs).toISOString(),
        close_time: new Date(candle.closeTimeMs).toISOString(),
        last_tick_at: new Date(candle.lastTickTimeMs).toISOString(),
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
        tick_count: candle.tickCount,
        is_complete: candle.isComplete,
        received_at: new Date().toISOString()
      })),
      { onConflict: "asset_id,timeframe_seconds,open_time" }
    );

    if (error) throw new Error(`Supabase candle upsert failed: ${error.message}`);
  }

  async loadCurrent(assetId: string): Promise<MarketCandle[]> {
    return this.loadCurrentForAssets([assetId]);
  }

  async loadCurrentForAssets(assetIds: string[]): Promise<MarketCandle[]> {
    if (assetIds.length === 0) return [];
    const { data, error } = await this.client
      .from("candles")
      .select(
        "asset_id,timeframe_seconds,open_time,close_time,last_tick_at,open,high,low,close,tick_count,is_complete,received_at"
      )
      .in("asset_id", assetIds)
      .eq("is_complete", false)
      .in("timeframe_seconds", [30, 60, 300])
      .order("open_time", { ascending: false })
      .limit(Math.min(500, assetIds.length * 3));

    if (error) throw new Error(`Supabase current candle query failed: ${error.message}`);

    const latestByAssetTimeframe = new Map<string, MarketCandle>();
    for (const row of (data ?? []) as CandleRow[]) {
      const candle = mapRow(row);
      const key = `${candle.assetId}:${candle.timeframeSeconds}`;
      if (latestByAssetTimeframe.has(key)) continue;
      latestByAssetTimeframe.set(key, {
        assetId: candle.assetId,
        timeframeSeconds: candle.timeframeSeconds,
        openTimeMs: Date.parse(candle.openTime),
        closeTimeMs: Date.parse(candle.closeTime),
        lastTickTimeMs: Date.parse(candle.lastTickAt),
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
        tickCount: candle.tickCount,
        isComplete: candle.isComplete
      });
    }
    return [...latestByAssetTimeframe.values()];
  }
}
