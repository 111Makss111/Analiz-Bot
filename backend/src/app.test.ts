import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import type { AppConfig } from "./config.js";

const config: AppConfig = {
  nodeEnv: "test",
  host: "127.0.0.1",
  port: 3000,
  frontendOrigin: "http://localhost:5173"
};

const apps: Awaited<ReturnType<typeof createApp>>[] = [];

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
});
