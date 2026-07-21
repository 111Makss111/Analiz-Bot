import cors from "@fastify/cors";
import Fastify, { type FastifyInstance } from "fastify";
import { SupabaseAnalysisDataSource } from "./analysis/analysis-data-source.js";
import {
  AnalysisError,
  AnalysisService,
  UnavailableAnalysisRuntime,
  type AnalysisRuntime
} from "./analysis/analysis-service.js";
import type {
  AnalysisExpirationMinutes,
  AnalyzeRequest,
  AnalyzeResponse
} from "./analysis/types.js";
import type { AppConfig } from "./config.js";
import { createSupabaseAdminClient } from "./database/client.js";
import { DatabaseHealthMonitor, type DatabaseHealthState } from "./database/health-monitor.js";
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
import { MarketDataRetentionService } from "./market-data/retention-service.js";
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
  database: DatabaseHealthState;
  telegram: "configured" | "not_configured";
  pocket: "ready" | "warming" | "disabled" | "not_configured" | "error";
  timestamp: string;
};

type AppDependencies = {
  telegramBotApi?: TelegramBotApi;
  assetCatalog?: AssetCatalog;
  candleStore?: CandleStore;
  pocketCollector?: PocketCollectorRuntime;
  analysisRuntime?: AnalysisRuntime;
};

type AssetsQuerystring = {
  market?: string;
  search?: string;
};

type CandlesParams = { assetId: string };
type CandlesQuerystring = { timeframe?: string; limit?: string };
type PrepareAssetBody = { assetId?: string };
type AnalyzeBody = { assetId?: string; expirationMinutes?: number };

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
  const candleStore =
    dependencies.candleStore ??
    (database ? new SupabaseCandleStore(database) : new UnavailableCandleStore());
  const marketDataPipeline = new MarketDataPipeline(
    database ? new SupabaseMarketDataWriter(database) : null,
    (error) => app.log.error({ err: error }, "Pocket market-data persistence failed")
  );
  const assetCatalog =
    dependencies.assetCatalog ??
    new AssetCatalogService({
      repository: database ? new SupabaseAssetCatalogRepository(database) : null,
      source: new PocketPublicCatalogSource(),
      liveQuotes: marketDataPipeline,
      onRefreshError: (error) => app.log.warn({ err: error }, "Pocket asset catalog refresh failed")
    });
  const databaseHealth = new DatabaseHealthMonitor(database);
  const retention = new MarketDataRetentionService(database, (error) =>
    app.log.warn({ err: error }, "Pocket market-data retention failed")
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
  const analysisRuntime =
    dependencies.analysisRuntime ??
    (database
      ? new AnalysisService(new SupabaseAnalysisDataSource(database, candleStore, marketDataPipeline))
      : new UnavailableAnalysisRuntime());

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
    retention.request();
    return { ok: true as const };
  });

  app.get<{ Reply: HealthResponse }>("/api/health", async () => {
    const pocketState = pocketCollector.status().state;
    const databaseState = await databaseHealth.check();
    return {
      ok: true,
      service: "market-pulse-backend",
      status: "ready",
      database: databaseState.state,
      telegram:
        config.telegramBotToken && config.telegramWebhookSecret && config.backendPublicUrl
          ? "configured"
          : "not_configured",
      pocket:
        pocketState === "ready"
          ? "ready"
          : pocketState === "disabled"
            ? "disabled"
            : pocketState === "not_configured"
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
    const databaseState = await databaseHealth.check(true);
    return reply.header("Cache-Control", "no-store").send({
      ok: true,
      timestamp: new Date().toISOString(),
      database: databaseState,
      pocket: pocketCollector.status(),
      marketData: marketDataPipeline.status(),
      catalog: assetCatalog.diagnostics(),
      retention: retention.status()
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

  app.post<{ Body: AnalyzeBody; Reply: AnalyzeResponse }>(
    "/api/analyze",
    async (request, reply) => {
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
        return reply.code(400).header("Cache-Control", "no-store").send({
          ok: false,
          error: { code: "INVALID_ASSET_ID", message: "assetId має бути UUID" }
        });
      }
      const expirationMinutes = request.body?.expirationMinutes;
      if (!(expirationMinutes === 1 || expirationMinutes === 2 || expirationMinutes === 3)) {
        return reply.code(400).header("Cache-Control", "no-store").send({
          ok: false,
          error: { code: "INVALID_EXPIRATION", message: "Експірація має бути 1, 2 або 3 хвилини" }
        });
      }

      const collectorStatus = pocketCollector.status();
      if (!collectorStatus.connected || !collectorStatus.authenticated) {
        return reply.code(503).header("Cache-Control", "no-store").send({
          ok: false,
          error: {
            code: "POCKET_NOT_READY",
            message: "З'єднання з Pocket ще не готове; повторіть за кілька секунд"
          }
        });
      }

      const analyzeRequest: AnalyzeRequest = {
        assetId,
        expirationMinutes: expirationMinutes as AnalysisExpirationMinutes
      };
      try {
        const [prepared, analysis] = await Promise.all([
          pocketCollector.prepareAsset(assetId),
          analysisRuntime.analyze(analyzeRequest)
        ]);
        if (!prepared.ok) {
          return reply
            .code(prepared.code === "POCKET_ASSET_NOT_FOUND" ? 404 : 503)
            .header("Cache-Control", "no-store")
            .send({
              ok: false,
              error: { code: prepared.code, message: prepared.message }
            });
        }
        return reply.header("Cache-Control", "no-store").send({ ok: true, analysis });
      } catch (error) {
        if (!(error instanceof AnalysisError)) throw error;
        return reply.code(error.statusCode).header("Cache-Control", "no-store").send({
          ok: false,
          error: { code: error.code, message: error.message }
        });
      }
    }
  );

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
