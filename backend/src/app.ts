import cors from "@fastify/cors";
import Fastify, { type FastifyInstance } from "fastify";
import type { AppConfig } from "./config.js";
import { createSupabaseAdminClient } from "./database/client.js";
import { AssetCatalogService, type AssetCatalog } from "./market-data/asset-catalog-service.js";
import { SupabaseAssetCatalogRepository } from "./market-data/asset-catalog-repository.js";
import {
  SupabaseCandleStore,
  UnavailableCandleStore,
  type CandleStore
} from "./market-data/candle-store.js";
import {
  PocketCollector,
  UnavailablePocketCollector,
  type PocketCollectorRuntime
} from "./market-data/pocket-collector.js";
import { SupabasePocketAssetStore } from "./market-data/pocket-asset-store.js";
import { MarketDataPipeline } from "./market-data/market-data-pipeline.js";
import { SupabaseMarketDataWriter } from "./market-data/market-data-writer.js";
import { PocketPublicCatalogSource } from "./market-data/pocket-public-catalog.js";
import { SocketIoPocketTransport } from "./market-data/pocket-transport.js";
import {
  SUPPORTED_TIMEFRAMES,
  type AssetCatalogQuery,
  type TimeframeSeconds
} from "./market-data/types.js";
import { TelegramInitDataError, verifyTelegramInitData } from "./telegram/init-data.js";
import { createTelegramBotApi, type TelegramBotApi } from "./telegram/bot-api.js";
import { parseWebhookCommand, verifyWebhookSecret } from "./telegram/webhook.js";

export type HealthResponse = {
  ok: true;
  service: "market-pulse-backend";
  status: "ready";
  database: "configured" | "not_configured";
  telegram: "configured" | "not_configured";
  pocket: "ready" | "warming" | "not_configured" | "error";
  timestamp: string;
};

type AppDependencies = {
  telegramBotApi?: TelegramBotApi;
  assetCatalog?: AssetCatalog;
  candleStore?: CandleStore;
  pocketCollector?: PocketCollectorRuntime;
};

type AssetsQuerystring = {
  market?: string;
  search?: string;
};

type CandlesParams = { assetId: string };
type CandlesQuerystring = { timeframe?: string; limit?: string };
type PrepareAssetBody = { assetId?: string };

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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
  const candleStore =
    dependencies.candleStore ??
    (database ? new SupabaseCandleStore(database) : new UnavailableCandleStore());
  const marketDataPipeline = new MarketDataPipeline(
    database ? new SupabaseMarketDataWriter(database) : null,
    (error) => app.log.error({ err: error }, "Pocket market-data persistence failed")
  );
  const pocketCollector =
    dependencies.pocketCollector ??
    (database
      ? new PocketCollector({
          enabled: config.pocketCollectorEnabled,
          authPacket: config.pocketAuthPacket,
          maxAssets: config.pocketMaxAssets,
          staleAfterMs: config.pocketStaleAfterMs,
          assetStore: new SupabasePocketAssetStore(database),
          candleStore,
          pipeline: marketDataPipeline,
          transportFactory: (handlers) =>
            new SocketIoPocketTransport(config.pocketDemoEndpoint, handlers),
          onError: (error, message) => app.log.warn({ err: error }, message)
        })
      : new UnavailablePocketCollector());

  app.addHook("onReady", async () => {
    assetCatalog.start();
    await pocketCollector.start();
  });
  app.addHook("onClose", async () => {
    await pocketCollector.stop();
    assetCatalog.stop();
  });

  await app.register(cors, {
    origin: config.frontendOrigin,
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "X-Telegram-Init-Data"]
  });

  app.get("/api/wake", async () => {
    assetCatalog.requestRefresh();
    return { ok: true as const };
  });

  app.get<{ Reply: HealthResponse }>("/api/health", async () => {
    const pocketState = pocketCollector.status().state;
    return {
      ok: true,
      service: "market-pulse-backend",
      status: "ready",
      database: database ? "configured" : "not_configured",
      telegram:
        config.telegramBotToken && config.telegramWebhookSecret && config.backendPublicUrl
          ? "configured"
          : "not_configured",
      pocket:
        pocketState === "ready"
          ? "ready"
          : pocketState === "not_configured" || pocketState === "disabled"
            ? "not_configured"
            : pocketState === "auth_rejected"
              ? "error"
              : "warming",
      timestamp: new Date().toISOString()
    };
  });

  app.get("/api/diagnostics", async (request, reply) => {
    const header = request.headers["x-diagnostics-secret"];
    const receivedSecret = Array.isArray(header) ? "" : (header ?? "");
    if (!config.diagnosticsSecret || !verifyWebhookSecret(receivedSecret, config.diagnosticsSecret)) {
      return reply.code(401).send({ ok: false });
    }
    return reply.header("Cache-Control", "no-store").send({
      ok: true,
      timestamp: new Date().toISOString(),
      database: database ? "configured" : "not_configured",
      pocket: pocketCollector.status()
    });
  });

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

  app.get<{ Params: CandlesParams; Querystring: CandlesQuerystring }>(
    "/api/assets/:assetId/candles",
    async (request, reply) => {
      if (!UUID_PATTERN.test(request.params.assetId)) {
        return reply.code(400).send({
          ok: false,
          error: { code: "INVALID_ASSET_ID", message: "assetId має бути UUID" }
        });
      }

      const timeframe = Number(request.query.timeframe ?? "60");
      if (!SUPPORTED_TIMEFRAMES.includes(timeframe as TimeframeSeconds)) {
        return reply.code(400).send({
          ok: false,
          error: { code: "INVALID_TIMEFRAME", message: "timeframe має бути 30, 60 або 300" }
        });
      }

      const limit = Number(request.query.limit ?? "120");
      if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
        return reply.code(400).send({
          ok: false,
          error: { code: "INVALID_CANDLE_LIMIT", message: "limit має бути від 1 до 500" }
        });
      }

      const response = await candleStore.list(
        request.params.assetId,
        timeframe as TimeframeSeconds,
        limit
      );
      return reply.header("Cache-Control", "public, max-age=2, stale-while-revalidate=5").send(response);
    }
  );

  app.post<{ Body: PrepareAssetBody }>("/api/assets/prepare", async (request, reply) => {
    const header = request.headers["x-telegram-init-data"];
    const rawInitData = Array.isArray(header) ? "" : (header ?? "");
    try {
      verifyTelegramInitData(rawInitData, {
        botToken: config.telegramBotToken,
        maxAgeSeconds: config.telegramInitDataTtlSeconds
      });
    } catch (error) {
      if (!(error instanceof TelegramInitDataError)) throw error;
      return reply.code(401).header("Cache-Control", "no-store").send({
        ok: false,
        error: { code: error.code, message: error.message }
      });
    }

    const assetId = request.body?.assetId ?? "";
    if (!UUID_PATTERN.test(assetId)) {
      return reply.code(400).send({
        ok: false,
        error: { code: "INVALID_ASSET_ID", message: "assetId має бути UUID" }
      });
    }
    const result = await pocketCollector.prepareAsset(assetId);
    return reply
      .code(result.ok ? 200 : result.code === "POCKET_ASSET_NOT_FOUND" ? 404 : 503)
      .header("Cache-Control", "no-store")
      .send(result);
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
