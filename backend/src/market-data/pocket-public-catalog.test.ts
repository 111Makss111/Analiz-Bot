import { describe, expect, it, vi } from "vitest";
import { parsePocketCurrencyCatalog, PocketPublicCatalogSource } from "./pocket-public-catalog.js";

describe("Pocket public currency catalog", () => {
  it("розпізнає Regular та OTC пари, виплати й HTML entities", () => {
    const html = `
      <section>
        <div>EUR/USD</div><strong>81%</strong>
        <div>GBP&#x2F;USD OTC</div><strong>92%</strong>
        <div>AUD/CAD OTC</div><strong>75,5%</strong>
      </section>
    `;

    expect(parsePocketCurrencyCatalog(html)).toEqual([
      expect.objectContaining({
        pocketSymbol: "EUR/USD",
        baseCurrency: "EUR",
        quoteCurrency: "USD",
        marketType: "regular",
        payoutPercent: 81
      }),
      expect.objectContaining({ pocketSymbol: "GBP/USD OTC", marketType: "otc", payoutPercent: 92 }),
      expect.objectContaining({ pocketSymbol: "AUD/CAD OTC", marketType: "otc", payoutPercent: 75.5 })
    ]);
  });

  it("дедуплікує однаковий символ", () => {
    const html = "EUR/USD OTC 80% <span>EUR/USD OTC</span> 91%";
    expect(parsePocketCurrencyCatalog(html)).toEqual([
      expect.objectContaining({ pocketSymbol: "EUR/USD OTC", payoutPercent: 91 })
    ]);
  });

  it("не приймає підозріло коротку відповідь як повний каталог", async () => {
    const fetcher = vi.fn(async () => new Response("EUR/USD OTC 92%", { status: 200 }));
    const source = new PocketPublicCatalogSource(fetcher);

    await expect(source.loadCurrencyCatalog()).rejects.toThrow("only 1 recognized currency assets");
  });

  it("повертає snapshot лише після успішного HTTP-запиту", async () => {
    const html = ["EUR/USD", "GBP/USD", "AUD/CAD", "USD/JPY", "EUR/CHF"]
      .map((pair, index) => `${pair} OTC ${90 - index}%`)
      .join(" ");
    const fetcher = vi.fn(async () => new Response(html, { status: 200 }));
    const source = new PocketPublicCatalogSource(fetcher);

    const snapshot = await source.loadCurrencyCatalog();

    expect(snapshot.source).toBe("pocket-official-assets-page");
    expect(snapshot.assets).toHaveLength(5);
    expect(fetcher).toHaveBeenCalledOnce();
  });
});
