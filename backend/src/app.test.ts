import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AnalysisRuntime } from "./analysis/analysis-service.js";
import type { AnalysisResult } from "./analysis/types.js";
import { createApp } from "./app.js";
import type { AppConfig } from "./config.js";
import type { AssetCatalog } from "./market-data/asset-catalog-service.js";
import type { CandleStore } from "./market-data/candle-store.js";
import type {
  PocketCollectorRuntime,
  PocketCollectorStatus
} from "./market-data/pocket-collector.js";

const config: AppConfig = {
  nodeEnv: "test",
  host: "127.0.0.1",
  port: 3000,
  frontendOrigin: "http://localhost:5173",
  telegramBotToken: "123456789:test-token",
  telegramWebhookSecret: "test_webhook_secret_123456789012345",
  telegramMiniAppUrl: "",
  backendPublicUrl: "",
  telegramInitDataTtlSeconds: 86_400,
  supabaseUrl: "",
  supabaseSecretKey: "",
  diagnosticsSecret: "test_diagnostics_secret_123456789012345",
  pocketCollectorEnabled: true,
  pocketAuthPacket: "",
  pocketDemoEndpoint: "wss://demo-api-eu.po.market",
  pocketMaxAssets: 80,
  pocketStaleAfterMs: 15_000
};

const apps: Awaited<ReturnType<typeof createApp>>[] = [];

const READY_COLLECTOR_STATUS: PocketCollectorStatus = {
  state: "ready",
  configured: true,
  enabled: true,
  connected: true,
  authenticated: true,
  message: "ready",
  activeAssets: 1,
  priorityAssets: 0,
  subscriptions: 1,
  reconnectAttempt: 0,
  reconnectScheduled: false,
  lastConnectedAt: null,
  lastAuthenticatedAt: null,
  lastStreamAt: null,
  lastTickAt: null,
  lastCatalogAt: null,
  lastHistoryAt: null,
  quoteAgeMs: null,
  rawPocketClockOffsetMs: null,
  pocketClockOffsetMs: null,
  pocketTimestampCorrectionMs: null,
  acceptedTicks: 0,
  rejectedTicks: 0,
  historyCandles: 0,
  lastError: null
};

function readyCollector(
  prepareAsset = vi.fn(async (assetId: string) => ({
    ok: true,
    code: "POCKET_HISTORY_REQUESTED",
    message: "prepared",
    assetId,
    collector: READY_COLLECTOR_STATUS
  }))
): PocketCollectorRuntime {
  return {
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    prepareAsset,
    status: () => READY_COLLECTOR_STATUS
  };
}

