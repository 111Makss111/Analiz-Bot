import { describe, expect, it } from "vitest";
import {
  decodePocketPayload,
  describePocketSymbol,
  parsePocketAssets,
  parsePocketHistory,
  parsePocketStream
} from "./pocket-protocol.js";

describe("Pocket read-only protocol parser", () => {
  it("розпізнає Regular та OTC wire symbols", () => {
    expect(describePocketSymbol("EURUSD")).toMatchObject({
      displayName: "EUR/USD",
      marketType: "regular"
    });
    expect(describePocketSymbol("AUDCAD_otc")).toMatchObject({
      displayName: "AUD/CAD OTC",
      marketType: "otc"
    });
    expect(describePocketSymbol("../../secret")).toBeNull();
  });

  it("читає масив живих тиків і нормалізує секунди Pocket у мілісекунди", () => {
    const ticks = parsePocketStream([
      ["AUDCAD_otc", 1_784_392_810, 0.91234, "seq-1"],
      ["EURUSD", 1_784_392_811_000, 1.12345]
    ]);

    expect(ticks).toEqual([
      {
        pocketSymbol: "AUDCAD_otc",
        pocketTimeMs: 1_784_392_810_000,
        price: 0.91234,
        sequence: "seq-1"
      },
      {
        pocketSymbol: "EURUSD",
        pocketTimeMs: 1_784_392_811_000,
        price: 1.12345,
        sequence: null
      }
    ]);
  });

  it("декодує binary JSON та відхиляє довільні байти", () => {
    const bytes = new TextEncoder().encode(JSON.stringify(["EURUSD", 1_784_392_811, 1.1]));
    expect(decodePocketPayload(bytes)).toEqual(["EURUSD", 1_784_392_811, 1.1]);
    expect(decodePocketPayload(new Uint8Array([255, 0, 1]))).toBeNull();
  });

  it("читає live-каталог Pocket без тверджень про біржовий обсяг", () => {
    const assets = parsePocketAssets([
      [5, "AUDCAD_otc", null, null, null, 92, null, null, null, null, null, null, null, null, 1],
      { symbol: "EURUSD", payout: 81, is_active: false }
    ]);

    expect(assets).toEqual([
      expect.objectContaining({
        pocketSymbol: "AUDCAD_otc",
        displayName: "AUD/CAD OTC",
        payoutPercent: 92,
        isAvailable: true
      }),
      expect.objectContaining({
        pocketSymbol: "EURUSD",
        displayName: "EUR/USD",
        payoutPercent: 81,
        isAvailable: false
      })
    ]);
  });

  it("розбирає Pocket history як тики або готові OHLC", () => {
    const ticks = parsePocketHistory({
      asset: "AUDCAD_otc",
      period: 30,
      history: [
        [1_784_392_800, 0.91],
        [1_784_392_810, 0.92]
      ]
    });
    const candles = parsePocketHistory({
      asset: "EURUSD",
      period: 60,
      history: [[1_784_392_800, 1.1, 1.2, 1.05, 1.15]]
    });

    expect(ticks?.ticks).toHaveLength(2);
    expect(candles?.candles).toEqual([
      expect.objectContaining({ open: 1.1, high: 1.2, low: 1.05, close: 1.15 })
    ]);
  });
});
