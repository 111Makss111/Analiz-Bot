import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "./app.js";
import type { AppConfig } from "./config.js";
import type { AssetCatalog } from "./market-data/asset-catalog-service.js";

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
  supabaseSecretKey: ""
};

const apps: Awaited<ReturnType<typeof createApp>>[] = [];

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
            pocketSymbol: "EUR/USD OTC",
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
      assets: [{ pocketSymbol: "EUR/USD OTC", payoutPercent: 92 }]
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
