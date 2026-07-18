import cors from "@fastify/cors";
import Fastify, { type FastifyInstance } from "fastify";
import type { AppConfig } from "./config.js";
import { createSupabaseAdminClient } from "./database/client.js";
import { AssetCatalogService, type AssetCatalog } from "./market-data/asset-catalog-service.js";
import { SupabaseAssetCatalogRepository } from "./market-data/asset-catalog-repository.js";
import { PocketPublicCatalogSource } from "./market-data/pocket-public-catalog.js";
import type { AssetCatalogQuery } from "./market-data/types.js";
import { TelegramInitDataError, verifyTelegramInitData } from "./telegram/init-data.js";
import { createTelegramBotApi, type TelegramBotApi } from "./telegram/bot-api.js";
import { parseWebhookCommand, verifyWebhookSecret } from "./telegram/webhook.js";

export type HealthResponse = {
  ok: true;
  service: "market-pulse-backend";
  status: "ready";
  database: "configured" | "not_configured";
  telegram: "configured" | "not_configured";
  timestamp: string;
};

type AppDependencies = {
  telegramBotApi?: TelegramBotApi;
  assetCatalog?: AssetCatalog;
};

type AssetsQuerystring = {
  market?: string;
  search?: string;
};

export async function createApp(
  config: AppConfig,
  dependencies: AppDependencies = {}
): Promise<FastifyInstance> {
  const database = createSupabaseAdminClient(config);
  const telegramBotApi =
    dependencies.telegramBotApi ??
    createTelegramBotApi({ botToken: config.telegramBotToken, miniAppUrl: config.telegramMiniAppUrl });
  const app = Fastify({
    logger: config.nodeEnv !== "test",
    trustProxy: true
  });
  const assetCatalog =
    dependencies.assetCatalog ??
    new AssetCatalogService({
      repository: database ? new SupabaseAssetCatalogRepository(database) : null,
      source: new PocketPublicCatalogSource(),
      onRefreshError: (error) => app.log.warn({ err: error }, "Pocket asset catalog refresh failed")
    });

  app.addHook("onReady", async () => assetCatalog.start());
  app.addHook("onClose", async () => assetCatalog.stop());

  await app.register(cors, {
    origin: config.frontendOrigin,
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "X-Telegram-Init-Data"]
  });

  app.get("/api/wake", async () => {
    assetCatalog.requestRefresh();
    return { ok: true as const };
  });

  app.get<{ Reply: HealthResponse }>("/api/health", async () => ({
    ok: true,
    service: "market-pulse-backend",
    status: "ready",
    database: database ? "configured" : "not_configured",
    telegram:
      config.telegramBotToken && config.telegramWebhookSecret && config.backendPublicUrl
        ? "configured"
        : "not_configured",
    timestamp: new Date().toISOString()
  }));

  app.get<{ Querystring: AssetsQuerystring }>("/api/assets", async (request, reply) => {
    const rawMarket = request.query.market ?? "all";
    if (!(["all", "regular", "otc"] as const).includes(rawMarket as AssetCatalogQuery["market"])) {
      return reply.code(400).send({
        ok: false,
        error: { code: "INVALID_MARKET_FILTER", message: "market має бути all, regular або otc" }
      });
    }

    const query: AssetCatalogQuery = {
      market: rawMarket as AssetCatalogQuery["market"],
      search: (request.query.search ?? "").trim().slice(0, 60)
    };
    const response = await assetCatalog.list(query);

    return reply.header("Cache-Control", "public, max-age=10, stale-while-revalidate=30").send(response);
  });

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

  app.post("/api/telegram/webhook", async (request, reply) => {
    const header = request.headers["x-telegram-bot-api-secret-token"];
    const receivedSecret = Array.isArray(header) ? "" : (header ?? "");

    if (!verifyWebhookSecret(receivedSecret, config.telegramWebhookSecret)) {
      return reply.code(401).send({ ok: false });
    }

    const command = parseWebhookCommand(request.body);
    if (!command) return { ok: true };

    await telegramBotApi.sendStartMessage(command.chatId);
    return { ok: true };
  });

  return app;
}
