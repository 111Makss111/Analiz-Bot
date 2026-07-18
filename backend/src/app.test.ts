import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import type { AppConfig } from "./config.js";

const config: AppConfig = {
  nodeEnv: "test",
  host: "127.0.0.1",
  port: 3000,
  frontendOrigin: "http://localhost:5173",
  telegramBotToken: "123456789:test-token",
  telegramInitDataTtlSeconds: 86_400
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
});
