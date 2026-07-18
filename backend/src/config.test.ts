import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";

const productionEnv = {
  NODE_ENV: "production",
  FRONTEND_ORIGIN: "https://market-pulse.vercel.app",
  TELEGRAM_BOT_TOKEN: "test-token",
  TELEGRAM_WEBHOOK_SECRET: "test_webhook_secret_123456789012345",
  RENDER_EXTERNAL_URL: "https://market-pulse-backend.onrender.com",
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_SECRET_KEY: "sb_secret_test"
};

describe("loadConfig", () => {
  it("не дозволяє production без Bot Token", () => {
    expect(() =>
      loadConfig({
        ...productionEnv,
        TELEGRAM_BOT_TOKEN: ""
      })
    ).toThrow("TELEGRAM_BOT_TOKEN");
  });

  it("не дозволяє HTTP origin у production", () => {
    expect(() =>
      loadConfig({
        ...productionEnv,
        FRONTEND_ORIGIN: "http://market-pulse.example",
      })
    ).toThrow("HTTPS");
  });

  it("приймає точний HTTPS origin без шляху", () => {
    const config = loadConfig(productionEnv);

    expect(config.frontendOrigin).toBe("https://market-pulse.vercel.app");
    expect(config.telegramInitDataTtlSeconds).toBe(86_400);
    expect(config.backendPublicUrl).toBe("https://market-pulse-backend.onrender.com");
  });

  it("не дозволяє часткову Supabase-конфігурацію", () => {
    expect(() => loadConfig({ SUPABASE_URL: "https://example.supabase.co" })).toThrow(
      "потрібно задавати разом"
    );
  });

  it("не дозволяє слабкий webhook secret у production", () => {
    expect(() => loadConfig({ ...productionEnv, TELEGRAM_WEBHOOK_SECRET: "short" })).toThrow(
      "щонайменше 32"
    );
  });

  it("створює окремий webhook secret із Bot Token, якщо Render secret не задано", () => {
    const config = loadConfig({ ...productionEnv, TELEGRAM_WEBHOOK_SECRET: "" });

    expect(config.telegramWebhookSecret).toMatch(/^[a-f0-9]{64}$/);
    expect(config.telegramWebhookSecret).not.toContain(config.telegramBotToken);
  });
});
