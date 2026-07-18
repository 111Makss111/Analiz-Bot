import { describe, expect, it, vi } from "vitest";
import type { AssetCatalogRepository } from "./asset-catalog-repository.js";
import { AssetCatalogService } from "./asset-catalog-service.js";
import type { CurrencyCatalogSnapshot } from "./types.js";

const snapshot: CurrencyCatalogSnapshot = {
  source: "pocket-official-assets-page",
  fetchedAt: "2026-07-18T12:00:00.000Z",
  assets: []
};

describe("AssetCatalogService", () => {
  it("повертає unavailable без Supabase і не викликає Pocket", async () => {
    const source = { loadCurrencyCatalog: vi.fn(async () => snapshot) };
    const service = new AssetCatalogService({ repository: null, source });

    service.start();
    service.requestRefresh();

    await expect(service.list({ market: "all", search: "" })).resolves.toMatchObject({
      ok: true,
      status: "unavailable",
      assets: []
    });
    expect(source.loadCurrencyCatalog).not.toHaveBeenCalled();
  });

  it("читає кеш незалежно від фонового refresh", async () => {
    const repository: AssetCatalogRepository = {
      replaceCurrencyCatalog: vi.fn(async () => undefined),
      listCurrencyAssets: vi.fn(async () => [
        {
          id: "asset-1",
          pocketSymbol: "EUR/USD OTC",
          displayName: "EUR/USD OTC",
          baseCurrency: "EUR",
          quoteCurrency: "USD",
          marketType: "otc",
          isAvailable: true,
          payoutPercent: 92,
          dataState: "warming",
          lastQuote: null,
          lastQuoteAt: null,
          quoteAgeMs: null,
          catalogUpdatedAt: snapshot.fetchedAt,
          catalogAgeMs: 1000
        }
      ])
    };
    const service = new AssetCatalogService({
      repository,
      source: { loadCurrencyCatalog: vi.fn(async () => snapshot) }
    });

    const response = await service.list({ market: "otc", search: "EUR" });

    expect(response.status).toBe("stale");
    expect(response.updatedAt).toBe(snapshot.fetchedAt);
    expect(response.assets[0]?.pocketSymbol).toBe("EUR/USD OTC");
    expect(repository.listCurrencyAssets).toHaveBeenCalledWith({ market: "otc", search: "EUR" });
  });
});
