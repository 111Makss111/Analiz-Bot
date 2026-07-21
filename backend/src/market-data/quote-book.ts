import type { PocketTick } from "./types.js";

export type TickRejectionReason = "invalid" | "out_of_order" | "duplicate";
export type TickAcceptance =
  | { accepted: true; tick: PocketTick }
  | { accepted: false; reason: TickRejectionReason };

export type QuoteSnapshot = {
  tick: PocketTick;
  receivedAgeMs: number;
  pocketAgeMs: number;
  isFresh: boolean;
  staleReason: "received_age" | "pocket_age" | "clock_skew" | null;
};

function validTick(tick: PocketTick): boolean {
  return (
    tick.assetId.length > 0 &&
    Number.isFinite(tick.price) &&
    tick.price > 0 &&
    Number.isFinite(tick.pocketTimeMs) &&
    tick.pocketTimeMs > 0 &&
    Number.isFinite(tick.receivedAtMs) &&
    tick.receivedAtMs > 0
  );
}

export class QuoteBook {
  private readonly latest = new Map<string, PocketTick>();

  accept(tick: PocketTick): TickAcceptance {
    if (!validTick(tick)) return { accepted: false, reason: "invalid" };

    const previous = this.latest.get(tick.assetId);
    if (previous && tick.pocketTimeMs < previous.pocketTimeMs) {
      return { accepted: false, reason: "out_of_order" };
    }

    if (
      previous &&
      tick.pocketTimeMs === previous.pocketTimeMs &&
      tick.price === previous.price &&
      tick.sequence === previous.sequence
    ) {
      return { accepted: false, reason: "duplicate" };
    }

    this.latest.set(tick.assetId, tick);
    return { accepted: true, tick };
  }

  get(assetId: string, nowMs: number, maxAgeMs: number): QuoteSnapshot | null {
    const tick = this.latest.get(assetId);
    if (!tick) return null;

    const receivedAgeMs = nowMs - tick.receivedAtMs;
    const pocketAgeMs = nowMs - tick.pocketTimeMs;
    let staleReason: QuoteSnapshot["staleReason"] = null;

    if (receivedAgeMs < -2_000 || pocketAgeMs < -2_000) staleReason = "clock_skew";
    else if (receivedAgeMs > maxAgeMs) staleReason = "received_age";
    else if (pocketAgeMs > maxAgeMs) staleReason = "pocket_age";

    return {
      tick,
      receivedAgeMs: Math.max(0, receivedAgeMs),
      pocketAgeMs: Math.max(0, pocketAgeMs),
      isFresh: staleReason === null,
      staleReason
    };
  }

  remove(assetId: string): void {
    this.latest.delete(assetId);
  }
}
