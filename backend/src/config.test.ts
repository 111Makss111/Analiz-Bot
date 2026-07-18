import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";

describe("loadConfig", () => {
  it("не дозволяє production без Bot Token", () => {
    expect(() =>
      loadConfig({ NODE_ENV: "production", FRONTEND_ORIGIN: "https://market-pulse.vercel.app" })
    ).toThrow("TELEGRAM_BOT_TOKEN");
  });

  it("не дозволяє HTTP origin у production", () => {
    expect(() =>
      loadConfig({
        NODE_ENV: "production",
        FRONTEND_ORIGIN: "http://market-pulse.example",
        TELEGRAM_BOT_TOKEN: "test-token"
      })
    ).toThrow("HTTPS");
  });

  it("приймає точний HTTPS origin без шляху", () => {
    const config = loadConfig({
      NODE_ENV: "production",
      FRONTEND_ORIGIN: "https://market-pulse.vercel.app",
      TELEGRAM_BOT_TOKEN: "test-token"
    });

    expect(config.frontendOrigin).toBe("https://market-pulse.vercel.app");
    expect(config.telegramInitDataTtlSeconds).toBe(86_400);
  });
});
