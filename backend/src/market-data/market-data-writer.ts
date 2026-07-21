import type { SupabaseClient } from "@supabase/supabase-js";
import type { MarketCandle } from "./types.js";

export interface MarketDataWriter {
  persistCompletedCandles(candles: MarketCandle[]): Promise<void>;
}

export class SupabaseMarketDataWriter implements MarketDataWriter {
  constructor(private readonly client: SupabaseClient) {}

  async persistCompletedCandles(candles: MarketCandle[]): Promise<void> {
    const completed = candles.filter((candle) => candle.isComplete);
    if (completed.length === 0) return;

    const { error } = await this.client.rpc("ingest_pocket_completed_candles", {
      p_candles: completed.map((candle) => ({
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
        is_complete: true
      }))
    });

    if (error) throw new Error(`Supabase completed-candle ingest failed: ${error.message}`);
  }
}
