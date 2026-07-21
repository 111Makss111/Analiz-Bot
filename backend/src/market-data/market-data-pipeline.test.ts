import { describe, expect, it, vi } from "vitest";
import { MarketDataPipeline, persistenceBackoffMs } from "./market-data-pipeline.js";
import type { MarketDataWriter } from "./market-data-writer.js";
import type { MarketCandle, PocketTick } from "./types.js";

const BASE_TIME = Date.UTC(2026, 6, 18, 12, 0, 0);

function tick(seconds: number, price: number, sequence: string): PocketTick {
  const pocketTimeMs = BASE_TIME + seconds * 1_000;
  return {
    assetId: "123e4567-e89b-42d3-a456-426614174000",
    price,
    pocketTimeMs,
    receivedAtMs: pocketTimeMs + 50,
    sequence
  };
}

describe("MarketDataPipeline", () => {
  it("тримає live ticks і поточні свічки в пам’яті та записує лише закриті свічки", async () => {
    const persistCompletedCandles = vi.fn<MarketDataWriter["persistCompletedCandles"]>(
      async () => undefined
    );
    let nowMs = BASE_TIME + 2_000;
    const pipeline = new MarketDataPipeline(
      { persistCompletedCandles },
      () => undefined,
      { now: () => nowMs }
    );
    pipeline.ingest(tick(1, 1.1, "1"));
    pipeline.ingest(tick(2, 1.2, "2"));

    await pipeline.flushNow();

    expect(persistCompletedCandles).not.toHaveBeenCalled();
    expect(pipeline.getRecentTicks(tick(1, 1.1, "1").assetId, BASE_TIME)).toHaveLength(2);
    expect(pipeline.getCandles(tick(1, 1.1, "1").assetId, 30, 10)).toEqual([
      expect.objectContaining({ close: 1.2, tickCount: 2, isComplete: false })
    ]);

    nowMs = BASE_TIME + 31_000;
    pipeline.ingest(tick(31, 1.15, "3"));
    await pipeline.flushNow();

    expect(persistCompletedCandles).toHaveBeenCalledOnce();
    expect(persistCompletedCandles.mock.calls[0]?.[0]).toEqual([
      expect.objectContaining({ timeframeSeconds: 30, close: 1.2, isComplete: true })
    ]);
    expect(pipeline.status()).toMatchObject({ retainedTicks: 3, pendingCompletedCandles: 0 });
  });

  it("після помилки відкриває backoff і не атакує Supabase щосекунди", async () => {
    let nowMs = BASE_TIME + 31_000;
    const persistCompletedCandles = vi
      .fn<MarketDataWriter["persistCompletedCandles"]>()
      .mockRejectedValueOnce(new Error("temporary database error"))
      .mockResolvedValueOnce(undefined);
    const pipeline = new MarketDataPipeline(
      { persistCompletedCandles },
      () => undefined,
      { now: () => nowMs }
    );
    pipeline.ingest(tick(1, 1.1, "1"));
    pipeline.ingest(tick(31, 1.2, "2"));

    await expect(pipeline.flushNow()).rejects.toThrow("temporary database error");
    await expect(pipeline.flushNow()).resolves.toBeUndefined();
    expect(persistCompletedCandles).toHaveBeenCalledTimes(1);
    expect(pipeline.status()).toMatchObject({
      persistence: "backoff",
      consecutiveFailures: 1,
      pendingCompletedCandles: 1
    });

    nowMs += persistenceBackoffMs(1);
    await pipeline.flushNow();
    expect(persistCompletedCandles).toHaveBeenCalledTimes(2);
    expect(pipeline.status()).toMatchObject({ persistence: "ready", consecutiveFailures: 0 });
  });

  it("обмежено зберігає Pocket history тим самим low-volume writer", async () => {
    const persistCompletedCandles = vi.fn<MarketDataWriter["persistCompletedCandles"]>(
      async () => undefined
    );
    const pipeline = new MarketDataPipeline({ persistCompletedCandles });
    const candle: MarketCandle = {
      assetId: "123e4567-e89b-42d3-a456-426614174000",
      timeframeSeconds: 60,
      openTimeMs: BASE_TIME,
      closeTimeMs: BASE_TIME + 60_000,
      lastTickTimeMs: BASE_TIME + 50_000,
      open: 1.1,
      high: 1.2,
      low: 1.05,
      close: 1.15,
      tickCount: 20,
      isComplete: true
    };

    await pipeline.persistHistoricalCandles([candle]);

    expect(persistCompletedCandles).toHaveBeenCalledWith([candle]);
    expect(pipeline.getCandles(candle.assetId, 60, 10, false)).toEqual([candle]);
  });

  it("жорстко обмежує in-memory tick buffer вибраного активу", () => {
    let nowMs = BASE_TIME;
    const pipeline = new MarketDataPipeline(null, () => undefined, {
      now: () => nowMs,
      maxTicksPerAsset: 2,
      tickRetentionMs: 2_000
    });
    pipeline.ingest(tick(0, 1.1, "0"));
    nowMs = BASE_TIME + 1_000;
    pipeline.ingest(tick(1, 1.2, "1"));
    nowMs = BASE_TIME + 2_000;
    pipeline.ingest(tick(2, 1.3, "2"));

    expect(pipeline.getRecentTicks(tick(0, 1.1, "0").assetId, 0).map((value) => value.price)).toEqual([
      1.2,
      1.3
    ]);

    nowMs = BASE_TIME + 5_000;
    expect(pipeline.getRecentTicks(tick(0, 1.1, "0").assetId, 0)).toEqual([]);
  });

  it("звільняє live RAM активу після контрольованої відписки", () => {
    const pipeline = new MarketDataPipeline(null, () => undefined, { now: () => BASE_TIME + 1_000 });
    const sample = tick(1, 1.2, "1");
    pipeline.ingest(sample);

    pipeline.releaseAsset(sample.assetId);

    expect(pipeline.getQuote(sample.assetId, BASE_TIME + 1_000, 15_000)).toBeNull();
    expect(pipeline.getRecentTicks(sample.assetId, 0)).toEqual([]);
    expect(pipeline.getCandles(sample.assetId, 30, 10)).toEqual([]);
  });
});
