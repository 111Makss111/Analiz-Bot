import type { SupabaseClient } from "@supabase/supabase-js";

const CANDLE_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
const LEGACY_TICK_RETENTION_MS = 24 * 60 * 60 * 1_000;

export type RetentionStatus = {
  configured: boolean;
  running: boolean;
  lastAttemptDay: string | null;
  lastCompletedAt: string | null;
  lastError: string | null;
};

function safeMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error ?? "Retention failed"))
    .replace(/[\r\n]+/g, " ")
    .slice(0, 240);
}

export class MarketDataRetentionService {
  private inFlight: Promise<void> | null = null;
  private lastAttemptDay: string | null = null;
  private lastCompletedAt: string | null = null;
  private lastError: string | null = null;

  constructor(
    private readonly client: SupabaseClient | null,
    private readonly onError: (error: unknown) => void = () => undefined
  ) {}

  request(nowMs = Date.now()): void {
    if (!this.client || this.inFlight) return;
    const day = new Date(nowMs).toISOString().slice(0, 10);
    if (day === this.lastAttemptDay) return;
    this.lastAttemptDay = day;
    this.inFlight = this.run(nowMs)
      .catch((error) => {
        this.lastError = safeMessage(error);
        this.onError(error);
      })
      .finally(() => {
        this.inFlight = null;
      });
  }

  status(): RetentionStatus {
    return {
      configured: this.client !== null,
      running: this.inFlight !== null,
      lastAttemptDay: this.lastAttemptDay,
      lastCompletedAt: this.lastCompletedAt,
      lastError: this.lastError
    };
  }

  private async run(nowMs: number): Promise<void> {
    const { error } = await this.client!.rpc("prune_pocket_market_data", {
      p_candles_before: new Date(nowMs - CANDLE_RETENTION_MS).toISOString(),
      p_ticks_before: new Date(nowMs - LEGACY_TICK_RETENTION_MS).toISOString()
    });
    if (error) throw new Error(`Supabase market-data retention failed: ${error.message}`);
    this.lastCompletedAt = new Date().toISOString();
    this.lastError = null;
  }
}
