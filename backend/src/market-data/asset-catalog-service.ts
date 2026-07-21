import type { AssetCatalogRepository } from "./asset-catalog-repository.js";
import type { QuoteSnapshot } from "./quote-book.js";
import type {
  AssetCatalogQuery,
  AssetCatalogResponse,
  AssetSummary,
  CurrencyCatalogSnapshot
} from "./types.js";

const REFRESH_INTERVAL_MS = 5 * 60 * 1000;
const STALE_CATALOG_AFTER_MS = 15 * 60 * 1000;
const METADATA_CACHE_TTL_MS = 30_000;

type LiveQuoteSource = {
  getQuote(assetId: string, nowMs: number, maxAgeMs: number): QuoteSnapshot | null;
};

export type AssetCatalogDiagnostics = {
  cachedAssets: number;
  cacheAgeMs: number | null;
  lastRepositoryError: string | null;
};

export interface AssetCatalog {
  list(query: AssetCatalogQuery): Promise<AssetCatalogResponse>;
  requestRefresh(): void;
  start(): void;
  stop(): void;
  diagnostics(): AssetCatalogDiagnostics;
}

type ServiceOptions = {
  repository: AssetCatalogRepository | null;
  source: { loadCurrencyCatalog(): Promise<CurrencyCatalogSnapshot> };
  liveQuotes?: LiveQuoteSource;
  onRefreshError?: (error: unknown) => void;
};

export class AssetCatalogService implements AssetCatalog {
  private timer: ReturnType<typeof setInterval> | null = null;
  private refreshInFlight: Promise<void> | null = null;
  private cachedAssets: AssetSummary[] | null = null;
  private cacheLoadedAtMs: number | null = null;
  private lastRepositoryError: string | null = null;

  constructor(private readonly options: ServiceOptions) {}

  start(): void {
    if (!this.options.repository || this.timer) return;
    this.requestRefresh();
    this.timer = setInterval(() => this.requestRefresh(), REFRESH_INTERVAL_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  requestRefresh(): void {
    if (!this.options.repository || this.refreshInFlight) return;

    this.refreshInFlight = this.refresh()
      .catch((error: unknown) => this.options.onRefreshError?.(error))
      .finally(() => {
        this.refreshInFlight = null;
      });
  }

  private async refresh(): Promise<void> {
    if (!this.options.repository) return;
    const snapshot = await this.options.source.loadCurrencyCatalog();
    await this.options.repository.replaceCurrencyCatalog(snapshot);
    this.cachedAssets = null;
    this.cacheLoadedAtMs = null;
  }

  async list(query: AssetCatalogQuery): Promise<AssetCatalogResponse> {
    if (!this.options.repository) {
      return {
        ok: true,
        category: "currency",
        status: "unavailable",
        source: "supabase-cache",
        updatedAt: null,
        assets: []
      };
    }

    const now = Date.now();
    let metadata = this.cachedAssets;
    if (!metadata || this.cacheLoadedAtMs === null || now - this.cacheLoadedAtMs > METADATA_CACHE_TTL_MS) {
      try {
        metadata = await this.options.repository.listCurrencyAssets({ market: "all", search: "" });
        this.cachedAssets = metadata;
        this.cacheLoadedAtMs = now;
        this.lastRepositoryError = null;
      } catch (error) {
        this.lastRepositoryError = error instanceof Error ? error.message : String(error);
        if (!metadata) throw error;
      }
    }

    const normalizedSearch = query.search.toLocaleUpperCase("uk-UA");
    const assets = metadata
      .filter((asset) => query.market === "all" || asset.marketType === query.market)
      .filter((asset) =>
        !normalizedSearch
          ? true
          : `${asset.displayName} ${asset.baseCurrency ?? ""} ${asset.quoteCurrency ?? ""}`
              .toLocaleUpperCase("uk-UA")
              .includes(normalizedSearch)
      )
      .map((asset) => this.withLiveQuote(asset, now));
    const updatedAt = assets.reduce<string | null>((latest, asset) => {
      if (!asset.catalogUpdatedAt) return latest;
      return !latest || asset.catalogUpdatedAt > latest ? asset.catalogUpdatedAt : latest;
    }, null);
    const updatedAtMs = updatedAt ? Date.parse(updatedAt) : Number.NaN;
    const catalogAgeMs = Date.now() - updatedAtMs;
    const status =
      assets.length === 0
        ? "warming"
        : !Number.isFinite(updatedAtMs) || catalogAgeMs < -60_000 || catalogAgeMs > STALE_CATALOG_AFTER_MS
          ? "stale"
          : "ready";

    return {
      ok: true,
      category: "currency",
      status,
      source: "supabase-cache",
      updatedAt,
      assets
    };
  }

  diagnostics(): AssetCatalogDiagnostics {
    return {
      cachedAssets: this.cachedAssets?.length ?? 0,
      cacheAgeMs:
        this.cacheLoadedAtMs === null ? null : Math.max(0, Date.now() - this.cacheLoadedAtMs),
      lastRepositoryError: this.lastRepositoryError
    };
  }

  private withLiveQuote(asset: AssetSummary, nowMs: number): AssetSummary {
    if (!this.options.liveQuotes) return asset;
    const quote = this.options.liveQuotes.getQuote(asset.id, nowMs, 15_000);
    if (!quote) {
      return {
        ...asset,
        dataState: asset.isAvailable ? "warming" : "unavailable",
        lastQuote: null,
        lastQuoteAt: null,
        quoteAgeMs: null
      };
    }
    return {
      ...asset,
      dataState: !asset.isAvailable ? "unavailable" : quote.isFresh ? "ready" : "stale",
      lastQuote: quote.tick.price,
      lastQuoteAt: new Date(quote.tick.pocketTimeMs).toISOString(),
      quoteAgeMs: quote.pocketAgeMs
    };
  }
}
