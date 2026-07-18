import { describe, expect, it } from "vitest";
import { QuoteBook } from "./quote-book.js";
import type { PocketTick } from "./types.js";

const baseTick: PocketTick = {
  assetId: "asset-1",
  price: 1.1,
  pocketTimeMs: 1_700_000_000_000,
  receivedAtMs: 1_700_000_000_100,
  sequence: "1"
};

describe("QuoteBook", () => {
  it("відхиляє пошкоджені, дубльовані та старі тики", () => {
    const quotes = new QuoteBook();

    expect(quotes.accept({ ...baseTick, price: 0 })).toEqual({ accepted: false, reason: "invalid" });
    expect(quotes.accept(baseTick)).toMatchObject({ accepted: true });
    expect(quotes.accept(baseTick)).toEqual({ accepted: false, reason: "duplicate" });
    expect(quotes.accept({ ...baseTick, pocketTimeMs: baseTick.pocketTimeMs - 1 })).toEqual({
      accepted: false,
      reason: "out_of_order"
    });
  });

  it("окремо перевіряє вік отримання і Pocket timestamp", () => {
    const quotes = new QuoteBook();
    quotes.accept(baseTick);

    expect(quotes.get(baseTick.assetId, baseTick.receivedAtMs + 900, 1_000)).toMatchObject({
      isFresh: true,
      staleReason: null
    });
    expect(quotes.get(baseTick.assetId, baseTick.receivedAtMs + 2_000, 1_000)).toMatchObject({
      isFresh: false,
      staleReason: "received_age"
    });
  });

  it("не вважає майбутній Pocket timestamp свіжою ціною", () => {
    const quotes = new QuoteBook();
    quotes.accept({ ...baseTick, pocketTimeMs: baseTick.receivedAtMs + 5_000 });

    expect(quotes.get(baseTick.assetId, baseTick.receivedAtMs, 10_000)).toMatchObject({
      isFresh: false,
      staleReason: "clock_skew"
    });
  });
});
