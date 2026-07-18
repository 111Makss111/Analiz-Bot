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

export const SUPPORTED_TIMEFRAMES = [30, 60, 300] as const;
export type TimeframeSeconds = (typeof SUPPORTED_TIMEFRAMES)[number];

export type PocketTick = {
  assetId: string;
  price: number;
  pocketTimeMs: number;
  receivedAtMs: number;
  sequence: string | null;
};

export type MarketCandle = {
  assetId: string;
  timeframeSeconds: TimeframeSeconds;
  openTimeMs: number;
  closeTimeMs: number;
  lastTickTimeMs: number;
  open: number;
  high: number;
  low: number;
  close: number;
  tickCount: number;
  isComplete: boolean;
};

export type StoredCandle = {
  assetId: string;
  timeframeSeconds: TimeframeSeconds;
  openTime: string;
  closeTime: string;
  lastTickAt: string;
  open: number;
  high: number;
  low: number;
  close: number;
  tickCount: number;
  isComplete: boolean;
  receivedAt: string;
};

export type CandleHistoryResponse = {
  ok: true;
  status: "ready" | "warming" | "unavailable";
  assetId: string;
  timeframeSeconds: TimeframeSeconds;
  candles: StoredCandle[];
};
