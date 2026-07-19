import { describe, expect, it } from "vitest";
import type { AnalysisDataSource } from "./analysis-data-source.js";
import { AnalysisError, AnalysisService } from "./analysis-service.js";
import type {
  AnalysisCandle,
  AnalysisSnapshot,
  AnalysisTick
} from "./types.js";

const CAPTURED_AT = Date.UTC(2026, 6, 18, 18, 30, 0);

function candles(
  timeframeSeconds: 30 | 60 | 300,
  count: number,
  direction: 1 | -1,
  endAtMs = CAPTURED_AT
): AnalysisCandle[] {
  const durationMs = timeframeSeconds * 1_000;
  const step = timeframeSeconds === 30 ? 0.00008 : timeframeSeconds === 60 ? 0.00014 : 0.00032;
  return Array.from({ length: count }, (_, index) => {
    const openTimeMs = endAtMs - (count - index) * durationMs;
    const open = 1 + direction * step * index;
    const close = open + direction * step * 0.72;
    return {
      timeframeSeconds,
      openTimeMs,
      closeTimeMs: openTimeMs + durationMs,
      open,
      high: Math.max(open, close) + step * 0.24,
      low: Math.min(open, close) - step * 0.24,
      close,
      tickCount: timeframeSeconds,
      isComplete: true
    };
  });
}

function ticks(quote: number, direction: 1 | -1): AnalysisTick[] {
  return Array.from({ length: 31 }, (_, index) => ({
    timeMs: CAPTURED_AT - (30 - index) * 1_000,
    receivedAtMs: CAPTURED_AT - (30 - index) * 1_000 + 30,
    price: quote - direction * 0.0003 + direction * index * 0.00001
  }));
}

function snapshot(
  direction: 1 | -1,
  options: { payout?: number; marketType?: "regular" | "otc"; quoteAgeMs?: number } = {}
): AnalysisSnapshot {
  const candlesM1 = candles(60, 45, direction);
  const quote = candlesM1.at(-1)!.close + direction * 0.00008;
  const quoteAgeMs = options.quoteAgeMs ?? 200;
  return {
    asset: {
      id: "123e4567-e89b-42d3-a456-426614174000",
      pocketSymbol: options.marketType === "regular" ? "EURUSD" : "EURUSD_otc",
      displayName: options.marketType === "regular" ? "EUR/USD" : "EUR/USD OTC",
      marketType: options.marketType ?? "otc",
      isAvailable: true,
      payoutPercent: options.payout ?? 92,
      dataState: quoteAgeMs > 15_000 ? "stale" : "ready",
      lastQuote: quote,
      lastQuoteAt: new Date(CAPTURED_AT - quoteAgeMs).toISOString()
    },
    ticks: ticks(quote, direction),
    candles30s: candles(30, 50, direction),
    candlesM1,
    candlesM5: candles(300, 12, direction),
    capturedAtMs: CAPTURED_AT
  };
}

function serviceFor(value: AnalysisSnapshot): AnalysisService {
  const source: AnalysisDataSource = { load: async () => value };
  return new AnalysisService(source, () => CAPTURED_AT);
}

describe("deterministic analysis service", () => {
  it("повертає ВГОРУ для узгодженого висхідного Pocket-потоку", async () => {
    const result = await serviceFor(snapshot(1)).analyze({
      assetId: "123e4567-e89b-42d3-a456-426614174000",
      expirationMinutes: 1
    });

    expect(result).toMatchObject({
      direction: "up",
      strengthIsProbability: false,
      expirationSeconds: 60,
      algorithmVersion: "market-pulse-deterministic-otc-v1.0.0"
    });
    expect(result.strengthScore).toBeGreaterThan(25);
    expect(result.reasons.length).toBeGreaterThan(0);
  });

  it("повертає ВНИЗ для узгодженого низхідного Pocket-потоку", async () => {
    const result = await serviceFor(snapshot(-1)).analyze({
      assetId: "123e4567-e89b-42d3-a456-426614174000",
      expirationMinutes: 3
    });

    expect(result.direction).toBe("down");
    expect(result.expirationSeconds).toBe(180);
  });

  it("виплата не впливає на напрям, score, силу або пояснення", async () => {
    const highPayout = await serviceFor(snapshot(1, { payout: 92 })).analyze({
      assetId: "123e4567-e89b-42d3-a456-426614174000",
      expirationMinutes: 2
    });
    const lowPayout = await serviceFor(snapshot(1, { payout: 10 })).analyze({
      assetId: "123e4567-e89b-42d3-a456-426614174000",
      expirationMinutes: 2
    });

    expect(lowPayout.payoutPercent).toBe(10);
    expect({
      direction: lowPayout.direction,
      score: lowPayout.strengthScore,
      strength: lowPayout.strength,
      explanation: lowPayout.explanation
    }).toEqual({
      direction: highPayout.direction,
      score: highPayout.strengthScore,
      strength: highPayout.strength,
      explanation: highPayout.explanation
    });
  });

  it("використовує окрему версію алгоритму для Regular", async () => {
    const result = await serviceFor(snapshot(1, { marketType: "regular" })).analyze({
      assetId: "123e4567-e89b-42d3-a456-426614174000",
      expirationMinutes: 2
    });

    expect(result.algorithmVersion).toBe("market-pulse-deterministic-regular-v1.0.0");
  });

  it("не вигадує напрям за застарілою котировкою", async () => {
    const service = serviceFor(snapshot(1, { quoteAgeMs: 20_000 }));

    await expect(
      service.analyze({
        assetId: "123e4567-e89b-42d3-a456-426614174000",
        expirationMinutes: 1
      })
    ).rejects.toMatchObject<Partial<AnalysisError>>({ code: "QUOTE_STALE", statusCode: 503 });
  });

  it("повертає технічну помилку без 21 M1-свічки", async () => {
    const incomplete = snapshot(1);
    incomplete.candlesM1 = incomplete.candlesM1.slice(-10);

    await expect(
      serviceFor(incomplete).analyze({
        assetId: "123e4567-e89b-42d3-a456-426614174000",
        expirationMinutes: 1
      })
    ).rejects.toMatchObject<Partial<AnalysisError>>({ code: "M1_HISTORY_INSUFFICIENT" });
  });
});
