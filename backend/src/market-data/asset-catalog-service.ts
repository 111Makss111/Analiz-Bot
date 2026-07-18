import type { AssetCatalogRepository } from "./asset-catalog-repository.js";
import type {
  AssetCatalogQuery,
  AssetCatalogResponse,
  CurrencyCatalogSnapshot
} from "./types.js";

const REFRESH_INTERVAL_MS = 5 * 60 * 1000;
const STALE_CATALOG_AFTER_MS = 15 * 60 * 1000;

export interface AssetCatalog {
  list(query: AssetCatalogQuery): Promise<AssetCatalogResponse>;
  requestRefresh(): void;
  start(): void;
  stop(): void;
}

type ServiceOptions = {
  repository: AssetCatalogRepository | null;
  source: { loadCurrencyCatalog(): Promise<CurrencyCatalogSnapshot> };
  onRefreshError?: (error: unknown) => void;
};

export class AssetCatalogService implements AssetCatalog {
  private timer: ReturnType<typeof setInterval> | null = null;
  private refreshInFlight: Promise<void> | null = null;

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

    const assets = await this.options.repository.listCurrencyAssets(query);
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
}
