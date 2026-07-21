import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import { MarketDataRetentionService } from "./retention-service.js";

describe("MarketDataRetentionService", () => {
  it("запускає компактне очищення не частіше одного разу на UTC-добу", async () => {
    const rpc = vi.fn(async () => ({ data: [], error: null }));
    const service = new MarketDataRetentionService({ rpc } as unknown as SupabaseClient);
    const firstDay = Date.UTC(2026, 6, 21, 8, 0, 0);

    service.request(firstDay);
    service.request(firstDay + 60_000);
    await vi.waitFor(() => expect(service.status().running).toBe(false));
    expect(rpc).toHaveBeenCalledTimes(1);

    service.request(firstDay + 24 * 60 * 60 * 1_000);
    await vi.waitFor(() => expect(service.status().running).toBe(false));
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(rpc).toHaveBeenLastCalledWith("prune_pocket_market_data", {
      p_candles_before: new Date(firstDay - 6 * 24 * 60 * 60 * 1_000).toISOString(),
      p_ticks_before: new Date(firstDay).toISOString()
    });
  });
});
