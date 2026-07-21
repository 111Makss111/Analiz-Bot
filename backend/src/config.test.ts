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
    expect(config.pocketDemoEndpoint).toBe("wss://demo-api-eu.po.market");
    expect(config.pocketCollectorEnabled).toBe(true);
    expect(config.pocketMaxAssets).toBe(3);
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

  it("не приймає довільний Pocket endpoint або не-boolean collector flag", () => {
    expect(() => loadConfig({ ...productionEnv, POCKET_DEMO_REGION: "custom" })).toThrow(
      "POCKET_DEMO_REGION"
    );
    expect(() => loadConfig({ ...productionEnv, POCKET_COLLECTOR_ENABLED: "yes" })).toThrow(
      "true або false"
    );
  });

  it("жорстко обмежує кількість одночасних live-активів", () => {
    expect(loadConfig({ ...productionEnv, POCKET_MAX_ACTIVE_ASSETS: "5" }).pocketMaxAssets).toBe(5);
    expect(() =>
      loadConfig({ ...productionEnv, POCKET_MAX_ACTIVE_ASSETS: "80" })
    ).toThrow("не більше 5");
  });
});
