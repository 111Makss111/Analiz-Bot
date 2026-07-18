import cors from "@fastify/cors";
import Fastify, { type FastifyInstance } from "fastify";
import type { AppConfig } from "./config.js";

export type HealthResponse = {
  ok: true;
  service: "market-pulse-backend";
  status: "ready";
  timestamp: string;
};

export async function createApp(config: AppConfig): Promise<FastifyInstance> {
  const app = Fastify({
    logger: config.nodeEnv !== "test",
    trustProxy: true
  });

  await app.register(cors, {
    origin: config.frontendOrigin,
    methods: ["GET", "POST", "OPTIONS"]
  });

  app.get("/api/wake", async () => ({ ok: true as const }));

  app.get<{ Reply: HealthResponse }>("/api/health", async () => ({
    ok: true,
    service: "market-pulse-backend",
    status: "ready",
    timestamp: new Date().toISOString()
  }));

  return app;
}
