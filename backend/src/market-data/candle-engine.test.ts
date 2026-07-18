import { describe, expect, it } from "vitest";
import { CandleEngine, candleOpenTime } from "./candle-engine.js";
import type { PocketTick } from "./types.js";

const minuteOpen = Date.UTC(2026, 6, 18, 12, 0, 0);

function tick(seconds: number, price: number, sequence: string): PocketTick {
  const pocketTimeMs = minuteOpen + seconds * 1000;
  return {
    assetId: "asset-1",
    price,
    pocketTimeMs,
    receivedAtMs: pocketTimeMs + 80,
    sequence
  };
}

describe("CandleEngine", () => {
  it("вирівнює свічки за Pocket server time", () => {
    expect(candleOpenTime(minuteOpen + 44_999, 30)).toBe(minuteOpen + 30_000);
    expect(candleOpenTime(minuteOpen + 59_999, 60)).toBe(minuteOpen);
    expect(candleOpenTime(minuteOpen + 299_999, 300)).toBe(minuteOpen);
  });

  it("формує OHLC і tick_count одночасно для 30s, M1 та M5", () => {
    const engine = new CandleEngine();
    engine.ingest(tick(2, 1.1, "1"));
    engine.ingest(tick(10, 1.14, "2"));
    const result = engine.ingest(tick(20, 1.08, "3"));

    expect(result).toMatchObject({ accepted: true, completed: [] });
    if (!result.accepted) throw new Error("tick rejected");
    expect(result.current).toHaveLength(3);
    expect(result.current).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          timeframeSeconds: 60,
          open: 1.1,
          high: 1.14,
          low: 1.08,
          close: 1.08,
          tickCount: 3,
          isComplete: false
        })
      ])
    );
  });

  it("закриває тільки фактичні попередні buckets і не вигадує свічки у прогалинах", () => {
    const engine = new CandleEngine();
    engine.ingest(tick(5, 1.1, "1"));
    const result = engine.ingest(tick(185, 1.2, "2"));

    if (!result.accepted) throw new Error("tick rejected");
    expect(result.completed).toHaveLength(2);
    expect(result.completed.map((candle) => candle.timeframeSeconds).sort()).toEqual([30, 60]);
    expect(result.completed.every((candle) => candle.tickCount === 1 && candle.isComplete)).toBe(true);
    expect(result.current).toHaveLength(3);
  });

  it("не змінює свічки старим або дубльованим тиком", () => {
    const engine = new CandleEngine();
    engine.ingest(tick(10, 1.1, "1"));

    expect(engine.ingest(tick(10, 1.1, "1"))).toEqual({ accepted: false, reason: "duplicate" });
    expect(engine.ingest(tick(9, 1.3, "0"))).toEqual({ accepted: false, reason: "out_of_order" });
    expect(engine.getCurrent("asset-1").every((candle) => candle.tickCount === 1)).toBe(true);
  });

  it("продовжує незакриту свічку після відновлення з Supabase", () => {
    const engine = new CandleEngine();
    engine.restoreCurrent([
      {
        assetId: "asset-1",
        timeframeSeconds: 60,
        openTimeMs: minuteOpen,
        closeTimeMs: minuteOpen + 60_000,
        lastTickTimeMs: minuteOpen + 15_000,
        open: 1.1,
        high: 1.2,
        low: 1.05,
        close: 1.15,
        tickCount: 4,
        isComplete: false
      }
    ]);

    expect(engine.ingest(tick(10, 1.3, "old"))).toEqual({
      accepted: false,
      reason: "out_of_order"
    });

    const result = engine.ingest(tick(20, 1.08, "5"));

    if (!result.accepted) throw new Error("tick rejected");
    expect(result.current).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          timeframeSeconds: 60,
          open: 1.1,
          high: 1.2,
          low: 1.05,
          close: 1.08,
          tickCount: 5
        })
      ])
    );
  });
});