function createSignedInitData(): string {
  const fields = {
    auth_date: String(Math.floor(Date.now() / 1000)),
    user: JSON.stringify({ id: 42, first_name: "Марія", username: "maria" })
  };
  const dataCheckString = Object.entries(fields)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  const secret = createHmac("sha256", "WebAppData").update(config.telegramBotToken).digest();
  const hash = createHmac("sha256", secret).update(dataCheckString).digest("hex");
  return new URLSearchParams({ ...fields, hash }).toString();
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("system endpoints", () => {
  it("повертає мінімальну wake-відповідь", async () => {
    const app = await createApp(config);
    apps.push(app);
    const response = await app.inject({ method: "GET", url: "/api/wake" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
  });

  it("повертає короткий health-стан і дозволений CORS origin", async () => {
    const app = await createApp(config);
    apps.push(app);
    const response = await app.inject({
      method: "GET",
      url: "/api/health",
      headers: { origin: config.frontendOrigin }
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["access-control-allow-origin"]).toBe(config.frontendOrigin);
    expect(response.json()).toMatchObject({
      ok: true,
      service: "market-pulse-backend",
      status: "ready"
    });
  });

  it("повертає валютний каталог через короткий server API", async () => {
    const assetCatalog: AssetCatalog = {
      start: vi.fn(),
      stop: vi.fn(),
      requestRefresh: vi.fn(),
      list: vi.fn(async () => ({
        ok: true,
        category: "currency",
        status: "ready",
        source: "supabase-cache",
        updatedAt: "2026-07-18T15:00:00.000Z",
        assets: [
          {
            id: "asset-1",
            pocketSymbol: "EURUSD_otc",
            displayName: "EUR/USD OTC",
            baseCurrency: "EUR",
            quoteCurrency: "USD",
            marketType: "otc",
            isAvailable: true,
            payoutPercent: 92,
            dataState: "warming",
            lastQuote: null,
            lastQuoteAt: null,
            quoteAgeMs: null,
            catalogUpdatedAt: "2026-07-18T15:00:00.000Z",
            catalogAgeMs: 1000
          }
        ]
      }))
    };
    const app = await createApp(config, { assetCatalog });
    apps.push(app);

    const response = await app.inject({ method: "GET", url: "/api/assets?market=otc&search=EUR" });

    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toContain("stale-while-revalidate");
    expect(response.json()).toMatchObject({
      ok: true,
      status: "ready",
      assets: [{ pocketSymbol: "EURUSD_otc", payoutPercent: 92 }]
    });
    expect(assetCatalog.list).toHaveBeenCalledWith({ market: "otc", search: "EUR" });
  });

  it("відхиляє невідомий market filter", async () => {
    const app = await createApp(config);
    apps.push(app);
    const response = await app.inject({ method: "GET", url: "/api/assets?market=crypto" });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: "INVALID_MARKET_FILTER" } });
  });

  it("повертає збережені M1 свічки вибраного активу", async () => {
    const candleStore: CandleStore = {
      upsert: vi.fn(async () => undefined),
      loadCurrent: vi.fn(async () => []),
      loadCurrentForAssets: vi.fn(async () => []),
      list: vi.fn(async (assetId, timeframeSeconds) => ({
        ok: true,
        status: "ready",
        assetId,
        timeframeSeconds,
        candles: [
          {
            assetId,
            timeframeSeconds,
            openTime: "2026-07-18T12:00:00.000Z",
            closeTime: "2026-07-18T12:01:00.000Z",
            lastTickAt: "2026-07-18T12:00:59.000Z",
            open: 1.1,
            high: 1.2,
            low: 1.05,
            close: 1.15,
            tickCount: 12,
            isComplete: true,
            receivedAt: "2026-07-18T12:01:00.100Z"
          }
        ]
      }))
    };
    const app = await createApp(config, { candleStore });
    apps.push(app);
    const assetId = "123e4567-e89b-42d3-a456-426614174000";

    const response = await app.inject({
      method: "GET",
      url: `/api/assets/${assetId}/candles?timeframe=60&limit=120`
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: "ready",
      timeframeSeconds: 60,
      candles: [{ open: 1.1, close: 1.15, isComplete: true }]
    });
    expect(candleStore.list).toHaveBeenCalledWith(assetId, 60, 120);
  });

  it("відхиляє пошкоджені candle query parameters", async () => {
    const app = await createApp(config);
    apps.push(app);

    const badAsset = await app.inject({ method: "GET", url: "/api/assets/not-a-uuid/candles" });
    const badTimeframe = await app.inject({
      method: "GET",
      url: "/api/assets/123e4567-e89b-42d3-a456-426614174000/candles?timeframe=15"
    });

    expect(badAsset.statusCode).toBe(400);
    expect(badTimeframe.statusCode).toBe(400);
  });

  it("захищає детальну діагностику окремим server secret", async () => {
    const app = await createApp(config);
    apps.push(app);
    const rejected = await app.inject({ method: "GET", url: "/api/diagnostics" });
    const accepted = await app.inject({
      method: "GET",
      url: "/api/diagnostics",
      headers: { "x-diagnostics-secret": config.diagnosticsSecret }
    });

    expect(rejected.statusCode).toBe(401);
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toMatchObject({ ok: true, pocket: { configured: false } });
  });

  it("готує вибраний актив лише після перевірки Telegram initData", async () => {
    const prepareAsset = vi.fn(async (assetId: string) => ({
      ok: true,
      code: "POCKET_HISTORY_REQUESTED",
      message: "prepared",
      assetId,
      collector: collector.status()
    }));
    const collector: PocketCollectorRuntime = {
      start: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
      prepareAsset,
      status: () => ({
        state: "ready",
        configured: true,
        enabled: true,
        connected: true,
        authenticated: true,
        message: "ready",
        activeAssets: 1,
        priorityAssets: 0,
        subscriptions: 1,
        reconnectAttempt: 0,
        reconnectScheduled: false,
        lastConnectedAt: null,
        lastAuthenticatedAt: null,
        lastStreamAt: null,
        lastTickAt: null,
        lastCatalogAt: null,
        lastHistoryAt: null,
        quoteAgeMs: null,
        rawPocketClockOffsetMs: null,
        pocketClockOffsetMs: null,
        pocketTimestampCorrectionMs: null,
        acceptedTicks: 0,
        rejectedTicks: 0,
        historyCandles: 0,
        lastError: null
      })
    };
    const app = await createApp(config, { pocketCollector: collector });
    apps.push(app);
    const assetId = "123e4567-e89b-42d3-a456-426614174000";

    const rejected = await app.inject({
      method: "POST",
      url: "/api/assets/prepare",
      payload: { assetId }
    });
    const accepted = await app.inject({
      method: "POST",
      url: "/api/assets/prepare",
      headers: { "x-telegram-init-data": createSignedInitData() },
      payload: { assetId }
    });

    expect(rejected.statusCode).toBe(401);
    expect(accepted.statusCode).toBe(200);
    expect(prepareAsset).toHaveBeenCalledWith(assetId);
  });

  it("не запускає математичний аналіз без Telegram initData", async () => {
    const collector = readyCollector();
    const analysisRuntime: AnalysisRuntime = { analyze: vi.fn() };
    const app = await createApp(config, { pocketCollector: collector, analysisRuntime });
    apps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/api/analyze",
      payload: {
        assetId: "123e4567-e89b-42d3-a456-426614174000",
        expirationMinutes: 1
      }
    });

    expect(response.statusCode).toBe(401);
    expect(analysisRuntime.analyze).not.toHaveBeenCalled();
    expect(collector.prepareAsset).not.toHaveBeenCalled();
  });

  it("відхиляє експірацію поза 1–3 хвилинами", async () => {
    const analysisRuntime: AnalysisRuntime = { analyze: vi.fn() };
    const app = await createApp(config, {
      pocketCollector: readyCollector(),
      analysisRuntime
    });
    apps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/api/analyze",
      headers: { "x-telegram-init-data": createSignedInitData() },
      payload: {
        assetId: "123e4567-e89b-42d3-a456-426614174000",
        expirationMinutes: 5
      }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: "INVALID_EXPIRATION" } });
    expect(analysisRuntime.analyze).not.toHaveBeenCalled();
  });

  it("повертає прогноз лише для вибраного активу та пріоритезує його в Pocket", async () => {
    const assetId = "123e4567-e89b-42d3-a456-426614174000";
    const analysis: AnalysisResult = {
      asset: { id: assetId, pocketSymbol: "AUDCHF_otc", displayName: "AUD/CHF OTC", marketType: "otc" },
      direction: "up",
      expirationMinutes: 2,
      expirationSeconds: 120,
      quote: { price: 0.61566, pocketTime: "2026-07-18T18:30:00.000Z", ageMs: 120 },
      payoutPercent: 92,
      strengthScore: 74,
      strength: "stronger",
      strengthIsProbability: false,
      regime: "trend",
      volatility: "normal",
      explanation: "Короткий рух і тики узгоджені вгору.",
      reasons: ["Ціна вище EMA 9/20/21"],
      risks: ["Коротка експірація чутлива до останніх тиків"],
      algorithmVersion: "market-pulse-deterministic-otc-v1.0.0",
      createdAt: "2026-07-18T18:30:00.100Z",
      durationMs: 100,
      data: { recentTicks: 25, candles30s: 40, candlesM1: 45, candlesM5: 12, qualityScore: 96 }
    };
    const analyze = vi.fn(async () => analysis);
    const prepareAsset = vi.fn(async () => ({
      ok: true,
      code: "POCKET_HISTORY_REQUESTED",
      message: "prepared",
      assetId,
      collector: READY_COLLECTOR_STATUS
    }));
    const app = await createApp(config, {
      pocketCollector: readyCollector(prepareAsset),
      analysisRuntime: { analyze }
    });
    apps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/api/analyze",
      headers: { "x-telegram-init-data": createSignedInitData() },
      payload: { assetId, expirationMinutes: 2 }
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json()).toMatchObject({
      ok: true,
      analysis: { direction: "up", payoutPercent: 92, strengthIsProbability: false }
    });
    expect(prepareAsset).toHaveBeenCalledWith(assetId);
    expect(analyze).toHaveBeenCalledWith({ assetId, expirationMinutes: 2 });
  });

  it("не додає CORS-дозвіл для стороннього origin", async () => {
    const app = await createApp(config);
    apps.push(app);
    const response = await app.inject({
      method: "GET",
      url: "/api/health",
      headers: { origin: "https://untrusted.example" }
    });

    expect(response.headers["access-control-allow-origin"]).toBe(config.frontendOrigin);
    expect(response.headers["access-control-allow-origin"]).not.toBe("https://untrusted.example");
  });

  it("не відкриває приватну сесію без Telegram initData", async () => {
    const app = await createApp(config);
    apps.push(app);
    const response = await app.inject({ method: "GET", url: "/api/auth/session" });

    expect(response.statusCode).toBe(401);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json()).toMatchObject({
      ok: false,
      error: { code: "MISSING_INIT_DATA" }
    });
  });

  it("повертає мінімальний профіль для підтвердженої Telegram-сесії", async () => {
    const app = await createApp(config);
    apps.push(app);
    const response = await app.inject({
      method: "GET",
      url: "/api/auth/session",
      headers: { "x-telegram-init-data": createSignedInitData() }
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json()).toEqual({
      ok: true,
      user: { id: 42, firstName: "Марія", username: "maria" }
    });
  });

  it("відхиляє webhook без правильного Telegram secret", async () => {
    const sendStartMessage = vi.fn();
    const app = await createApp(config, {
      telegramBotApi: { sendStartMessage, configureWebhook: vi.fn() }
    });
    apps.push(app);
    const response = await app.inject({
      method: "POST",
      url: "/api/telegram/webhook",
      payload: { message: { chat: { id: 42, type: "private" }, text: "/start" } }
    });

    expect(response.statusCode).toBe(401);
    expect(sendStartMessage).not.toHaveBeenCalled();
  });

  it("відповідає на підтверджений /start", async () => {
    const sendStartMessage = vi.fn().mockResolvedValue(undefined);
    const app = await createApp(config, {
      telegramBotApi: { sendStartMessage, configureWebhook: vi.fn() }
    });
    apps.push(app);
    const response = await app.inject({
      method: "POST",
      url: "/api/telegram/webhook",
      headers: { "x-telegram-bot-api-secret-token": config.telegramWebhookSecret },
      payload: { message: { chat: { id: 42, type: "private" }, text: "/start" } }
    });

    expect(response.statusCode).toBe(200);
    expect(sendStartMessage).toHaveBeenCalledWith(42);
  });
});
