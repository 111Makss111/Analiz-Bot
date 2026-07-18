import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  AssetCatalogQuery,
  AssetDataState,
  AssetSummary,
  CurrencyCatalogSnapshot,
  MarketType
} from "./types.js";

type AssetRow = {
  id: unknown;
  pocket_symbol: unknown;
  display_name: unknown;
  base_currency: unknown;
  quote_currency: unknown;
  market_type: unknown;
  is_available: unknown;
  payout_percent: unknown;
  data_state: unknown;
  last_quote: unknown;
  last_quote_at: unknown;
  catalog_updated_at: unknown;
};

const MARKET_TYPES = new Set<MarketType>(["regular", "otc"]);
const DATA_STATES = new Set<AssetDataState>(["warming", "ready", "stale", "unavailable", "error"]);

function nullableNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
function nullableString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function ageMs(value: string | null, now: number): number | null {
  if (!value) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.max(0, now - timestamp) : null;
}

function mapAssetRow(row: AssetRow, now: number): AssetSummary {
  const marketType = MARKET_TYPES.has(row.market_type as MarketType)
    ? (row.market_type as MarketType)
    : "regular";
  const dataState = DATA_STATES.has(row.data_state as AssetDataState)
    ? (row.data_state as AssetDataState)
    : "error";
  const lastQuoteAt = nullableString(row.last_quote_at);
  const catalogUpdatedAt = nullableString(row.catalog_updated_at);
  const quoteAgeMs = ageMs(lastQuoteAt, now);
  const effectiveDataState =
    dataState === "ready" && (quoteAgeMs === null || quoteAgeMs > 15_000) ? "stale" : dataState;

  return {
    id: String(row.id),
    pocketSymbol: String(row.pocket_symbol),
    displayName: String(row.display_name),
    baseCurrency: nullableString(row.base_currency),
    quoteCurrency: nullableString(row.quote_currency),
    marketType,
    isAvailable: row.is_available === true,
    payoutPercent: nullableNumber(row.payout_percent),
    dataState: effectiveDataState,
    lastQuote: nullableNumber(row.last_quote),
    lastQuoteAt,
    quoteAgeMs,
    catalogUpdatedAt,
    catalogAgeMs: ageMs(catalogUpdatedAt, now)
  };
}

export interface AssetCatalogRepository {
  replaceCurrencyCatalog(snapshot: CurrencyCatalogSnapshot): Promise<void>;
  listCurrencyAssets(query: AssetCatalogQuery): Promise<AssetSummary[]>;
}

export class SupabaseAssetCatalogRepository implements AssetCatalogRepository {
  constructor(private readonly client: SupabaseClient) {}

  async replaceCurrencyCatalog(snapshot: CurrencyCatalogSnapshot): Promise<void> {
    const { error } = await this.client.rpc("replace_currency_asset_catalog", {
      p_assets: snapshot.assets.map((asset) => ({
        pocket_symbol: asset.pocketSymbol,
        display_name: asset.displayName,
        base_currency: asset.baseCurrency,
        quote_currency: asset.quoteCurrency,
        market_type: asset.marketType,
        payout_percent: asset.payoutPercent,
        catalog_payload: asset.sourcePayload
      })),
      p_source: snapshot.source,
      p_fetched_at: snapshot.fetchedAt
    });

    if (error) throw new Error(`Supabase catalog replacement failed: ${error.message}`);
  }

  async listCurrencyAssets(query: AssetCatalogQuery): Promise<AssetSummary[]> {
    let request = this.client
      .from("assets")
      .select(
        "id,pocket_symbol,display_name,base_currency,quote_currency,market_type,is_available,payout_percent,data_state,last_quote,last_quote_at,catalog_updated_at"
      )
      .eq("asset_category", "currency")
      .order("is_available", { ascending: false })
      .order("payout_percent", { ascending: false, nullsFirst: false })
      .order("display_name", { ascending: true })
      .limit(500);

    if (query.market !== "all") request = request.eq("market_type", query.market);
    if (query.search) {
      const safeSearch = query.search.replace(/[%_]/g, "").slice(0, 60);
      if (safeSearch) request = request.ilike("display_name", `%${safeSearch}%`);
    }

    const { data, error } = await request;
    if (error) throw new Error(`Supabase catalog query failed: ${error.message}`);

    const now = Date.now();
    return ((data ?? []) as AssetRow[]).map((row) => mapAssetRow(row, now));
  }
}
