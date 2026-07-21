import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import { DatabaseHealthMonitor } from "./health-monitor.js";

function clientReturning(error: { message: string } | null) {
  const abortSignal = vi.fn(async () => ({ data: [], error }));
  const builder = {
    select: vi.fn(() => builder),
    limit: vi.fn(() => builder),
    abortSignal
  };
  const client = { from: vi.fn(() => builder) } as unknown as SupabaseClient;
  return { client, abortSignal };
}

describe("DatabaseHealthMonitor", () => {
  it("перевіряє реальний запит і кешує результат, щоб health не навантажував базу", async () => {
    const fake = clientReturning(null);
    let nowMs = Date.UTC(2026, 6, 21, 8, 0, 0);
    const monitor = new DatabaseHealthMonitor(fake.client, {
      cacheMs: 30_000,
      now: () => nowMs
    });

    await expect(monitor.check()).resolves.toMatchObject({ state: "ready", error: null });
    nowMs += 10_000;
    await expect(monitor.check()).resolves.toMatchObject({ state: "ready" });
    expect(fake.abortSignal).toHaveBeenCalledTimes(1);
  });

  it("показує degraded при PGRST/connection помилці замість configured", async () => {
    const fake = clientReturning({ message: "Could not query the database for the schema cache" });
    const monitor = new DatabaseHealthMonitor(fake.client);

    await expect(monitor.check()).resolves.toMatchObject({
      state: "degraded",
      error: "Could not query the database for the schema cache"
    });
  });

  it("чесно показує not_configured без Supabase credentials", async () => {
    const monitor = new DatabaseHealthMonitor(null);
    await expect(monitor.check()).resolves.toMatchObject({ state: "not_configured" });
  });
});
