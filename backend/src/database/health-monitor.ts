import type { SupabaseClient } from "@supabase/supabase-js";

export type DatabaseHealthState = "ready" | "degraded" | "not_configured";

export type DatabaseHealthSnapshot = {
  state: DatabaseHealthState;
  checkedAt: string;
  latencyMs: number | null;
  error: string | null;
};

type HealthMonitorOptions = {
  cacheMs?: number;
  timeoutMs?: number;
  now?: () => number;
};

function safeMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error ?? "Database probe failed"))
    .replace(/[\r\n]+/g, " ")
    .slice(0, 240);
}

export class DatabaseHealthMonitor {
  private readonly cacheMs: number;
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private cached: DatabaseHealthSnapshot | null = null;
  private cachedAtMs = 0;
  private inFlight: Promise<DatabaseHealthSnapshot> | null = null;

  constructor(
    private readonly client: SupabaseClient | null,
    options: HealthMonitorOptions = {}
  ) {
    this.cacheMs = options.cacheMs ?? 30_000;
    this.timeoutMs = options.timeoutMs ?? 2_500;
    this.now = options.now ?? Date.now;
  }

  async check(force = false): Promise<DatabaseHealthSnapshot> {
    const nowMs = this.now();
    if (!this.client) {
      return {
        state: "not_configured",
        checkedAt: new Date(nowMs).toISOString(),
        latencyMs: null,
        error: null
      };
    }
    if (!force && this.cached && nowMs - this.cachedAtMs < this.cacheMs) return this.cached;
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.probe().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  current(): DatabaseHealthSnapshot | null {
    return this.cached;
  }

  private async probe(): Promise<DatabaseHealthSnapshot> {
    const startedAtMs = this.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    timeout.unref();
    let snapshot: DatabaseHealthSnapshot;
    try {
      const { error } = await this.client!
        .from("assets")
        .select("id")
        .limit(1)
        .abortSignal(controller.signal);
      if (error) throw new Error(error.message);
      snapshot = {
        state: "ready",
        checkedAt: new Date(this.now()).toISOString(),
        latencyMs: Math.max(0, this.now() - startedAtMs),
        error: null
      };
    } catch (error) {
      snapshot = {
        state: "degraded",
        checkedAt: new Date(this.now()).toISOString(),
        latencyMs: Math.max(0, this.now() - startedAtMs),
        error: safeMessage(error)
      };
    } finally {
      clearTimeout(timeout);
    }
    this.cached = snapshot;
    this.cachedAtMs = this.now();
    return snapshot;
  }
}
