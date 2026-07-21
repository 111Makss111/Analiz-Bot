import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  CandleHistoryResponse,
  StoredCandle,
  TimeframeSeconds
} from "./types.js";

type CandleRow = {
  asset_id: unknown;
  timeframe_seconds: unknown;
  open_time: unknown;
  close_time: unknown;
  last_tick_at: unknown;
  open: unknown;
  high: unknown;
  low: unknown;
  close: unknown;
  tick_count: unknown;
  is_complete: unknown;
  received_at: unknown;
};

function mapRow(row: CandleRow): StoredCandle {
  return {
    assetId: String(row.asset_id),
    timeframeSeconds: Number(row.timeframe_seconds) as TimeframeSeconds,
    openTime: String(row.open_time),
    closeTime: String(row.close_time),
    lastTickAt: String(row.last_tick_at),
    open: Number(row.open),
    high: Number(row.high),
    low: Number(row.low),
    close: Number(row.close),
    tickCount: Number(row.tick_count),
    isComplete: row.is_complete === true,
    receivedAt: String(row.received_at)
  };
}

export interface CandleStore {
  list(assetId: string, timeframeSeconds: TimeframeSeconds, limit: number): Promise<CandleHistoryResponse>;
}

export class UnavailableCandleStore implements CandleStore {
  async list(
    assetId: string,
    timeframeSeconds: TimeframeSeconds
  ): Promise<CandleHistoryResponse> {
    return { ok: true, status: "unavailable", assetId, timeframeSeconds, candles: [] };
  }

}

export class SupabaseCandleStore implements CandleStore {
  constructor(private readonly client: SupabaseClient) {}

  async list(
    assetId: string,
    timeframeSeconds: TimeframeSeconds,
    limit: number
  ): Promise<CandleHistoryResponse> {
    const { data, error } = await this.client
      .from("candles")
      .select(
        "asset_id,timeframe_seconds,open_time,close_time,last_tick_at,open,high,low,close,tick_count,is_complete,received_at"
      )
      .eq("asset_id", assetId)
      .eq("timeframe_seconds", timeframeSeconds)
      .order("open_time", { ascending: false })
      .limit(limit);

    if (error) throw new Error(`Supabase candle query failed: ${error.message}`);

    const candles = ((data ?? []) as CandleRow[]).map(mapRow).reverse();
    return {
      ok: true,
      status: candles.length > 0 ? "ready" : "warming",
      assetId,
      timeframeSeconds,
      candles
    };
  }

}
