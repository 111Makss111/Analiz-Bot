import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import type { CandleStore } from "./candle-store.js";
import { MarketDataPipeline } from "./market-data-pipeline.js";
import type { MarketDataWriter } from "./market-data-writer.js";
import type { PocketAssetStore } from "./pocket-asset-store.js";
import { PocketCollector, reconnectDelayMs } from "./pocket-collector.js";
import type {
  PocketTransport,
  PocketTransportHandlers
} from "./pocket-transport.js";

const asset = {
  id: "123e4567-e89b-42d3-a456-426614174000",
  pocketSymbol: "AUDCAD_otc",
  displayName: "AUD/CAD OTC",
  marketType: "otc" as const
};

function candleStore(): CandleStore {
  return {
    list: vi.fn(async (assetId, timeframeSeconds) => ({
      ok: true,
      status: "warming",
      assetId,
      timeframeSeconds,
      candles: []
    })),
    loadCurrent: vi.fn(async () => []),
    loadCurrentForAssets: vi.fn(async () => []),
    upsert: vi.fn(async () => undefined)
  };
}

function assetStore(): PocketAssetStore {
  return {
    listActive: vi.fn(async () => [asset]),
    findById: vi.fn(async (assetId) => (assetId === asset.id ? asset : null)),
    applyLiveCatalog: vi.fn(async () => undefined)
  };
}

class FakeTransport implements PocketTransport {
  connected = false;
  auth: unknown = null;
  readonly subscriptions: string[] = [];
  private readonly unique = new Set<string>();

  constructor(readonly handlers: PocketTransportHandlers) {}

  connect(auth: unknown): void {
    this.auth = auth;
  }

  disconnect(): void {
    this.connected = false;
  }

  subscribe(pocketSymbol: string, periodSeconds: 30 | 60): boolean {
    const key = `${pocketSymbol}:${periodSeconds}`;
    if (!this.connected || this.unique.has(key)) return false;
    this.unique.add(key);
    this.subscriptions.push(key);
    return true;
  }

  isConnected(): boolean {
    return this.connected;
  }

  open(): void {
    this.connected = true;
    this.handlers.onConnected();
  }

  authenticate(): void {
    this.handlers.onAuthenticated();
  }
}

function createHarness(authPacket = '42["auth",{"session":"secret","isDemo":1,"uid":42,"platform":1}]') {
  const persist = vi.fn<MarketDataWriter["persist"]>(async () => undefined);
  const pipeline = new MarketDataPipeline({ persist });
  let transport: FakeTransport | null = null;
  const collector = new PocketCollector({
    enabled: true,
    authPacket,
    maxAssets: 80,
    staleAfterMs: 15_000,
    assetStore: assetStore(),
    candleStore: candleStore(),
    pipeline,
    transportFactory: (handlers) => {
      transport = new FakeTransport(handlers);
      return transport;
    }
  });
  return { collector, pipeline, persist, transport: () => transport };
}

