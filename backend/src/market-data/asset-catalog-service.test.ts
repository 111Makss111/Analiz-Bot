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
          pocketSymbol: "EURUSD_otc",
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
    expect(response.assets[0]?.pocketSymbol).toBe("EURUSD_otc");
    expect(repository.listCurrencyAssets).toHaveBeenCalledWith({ market: "all", search: "" });
  });

  it("накладає live-котировку з Render memory без повторного читання Supabase", async () => {
    const now = Date.now();
    const repository: AssetCatalogRepository = {
      replaceCurrencyCatalog: vi.fn(async () => undefined),
      listCurrencyAssets: vi.fn(async () => [
        {
          id: "asset-1",
          pocketSymbol: "EURUSD_otc",
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
          catalogUpdatedAt: new Date(now).toISOString(),
          catalogAgeMs: 0
        }
      ])
    };
    const service = new AssetCatalogService({
      repository,
      source: { loadCurrencyCatalog: vi.fn(async () => snapshot) },
      liveQuotes: {
        getQuote: () => ({
          tick: {
            assetId: "asset-1",
            price: 1.12345,
            pocketTimeMs: now,
            receivedAtMs: now,
            sequence: "1"
          },
          receivedAgeMs: 0,
          pocketAgeMs: 0,
          isFresh: true,
          staleReason: null
        })
      }
    });

    const first = await service.list({ market: "all", search: "" });
    const second = await service.list({ market: "all", search: "" });

    expect(first.assets[0]).toMatchObject({
      dataState: "ready",
      lastQuote: 1.12345,
      quoteAgeMs: 0
    });
    expect(second.assets[0]?.lastQuote).toBe(1.12345);
    expect(repository.listCurrencyAssets).toHaveBeenCalledTimes(1);
  });

  it("повертає останній memory cache під час короткого збою Supabase", async () => {
    vi.useFakeTimers();
    const now = Date.UTC(2026, 6, 21, 8, 0, 0);
    vi.setSystemTime(now);
    const cachedAsset = {
      id: "asset-1",
      pocketSymbol: "EURUSD_otc",
      displayName: "EUR/USD OTC",
      baseCurrency: "EUR",
      quoteCurrency: "USD",
      marketType: "otc" as const,
      isAvailable: true,
      payoutPercent: 92,
      dataState: "warming" as const,
      lastQuote: null,
      lastQuoteAt: null,
      quoteAgeMs: null,
      catalogUpdatedAt: new Date(now).toISOString(),
      catalogAgeMs: 0
    };
    const repository: AssetCatalogRepository = {
      replaceCurrencyCatalog: vi.fn(async () => undefined),
      listCurrencyAssets: vi
        .fn<AssetCatalogRepository["listCurrencyAssets"]>()
        .mockResolvedValueOnce([cachedAsset])
        .mockRejectedValueOnce(new Error("PGRST002"))
    };
    const service = new AssetCatalogService({
      repository,
      source: { loadCurrencyCatalog: vi.fn(async () => snapshot) }
    });

    try {
      await service.list({ market: "all", search: "" });
      vi.setSystemTime(now + 31_000);
      const fallback = await service.list({ market: "all", search: "" });

      expect(fallback.assets).toEqual([cachedAsset]);
      expect(service.diagnostics()).toMatchObject({
        cachedAssets: 1,
        lastRepositoryError: "PGRST002"
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
