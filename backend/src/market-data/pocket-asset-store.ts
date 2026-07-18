import type { SupabaseClient } from "@supabase/supabase-js";
import type { PocketLiveAsset } from "./pocket-protocol.js";
import type { MarketType } from "./types.js";

export type CollectorAsset = {
  id: string;
  pocketSymbol: string;
  displayName: string;
  marketType: MarketType;
};

type AssetRow = {
  id: unknown;
  pocket_symbol: unknown;
  display_name: unknown;
  market_type: unknown;
};

function mapAsset(row: AssetRow): CollectorAsset {
  return {
    id: String(row.id),
    pocketSymbol: String(row.pocket_symbol),
    displayName: String(row.display_name),
    marketType: row.market_type === "otc" ? "otc" : "regular"
  };
}

export interface PocketAssetStore {
  listActive(limit: number): Promise<CollectorAsset[]>;
  findById(assetId: string): Promise<CollectorAsset | null>;
  applyLiveCatalog(assets: PocketLiveAsset[], receivedAt: string): Promise<void>;
}

export class SupabasePocketAssetStore implements PocketAssetStore {
  constructor(private readonly client: SupabaseClient) {}

  async listActive(limit: number): Promise<CollectorAsset[]> {
    const { data, error } = await this.client
      .from("assets")
      .select("id,pocket_symbol,display_name,market_type")
      .eq("asset_category", "currency")
      .eq("is_available", true)
      .order("payout_percent", { ascending: false, nullsFirst: false })
      .limit(limit);
    if (error) throw new Error(`Supabase collector asset query failed: ${error.message}`);
    return ((data ?? []) as AssetRow[]).map(mapAsset);
  }

  async findById(assetId: string): Promise<CollectorAsset | null> {
    const { data, error } = await this.client
      .from("assets")
      .select("id,pocket_symbol,display_name,market_type")
      .eq("id", assetId)
      .eq("asset_category", "currency")
      .maybeSingle();
    if (error) throw new Error(`Supabase collector asset lookup failed: ${error.message}`);
    return data ? mapAsset(data as AssetRow) : null;
  }

  async applyLiveCatalog(assets: PocketLiveAsset[], receivedAt: string): Promise<void> {
    if (assets.length === 0) return;
    const { error } = await this.client.rpc("apply_pocket_live_asset_catalog", {
      p_assets: assets.map((asset) => ({
        pocket_symbol: asset.pocketSymbol,
        display_name: asset.displayName,
        base_currency: asset.baseCurrency,
        quote_currency: asset.quoteCurrency,
        market_type: asset.marketType,
        payout_percent: asset.payoutPercent,
        is_available: asset.isAvailable
      })),
      p_received_at: receivedAt
    });
    if (error) throw new Error(`Supabase Pocket live catalog update failed: ${error.message}`);
  }
}