describe("PocketCollector", () => {
  it("авторизується лише в Demo, підписується один раз і передає свіжий tick у pipeline", async () => {
    const harness = createHarness();
    await harness.collector.start();
    const transport = harness.transport();
    expect(transport).not.toBeNull();
    expect(transport?.auth).toMatchObject({ isDemo: 1, uid: 42 });

    transport!.open();
    transport!.authenticate();
    expect(transport!.subscriptions).toEqual(["AUDCAD_otc:60"]);

    const now = Date.now();
    transport!.handlers.onStream([["AUDCAD_otc", now, 0.91234, "tick-1"]]);
    await harness.pipeline.flushNow();

    expect(harness.persist).toHaveBeenCalledWith(
      [expect.objectContaining({ assetId: asset.id, price: 0.91234 })],
      expect.arrayContaining([expect.objectContaining({ timeframeSeconds: 30 })]),
      [expect.objectContaining({ price: 0.91234 })]
    );
    expect(harness.collector.status()).toMatchObject({
      state: "ready",
      authenticated: true,
      acceptedTicks: 1
    });
    await harness.collector.stop();
  });

  it("після вибору активу додає 30s history без повторної M1 підписки", async () => {
    const harness = createHarness();
    await harness.collector.start();
    const transport = harness.transport()!;
    transport.open();
    transport.authenticate();

    const result = await harness.collector.prepareAsset(asset.id);

    expect(result).toMatchObject({ ok: true, code: "POCKET_HISTORY_REQUESTED" });
    expect(transport.subscriptions).toEqual(["AUDCAD_otc:60", "AUDCAD_otc:30"]);
    await harness.collector.stop();
  });

  it("не запускає transport для пакета реального рахунку", async () => {
    const harness = createHarness(
      '42["auth",{"session":"secret-real","isDemo":0,"uid":42,"platform":1}]'
    );

    await harness.collector.start();

    expect(harness.transport()).toBeNull();
    expect(harness.collector.status()).toMatchObject({
      state: "auth_rejected",
      connected: false,
      authenticated: false
    });
    await harness.collector.stop();
  });

  it("відкидає застарілий live tick замість вигадування актуальної ціни", async () => {
    const harness = createHarness();
    await harness.collector.start();
    const transport = harness.transport()!;
    transport.open();
    transport.authenticate();
    transport.handlers.onStream([["AUDCAD_otc", Date.now() - 60_000, 0.9]]);
    await harness.pipeline.flushNow();

    expect(harness.persist).not.toHaveBeenCalled();
    expect(harness.collector.status().rejectedTicks).toBe(1);
    await harness.collector.stop();
  });

  it("нормалізує стабільний Pocket UTC+2 shift, але зберігає сирий offset у діагностиці", async () => {
    const harness = createHarness();
    await harness.collector.start();
    const transport = harness.transport()!;
    transport.open();
    transport.authenticate();
    const now = Date.now();
    const shifted = now + 2 * 60 * 60 * 1_000;

    transport.handlers.onStream([
      ["AUDCAD_otc", shifted, 0.91, "shift-1"],
      ["AUDCAD_otc", shifted + 1, 0.92, "shift-2"],
      ["AUDCAD_otc", shifted + 2, 0.93, "shift-3"]
    ]);
    await harness.pipeline.flushNow();

    expect(harness.persist).toHaveBeenCalledWith(
      [expect.objectContaining({ price: 0.93, pocketTimeMs: expect.any(Number) })],
      expect.any(Array),
      [expect.objectContaining({ price: 0.93 })]
    );
    expect(harness.collector.status()).toMatchObject({
      state: "ready",
      acceptedTicks: 1,
      rejectedTicks: 2,
      rawPocketClockOffsetMs: expect.closeTo(-7_200_000, -2),
      pocketClockOffsetMs: expect.closeTo(0, -2),
      pocketTimestampCorrectionMs: 7_200_000
    });
    await harness.collector.stop();
  });

  it("утримує history до калібрування часу і зберігає нормалізовану свічку", async () => {
    const harness = createHarness();
    await harness.collector.start();
    const transport = harness.transport()!;
    transport.open();
    transport.authenticate();
    const now = Date.now();
    const shift = 2 * 60 * 60 * 1_000;

    transport.handlers.onHistory({
      asset: "AUDCAD_otc",
      period: 60,
      history: [[now - 120_000 + shift, 0.9, 0.95, 0.89, 0.94]]
    });
    transport.handlers.onStream([
      ["AUDCAD_otc", now + shift, 0.94],
      ["AUDCAD_otc", now + shift + 1, 0.941],
      ["AUDCAD_otc", now + shift + 2, 0.942]
    ]);

    await vi.waitFor(() =>
      expect(harness.collector.status().historyCandles).toBeGreaterThanOrEqual(1)
    );
    expect(harness.persist).toHaveBeenCalledWith(
      [],
      expect.arrayContaining([
        expect.objectContaining({ timeframeSeconds: 60, isComplete: true })
      ]),
      []
    );
    await harness.collector.stop();
  });

  it("обмежує reconnect backoff", () => {
    expect(reconnectDelayMs(1)).toBe(1_000);
    expect(reconnectDelayMs(3)).toBe(4_000);
    expect(reconnectDelayMs(100)).toBe(30_000);
  });

  it("read-only collector не містить команд відкриття угод", async () => {
    const source = (
      await Promise.all([
        readFile(new URL("./pocket-transport.ts", import.meta.url), "utf8"),
        readFile(new URL("./pocket-collector.ts", import.meta.url), "utf8")
      ])
    ).join("\n");
    for (const forbidden of ["openOrder", "copySignalOrder", "placeOrder", "closeOrder"]) {
      expect(source).not.toContain(forbidden);
    }
  });
});
