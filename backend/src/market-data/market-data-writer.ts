import type { SupabaseClient } from "@supabase/supabase-js";
import type { MarketCandle, PocketTick } from "./types.js";

export interface MarketDataWriter {
  persist(ticks: PocketTick[], candles: MarketCandle[], quotes: PocketTick[]): Promise<void>;
}

export class SupabaseMarketDataWriter implements MarketDataWriter {
  constructor(private readonly client: SupabaseClient) {}

  async persist(ticks: PocketTick[], candles: MarketCandle[], quotes: PocketTick[]): Promise<void> {
    if (ticks.length === 0 && candles.length === 0 && quotes.length === 0) return;

    const { error } = await this.client.rpc("ingest_pocket_market_data", {
      p_ticks: ticks.map((tick) => ({
        asset_id: tick.assetId,
        pocket_time: new Date(tick.pocketTimeMs).toISOString(),
        received_at: new Date(tick.receivedAtMs).toISOString(),
        price: tick.price,
        pocket_sequence: tick.sequence
      })),
      p_candles: candles.map((candle) => ({
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
        is_complete: candle.isComplete
      })),
      p_quotes: quotes.map((quote) => ({
        asset_id: quote.assetId,
        pocket_time: new Date(quote.pocketTimeMs).toISOString(),
        received_at: new Date(quote.receivedAtMs).toISOString(),
        price: quote.price
      }))
    });

    if (error) throw new Error(`Supabase market-data ingest failed: ${error.message}`);
  }
}
