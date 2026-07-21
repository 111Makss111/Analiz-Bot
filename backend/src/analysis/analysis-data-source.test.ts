import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import type { CandleStore } from "../market-data/candle-store.js";
import { MarketDataPipeline } from "../market-data/market-data-pipeline.js";
import { SupabaseAnalysisDataSource } from "./analysis-data-source.js";

describe("SupabaseAnalysisDataSource compact mode", () => {
  it("бере quote і ticks з Render memory та не читає глобальну ticks table", async () => {
    const now = Date.UTC(2026, 6, 21, 8, 0, 0);
    const assetId = "123e4567-e89b-42d3-a456-426614174000";
    const builder = {
      select: vi.fn(() => builder),
      eq: vi.fn(() => builder),
      maybeSingle: vi.fn(async () => ({
        data: {
          id: assetId,
          pocket_symbol: "EURUSD_otc",
          display_name: "EUR/USD OTC",
          market_type: "otc",
          is_available: true,
          payout_percent: 92,
          data_state: "warming",
          last_quote: null,
          last_quote_at: null
        },
        error: null
      }))
    };
    const from = vi.fn(() => builder);
    const client = { from } as unknown as SupabaseClient;
    const candleStore: CandleStore = {
      list: vi.fn(async (_assetId, timeframeSeconds) => ({
        ok: true,
        status: "warming",
        assetId,
        timeframeSeconds,
        candles: []
      }))
    };
    const pipeline = new MarketDataPipeline(null, () => undefined, { now: () => now });
    pipeline.ingest({
      assetId,
      price: 1.12345,
      pocketTimeMs: now - 100,
      receivedAtMs: now - 90,
      sequence: "tick-1"
    });

    const snapshot = await new SupabaseAnalysisDataSource(client, candleStore, pipeline).load(
      assetId,
      now
    );

    expect(from).toHaveBeenCalledTimes(1);
    expect(from).toHaveBeenCalledWith("assets");
    expect(snapshot.asset).toMatchObject({
      dataState: "ready",
      lastQuote: 1.12345,
      lastQuoteAt: new Date(now - 100).toISOString()
    });
    expect(snapshot.ticks).toEqual([
      { timeMs: now - 100, receivedAtMs: now - 90, price: 1.12345 }
    ]);
  });
});
