import { describe, expect, it, vi } from "vitest";
import { MarketDataPipeline } from "./market-data-pipeline.js";
import type { MarketDataWriter } from "./market-data-writer.js";
import type { MarketCandle, PocketTick } from "./types.js";

function tick(seconds: number, price: number, sequence: string): PocketTick {
  const pocketTimeMs = Date.UTC(2026, 6, 18, 12, 0, seconds);
  return {
    assetId: "123e4567-e89b-42d3-a456-426614174000",
    price,
    pocketTimeMs,
    receivedAtMs: pocketTimeMs + 50,
    sequence
  };
}

describe("MarketDataPipeline", () => {
  it("пакує тики, останні candle snapshots і котировку в один запис", async () => {
    const persist = vi.fn<MarketDataWriter["persist"]>(async () => undefined);
    const pipeline = new MarketDataPipeline({ persist });
    pipeline.ingest(tick(1, 1.1, "1"));
    pipeline.ingest(tick(2, 1.2, "2"));

    await pipeline.flushNow();

    expect(persist).toHaveBeenCalledOnce();
    const [ticks, candles, quotes] = persist.mock.calls[0] ?? [];
    expect(ticks).toHaveLength(2);
    expect(candles).toHaveLength(3);
    expect(candles).toEqual(expect.arrayContaining([expect.objectContaining({ close: 1.2, tickCount: 2 })]));
    expect(quotes).toEqual([expect.objectContaining({ price: 1.2, sequence: "2" })]);
  });

  it("повертає batch у чергу після помилки Supabase", async () => {
    const persist = vi
      .fn<MarketDataWriter["persist"]>()
      .mockRejectedValueOnce(new Error("temporary database error"))
      .mockResolvedValueOnce(undefined);
    const pipeline = new MarketDataPipeline({ persist });
    pipeline.ingest(tick(1, 1.1, "1"));

    await expect(pipeline.flushNow()).rejects.toThrow("temporary database error");
    await expect(pipeline.flushNow()).resolves.toBeUndefined();

    expect(persist).toHaveBeenCalledTimes(2);
    expect(persist.mock.calls[1]?.[0]).toHaveLength(1);
  });

  it("зберігає історичні Pocket candles через той самий writer", async () => {
    const persist = vi.fn<MarketDataWriter["persist"]>(async () => undefined);
    const pipeline = new MarketDataPipeline({ persist });
    const candle: MarketCandle = {
      assetId: "123e4567-e89b-42d3-a456-426614174000",
      timeframeSeconds: 60,
      openTimeMs: Date.UTC(2026, 6, 18, 12, 0, 0),
      closeTimeMs: Date.UTC(2026, 6, 18, 12, 1, 0),
      lastTickTimeMs: Date.UTC(2026, 6, 18, 12, 0, 50),
      open: 1.1,
      high: 1.2,
      low: 1.05,
      close: 1.15,
      tickCount: 20,
      isComplete: true
    };

    await pipeline.persistHistoricalCandles([candle]);

    expect(persist).toHaveBeenCalledWith([], [candle], []);
  });
});
