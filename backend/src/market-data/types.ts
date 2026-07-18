export type MarketType = "regular" | "otc";
export type AssetDataState = "warming" | "ready" | "stale" | "unavailable" | "error";
export type AssetCatalogStatus = "ready" | "warming" | "stale" | "unavailable";

export type CurrencyCatalogAsset = {
  pocketSymbol: string;
  displayName: string;
  baseCurrency: string;
  quoteCurrency: string;
  marketType: MarketType;
  payoutPercent: number;
  sourcePayload: Record<string, unknown>;
};

export type AssetSummary = {
  id: string;
  pocketSymbol: string;
  displayName: string;
  baseCurrency: string | null;
  quoteCurrency: string | null;
  marketType: MarketType;
  isAvailable: boolean;
  payoutPercent: number | null;
  dataState: AssetDataState;
  lastQuote: number | null;
  lastQuoteAt: string | null;
  quoteAgeMs: number | null;
  catalogUpdatedAt: string | null;
  catalogAgeMs: number | null;
};

export type AssetCatalogQuery = {
  market: "all" | MarketType;
  search: string;
};

export type AssetCatalogResponse = {
  ok: true;
  category: "currency";
  status: AssetCatalogStatus;
  source: "supabase-cache";
  updatedAt: string | null;
  assets: AssetSummary[];
};

export type CurrencyCatalogSnapshot = {
  source: "pocket-official-assets-page";
  fetchedAt: string;
  assets: CurrencyCatalogAsset[];
};
