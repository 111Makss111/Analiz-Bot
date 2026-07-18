import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";

describe("loadConfig", () => {
  it("не дозволяє production без Bot Token", () => {
    expect(() =>
      loadConfig({
        NODE_ENV: "production",
        FRONTEND_ORIGIN: "https://market-pulse.vercel.app",
        SUPABASE_URL: "https://example.supabase.co",
        SUPABASE_SECRET_KEY: "sb_secret_test"
      })
    ).toThrow("TELEGRAM_BOT_TOKEN");
  });

  it("не дозволяє HTTP origin у production", () => {
    expect(() =>
      loadConfig({
        NODE_ENV: "production",
        FRONTEND_ORIGIN: "http://market-pulse.example",
        TELEGRAM_BOT_TOKEN: "test-token",
        SUPABASE_URL: "https://example.supabase.co",
        SUPABASE_SECRET_KEY: "sb_secret_test"
      })
    ).toThrow("HTTPS");
  });

  it("приймає точний HTTPS origin без шляху", () => {
    const config = loadConfig({
      NODE_ENV: "production",
      FRONTEND_ORIGIN: "https://market-pulse.vercel.app",
      TELEGRAM_BOT_TOKEN: "test-token",
      SUPABASE_URL: "https://example.supabase.co",
      SUPABASE_SECRET_KEY: "sb_secret_test"
    });

    expect(config.frontendOrigin).toBe("https://market-pulse.vercel.app");
    expect(config.telegramInitDataTtlSeconds).toBe(86_400);
  });

  it("не дозволяє часткову Supabase-конфігурацію", () => {
    expect(() => loadConfig({ SUPABASE_URL: "https://example.supabase.co" })).toThrow(
      "потрібно задавати разом"
    );
  });
});
