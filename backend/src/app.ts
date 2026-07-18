import cors from "@fastify/cors";
import Fastify, { type FastifyInstance } from "fastify";
import type { AppConfig } from "./config.js";
import { TelegramInitDataError, verifyTelegramInitData } from "./telegram/init-data.js";

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
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "X-Telegram-Init-Data"]
  });

  app.get("/api/wake", async () => ({ ok: true as const }));

  app.get<{ Reply: HealthResponse }>("/api/health", async () => ({
    ok: true,
    service: "market-pulse-backend",
    status: "ready",
    timestamp: new Date().toISOString()
  }));

  app.get("/api/auth/session", async (request, reply) => {
    const header = request.headers["x-telegram-init-data"];
    const rawInitData = Array.isArray(header) ? "" : (header ?? "");

    try {
      const verified = verifyTelegramInitData(rawInitData, {
        botToken: config.telegramBotToken,
        maxAgeSeconds: config.telegramInitDataTtlSeconds
      });

      return reply.header("Cache-Control", "no-store").send({
        ok: true,
        user: {
          id: verified.user.id,
          firstName: verified.user.first_name,
          ...(verified.user.username ? { username: verified.user.username } : {})
        }
      });
    } catch (error) {
      if (!(error instanceof TelegramInitDataError)) throw error;

      return reply.code(401).header("Cache-Control", "no-store").send({
        ok: false,
        error: {
          code: error.code,
          message: error.message
        }
      });
    }
  });

  return app;
}
