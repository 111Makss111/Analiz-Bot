import type { CandleStore } from "./candle-store.js";
import type { MarketDataPipeline } from "./market-data-pipeline.js";
import type { CollectorAsset, PocketAssetStore } from "./pocket-asset-store.js";
import { parsePocketDemoAuthPacket, type PocketDemoAuth } from "./pocket-auth.js";
import { PocketClock } from "./pocket-clock.js";
import {
  parsePocketAssets,
  parsePocketHistory,
  parsePocketStream,
  type PocketHistory,
  type PocketProtocolCandle,
  type PocketProtocolTick
} from "./pocket-protocol.js";
import type {
  PocketTransport,
  PocketTransportFactory,
  PocketTransportHandlers
} from "./pocket-transport.js";
import type {
  MarketCandle,
  PocketTick,
  StoredCandle,
  TimeframeSeconds
} from "./types.js";

export type PocketCollectorState =
  | "disabled"
  | "not_configured"
  | "connecting"
  | "authenticating"
  | "ready"
  | "degraded"
  | "auth_rejected"
  | "stopped";

export type PocketCollectorStatus = {
  state: PocketCollectorState;
  configured: boolean;
  enabled: boolean;
  connected: boolean;
  authenticated: boolean;
  message: string;
  activeAssets: number;
  priorityAssets: number;
  subscriptions: number;
  reconnectAttempt: number;
  reconnectScheduled: boolean;
  lastConnectedAt: string | null;
  lastAuthenticatedAt: string | null;
  lastStreamAt: string | null;
  lastTickAt: string | null;
  lastCatalogAt: string | null;
  lastHistoryAt: string | null;
  quoteAgeMs: number | null;
  rawPocketClockOffsetMs: number | null;
  pocketClockOffsetMs: number | null;
  pocketTimestampCorrectionMs: number | null;
  acceptedTicks: number;
  rejectedTicks: number;
  historyCandles: number;
  maxPriorityAssets: number;
  catalogWrites: number;
  catalogWritesSkipped: number;
  lastError: string | null;
};

export type PrepareAssetResult = {
  ok: boolean;
  code: string;
  message: string;
  assetId: string;
  pocketSymbol?: string;
  collector: PocketCollectorStatus;
};

export interface PocketCollectorRuntime {
  start(): Promise<void>;
  stop(): Promise<void>;
  status(): PocketCollectorStatus;
  prepareAsset(assetId: string): Promise<PrepareAssetResult>;
}

type CollectorOptions = {
  enabled: boolean;
  authPacket: string;
  maxAssets: number;
  staleAfterMs: number;
  assetStore: PocketAssetStore;
  candleStore: CandleStore;
  pipeline: MarketDataPipeline;
  transportFactory: PocketTransportFactory;
  onError?: (error: unknown, message: string) => void;
};

type PendingHistory = {
  history: PocketHistory;
  receivedAtMs: number;
};

const AUTH_TIMEOUT_MS = 20_000;
const WATCHDOG_INTERVAL_MS = 5_000;
const MAX_RECONNECT_DELAY_MS = 30_000;
const MAX_PENDING_HISTORIES = 200;
const CATALOG_WRITE_INTERVAL_MS = 30_000;
const HISTORY_CANDLE_LIMITS: Record<TimeframeSeconds, number> = { 30: 120, 60: 120, 300: 36 };

export function reconnectDelayMs(attempt: number): number {
  const exponent = Math.min(5, Math.max(0, Math.trunc(attempt) - 1));
  return Math.min(MAX_RECONNECT_DELAY_MS, 1_000 * 2 ** exponent);
}

function safeMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error ?? "Невідома помилка");
  return message.replace(/[\r\n]+/g, " ").slice(0, 240);
}

function iso(timestampMs: number | null): string | null {
  return timestampMs ? new Date(timestampMs).toISOString() : null;
}

function candleKey(candle: MarketCandle) {
  return `${candle.assetId}:${candle.timeframeSeconds}:${candle.openTimeMs}`;
}

function storedToMarketCandle(candle: StoredCandle): MarketCandle | null {
  const openTimeMs = Date.parse(candle.openTime);
  const closeTimeMs = Date.parse(candle.closeTime);
  const lastTickTimeMs = Date.parse(candle.lastTickAt);
  if (![openTimeMs, closeTimeMs, lastTickTimeMs].every(Number.isFinite)) return null;
  return {
    assetId: candle.assetId,
    timeframeSeconds: candle.timeframeSeconds,
    openTimeMs,
    closeTimeMs,
    lastTickTimeMs,
    open: candle.open,
    high: candle.high,
    low: candle.low,
    close: candle.close,
    tickCount: candle.tickCount,
    isComplete: candle.isComplete
  };
}

function limitHistoricalCandles(candles: MarketCandle[]): MarketCandle[] {
  return ([30, 60, 300] as const).flatMap((timeframeSeconds) =>
    candles
      .filter((candle) => candle.timeframeSeconds === timeframeSeconds && candle.isComplete)
      .sort((left, right) => left.openTimeMs - right.openTimeMs)
      .slice(-HISTORY_CANDLE_LIMITS[timeframeSeconds])
  );
}

function buildHistoricalCandles(
  assetId: string,
  ticks: PocketProtocolTick[],
  receivedAtMs: number
): MarketCandle[] {
  const candles = new Map<string, MarketCandle>();
  for (const tick of [...ticks].sort((left, right) => left.pocketTimeMs - right.pocketTimeMs)) {
    for (const timeframeSeconds of [30, 60, 300] as const) {
      const durationMs = timeframeSeconds * 1_000;
      const openTimeMs = Math.floor(tick.pocketTimeMs / durationMs) * durationMs;
      const key = `${timeframeSeconds}:${openTimeMs}`;
      const current = candles.get(key);
      if (!current) {
        candles.set(key, {
          assetId,
          timeframeSeconds,
          openTimeMs,
          closeTimeMs: openTimeMs + durationMs,
          lastTickTimeMs: tick.pocketTimeMs,
          open: tick.price,
          high: tick.price,
          low: tick.price,
          close: tick.price,
          tickCount: 1,
          isComplete: openTimeMs + durationMs <= receivedAtMs
        });
        continue;
      }
      current.high = Math.max(current.high, tick.price);
      current.low = Math.min(current.low, tick.price);
      current.close = tick.price;
      current.lastTickTimeMs = tick.pocketTimeMs;
      current.tickCount += 1;
    }
  }
  return [...candles.values()].filter((candle) => candle.isComplete);
}

function convertPocketCandles(
  assetId: string,
  source: PocketProtocolCandle[],
  receivedAtMs: number
): MarketCandle[] {
  const converted = source
    .map<MarketCandle>((candle) => {
      const closeTimeMs = candle.openTimeMs + candle.timeframeSeconds * 1_000;
      return {
        assetId,
        timeframeSeconds: candle.timeframeSeconds,
        openTimeMs: candle.openTimeMs,
        closeTimeMs,
        // Pocket OHLC history does not expose the exact final tick timestamp.
        // This boundary marker is used only for ordering completed history rows.
        lastTickTimeMs: closeTimeMs - 1,
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
        tickCount: 0,
        isComplete: closeTimeMs <= receivedAtMs
      };
    })
    .filter((candle) => candle.isComplete);

  const sourceForM5 = converted.filter((candle) => candle.timeframeSeconds === 60);
  const m5 = new Map<number, MarketCandle>();
  for (const candle of sourceForM5.sort((left, right) => left.openTimeMs - right.openTimeMs)) {
    const openTimeMs = Math.floor(candle.openTimeMs / 300_000) * 300_000;
    const current = m5.get(openTimeMs);
    if (!current) {
      m5.set(openTimeMs, {
        ...candle,
        timeframeSeconds: 300,
        openTimeMs,
        closeTimeMs: openTimeMs + 300_000,
        isComplete: openTimeMs + 300_000 <= receivedAtMs
      });
      continue;
    }
    current.high = Math.max(current.high, candle.high);
    current.low = Math.min(current.low, candle.low);
    current.close = candle.close;
    current.lastTickTimeMs = candle.lastTickTimeMs;
  }
  return [...converted, ...[...m5.values()].filter((candle) => candle.isComplete)];
}

export class PocketCollector implements PocketCollectorRuntime {
  private transport: PocketTransport | null = null;
  private auth: PocketDemoAuth | null = null;
  private readonly assetsBySymbol = new Map<string, CollectorAsset>();
  private readonly priorityAssetIds = new Set<string>();
  private readonly requestedSubscriptions = new Set<string>();
  private state: PocketCollectorState = "stopped";
  private message = "Колектор не запущено";
  private connected = false;
  private authenticated = false;
  private stopped = true;
  private suppressReconnect = false;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private authTimer: ReturnType<typeof setTimeout> | null = null;
  private watchdogTimer: ReturnType<typeof setInterval> | null = null;
  private lastConnectedAt: number | null = null;
  private lastAuthenticatedAt: number | null = null;
  private lastStreamAt: number | null = null;
  private lastTickAt: number | null = null;
  private lastCatalogAt: number | null = null;
  private lastHistoryAt: number | null = null;
  private rawPocketClockOffsetMs: number | null = null;
  private pocketClockOffsetMs: number | null = null;
  private acceptedTicks = 0;
  private rejectedTicks = 0;
  private historyCandles = 0;
  private catalogWrites = 0;
  private catalogWritesSkipped = 0;
  private lastError: string | null = null;
  private catalogWrite: Promise<void> = Promise.resolve();
  private catalogTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingCatalog: { assets: ReturnType<typeof parsePocketAssets>; receivedAtMs: number; fingerprint: string } | null = null;
  private lastCatalogPersistAtMs = 0;
  private lastCatalogFingerprint: string | null = null;
  private readonly clock: PocketClock;
  private readonly pendingHistories: PendingHistory[] = [];

  constructor(private readonly options: CollectorOptions) {
    this.clock = new PocketClock(options.staleAfterMs);
  }

  async start(): Promise<void> {
    if (!this.stopped) return;
    this.stopped = false;
    if (!this.options.enabled) {
      this.state = "disabled";
      this.message = "Pocket collector вимкнено";
      return;
    }
    if (!this.options.authPacket.trim()) {
      this.state = "not_configured";
      this.message = "Додайте POCKET_AUTH_PACKET у Render";
      return;
    }

    try {
      this.auth = parsePocketDemoAuthPacket(this.options.authPacket);
    } catch (error) {
      this.state = "auth_rejected";
      this.lastError = safeMessage(error);
      this.message = this.lastError;
      return;
    }

    try {
      this.options.pipeline.start();
      this.transport = this.options.transportFactory(this.handlers());
      this.startWatchdog();
      this.connect();
    } catch (error) {
      this.state = "degraded";
      this.lastError = safeMessage(error);
      this.message = "Не вдалося запустити Pocket collector";
      this.options.onError?.(error, "Pocket collector startup failed");
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.suppressReconnect = true;
    this.clearReconnectTimer();
    this.clearAuthTimer();
    if (this.watchdogTimer) clearInterval(this.watchdogTimer);
    this.watchdogTimer = null;
    if (this.catalogTimer) clearTimeout(this.catalogTimer);
    this.catalogTimer = null;
    this.pendingCatalog = null;
    this.transport?.disconnect();
    this.transport = null;
    this.connected = false;
    this.authenticated = false;
    this.pendingHistories.length = 0;
    this.clock.reset();
    await this.catalogWrite.catch(() => undefined);
    await this.options.pipeline.stop();
    this.state = "stopped";
    this.message = "Pocket collector зупинено";
  }

  status(): PocketCollectorStatus {
    const now = Date.now();
    const quoteAgeMs = this.lastTickAt === null ? null : Math.max(0, now - this.lastTickAt);
    const stale = this.authenticated && quoteAgeMs !== null && quoteAgeMs > this.options.staleAfterMs;
    return {
      state: stale && this.state === "ready" ? "degraded" : this.state,
      configured: Boolean(this.options.authPacket.trim()),
      enabled: this.options.enabled,
      connected: this.connected,
      authenticated: this.authenticated,
      message: stale ? "Pocket з’єднано, але остання котировка застаріла" : this.message,
      activeAssets: this.assetsBySymbol.size,
      priorityAssets: this.priorityAssetIds.size,
      subscriptions: this.requestedSubscriptions.size,
      reconnectAttempt: this.reconnectAttempt,
      reconnectScheduled: this.reconnectTimer !== null,
      lastConnectedAt: iso(this.lastConnectedAt),
      lastAuthenticatedAt: iso(this.lastAuthenticatedAt),
      lastStreamAt: iso(this.lastStreamAt),
      lastTickAt: iso(this.lastTickAt),
      lastCatalogAt: iso(this.lastCatalogAt),
      lastHistoryAt: iso(this.lastHistoryAt),
      quoteAgeMs,
      rawPocketClockOffsetMs: this.rawPocketClockOffsetMs,
      pocketClockOffsetMs: this.pocketClockOffsetMs,
      pocketTimestampCorrectionMs: this.clock.correctionMs(),
      acceptedTicks: this.acceptedTicks,
      rejectedTicks: this.rejectedTicks,
      historyCandles: this.historyCandles,
      maxPriorityAssets: this.options.maxAssets,
      catalogWrites: this.catalogWrites,
      catalogWritesSkipped: this.catalogWritesSkipped,
      lastError: this.lastError
    };
  }

  async prepareAsset(assetId: string): Promise<PrepareAssetResult> {
    const asset = await this.options.assetStore.findById(assetId);
    if (!asset) {
      return {
        ok: false,
        code: "POCKET_ASSET_NOT_FOUND",
        message: "Актив відсутній у каталозі Pocket",
        assetId,
        collector: this.status()
      };
    }

    this.promoteAsset(asset);
    const requested = this.authenticated ? this.subscribeAsset(asset, true) : 0;
    const active =
      this.authenticated &&
      ([30, 60] as const).every((period) =>
        this.requestedSubscriptions.has(`${asset.pocketSymbol}:${period}`)
      );
    void this.hydrateStoredCandles(asset);
    return {
      ok: true,
      code:
        requested > 0
          ? "POCKET_HISTORY_REQUESTED"
          : active
            ? "POCKET_ASSET_READY"
            : "POCKET_ASSET_QUEUED",
      message:
        requested > 0
          ? "Актив отримав пріоритет; запитано історію 30s і M1"
          : active
            ? "Актив уже має пріоритетну live-підписку"
            : "Актив отримав пріоритет і очікує з’єднання Pocket",
      assetId,
      pocketSymbol: asset.pocketSymbol,
      collector: this.status()
    };
  }

  private handlers(): PocketTransportHandlers {
    return {
      onConnected: () => this.handleConnected(),
      onAuthenticated: () => this.handleAuthenticated(),
      onAuthRejected: (message) => this.handleAuthRejected(message),
      onDisconnected: (reason) => this.handleDisconnected(reason),
      onConnectError: (message) => this.handleConnectError(message),
      onStream: (payload) => this.handleStream(payload),
      onAssets: (payload) => this.handleAssets(payload),
      onHistory: (payload) => void this.handleHistory(payload),
      onBinary: (payload) => this.handleBinary(payload)
    };
  }

  private connect(): void {
    if (this.stopped || !this.auth || !this.transport) return;
    this.suppressReconnect = false;
    this.clearReconnectTimer();
    this.state = "connecting";
    this.message = "Підключення до Pocket Demo";
    this.transport.connect(this.auth);
  }

  private handleConnected(): void {
    this.connected = true;
    this.authenticated = false;
    this.requestedSubscriptions.clear();
    this.pendingHistories.length = 0;
    this.clock.reset();
    this.rawPocketClockOffsetMs = null;
    this.pocketClockOffsetMs = null;
    this.lastConnectedAt = Date.now();
    this.state = "authenticating";
    this.message = "WebSocket підключено; перевіряємо Demo-сесію";
    this.clearAuthTimer();
    this.authTimer = setTimeout(() => {
      if (this.authenticated || this.stopped) return;
      this.handleAuthRejected("Pocket не підтвердив Demo-сесію за 20 секунд; оновіть POCKET_AUTH_PACKET");
    }, AUTH_TIMEOUT_MS);
    this.authTimer.unref();
  }

  private handleAuthenticated(): void {
    this.clearAuthTimer();
    this.authenticated = true;
    this.reconnectAttempt = 0;
    this.lastAuthenticatedAt = Date.now();
    this.state = "ready";
    this.message = "Pocket Demo підключено";
    this.lastError = null;
    this.subscribePriorityAssets();
  }

  private handleAuthRejected(message: string): void {
    this.clearAuthTimer();
    this.suppressReconnect = true;
    this.connected = false;
    this.authenticated = false;
    this.state = "auth_rejected";
    this.message = "Pocket відхилив Demo-сесію";
    this.lastError = safeMessage(message);
    this.transport?.disconnect();
  }

  private handleDisconnected(reason: string): void {
    this.clearAuthTimer();
    this.connected = false;
    this.authenticated = false;
    this.requestedSubscriptions.clear();
    if (this.stopped || this.suppressReconnect) return;
    this.state = "degraded";
    this.message = `Pocket відключено: ${safeMessage(reason)}`;
    this.lastError = this.message;
    this.scheduleReconnect();
  }

  private handleConnectError(message: string): void {
    if (this.stopped || this.suppressReconnect) return;
    this.connected = false;
    this.authenticated = false;
    this.state = "degraded";
    this.lastError = `Помилка Pocket WebSocket: ${safeMessage(message)}`;
    this.message = this.lastError;
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.stopped) return;
    this.reconnectAttempt += 1;
    const delay = reconnectDelayMs(this.reconnectAttempt);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
    this.reconnectTimer.unref();
  }

  private handleStream(payload: unknown): void {
    const receivedAtMs = Date.now();
    const ticks = parsePocketStream(payload);
    if (ticks.length === 0) return;
    this.lastStreamAt = receivedAtMs;
    for (const parsed of ticks) {
      const asset = this.assetsBySymbol.get(parsed.pocketSymbol);
      if (!asset) {
        this.rejectedTicks += 1;
        continue;
      }
      const clock = this.clock.normalize(parsed.pocketTimeMs, receivedAtMs);
      this.rawPocketClockOffsetMs = clock.rawOffsetMs;
      this.pocketClockOffsetMs = clock.normalizedOffsetMs;
      if (!clock.accepted || clock.normalizedTimestampMs === null) {
        this.rejectedTicks += 1;
        continue;
      }
      const tick: PocketTick = {
        assetId: asset.id,
        price: parsed.price,
        pocketTimeMs: clock.normalizedTimestampMs,
        receivedAtMs,
        sequence: parsed.sequence
      };
      const result = this.options.pipeline.ingest(tick);
      if (result.accepted) {
        this.acceptedTicks += 1;
        this.lastTickAt = Math.max(this.lastTickAt ?? 0, tick.pocketTimeMs);
      } else {
        this.rejectedTicks += 1;
      }
      if (clock.justCalibrated) void this.flushPendingHistories();
    }
  }

  private handleAssets(payload: unknown): void {
    const assets = parsePocketAssets(payload);
    if (assets.length === 0) return;
    const receivedAtMs = Date.now();
    this.lastCatalogAt = receivedAtMs;
    const liveBySymbol = new Map(assets.map((asset) => [asset.pocketSymbol, asset]));
    for (const [symbol, selected] of this.assetsBySymbol) {
      const live = liveBySymbol.get(symbol);
      if (!live) continue;
      this.assetsBySymbol.set(symbol, {
        ...selected,
        displayName: live.displayName,
        marketType: live.marketType
      });
    }

    const fingerprint = JSON.stringify(
      assets
        .map((asset) => [
          asset.pocketSymbol,
          asset.isAvailable,
          asset.payoutPercent,
          asset.displayName
        ])
        .sort(([left], [right]) => String(left).localeCompare(String(right)))
    );
    if (fingerprint === this.lastCatalogFingerprint && !this.pendingCatalog) {
      this.catalogWritesSkipped += 1;
      return;
    }
    this.pendingCatalog = { assets, receivedAtMs, fingerprint };
    this.scheduleCatalogPersist();
  }

  private async handleHistory(payload: unknown): Promise<void> {
    const history = parsePocketHistory(payload);
    if (!history) return;
    const receivedAtMs = Date.now();
    this.lastHistoryAt = receivedAtMs;
    if (!this.clock.isCalibrated()) {
      if (this.pendingHistories.length >= MAX_PENDING_HISTORIES) this.pendingHistories.shift();
      this.pendingHistories.push({ history, receivedAtMs });
      return;
    }
    await this.persistHistory(history, receivedAtMs);
  }

  private async persistHistory(history: PocketHistory, receivedAtMs: number): Promise<void> {
    const asset = this.assetsBySymbol.get(history.pocketSymbol);
    if (!asset) return;
    const correctionMs = this.clock.correctionMs();
    if (correctionMs === null) return;
    const ticks = history.ticks.map((tick) => ({
      ...tick,
      pocketTimeMs: tick.pocketTimeMs - correctionMs
    }));
    const sourceCandles = history.candles.map((candle) => ({
      ...candle,
      openTimeMs: candle.openTimeMs - correctionMs
    }));
    const candles = new Map<string, MarketCandle>();
    for (const candle of [
      ...buildHistoricalCandles(asset.id, ticks, receivedAtMs),
      ...convertPocketCandles(asset.id, sourceCandles, receivedAtMs)
    ]) {
      candles.set(candleKey(candle), candle);
    }
    const values = limitHistoricalCandles([...candles.values()]);
    if (values.length === 0) return;
    try {
      await this.options.pipeline.persistHistoricalCandles(values);
      this.historyCandles += values.length;
    } catch (error) {
      this.lastError = safeMessage(error);
      this.options.onError?.(error, "Pocket history persistence failed");
    }
  }

  private async flushPendingHistories(): Promise<void> {
    if (!this.clock.isCalibrated() || this.pendingHistories.length === 0) return;
    const pending = this.pendingHistories.splice(0);
    for (const item of pending) await this.persistHistory(item.history, item.receivedAtMs);
  }

  private handleBinary(payload: unknown): void {
    const assets = parsePocketAssets(payload);
    if (assets.length > 0) {
      this.handleAssets(payload);
      return;
    }
    const history = parsePocketHistory(payload);
    if (history) {
      void this.handleHistory(payload);
      return;
    }
    if (parsePocketStream(payload).length > 0) this.handleStream(payload);
  }

  private promoteAsset(asset: CollectorAsset): void {
    if (this.priorityAssetIds.has(asset.id)) this.priorityAssetIds.delete(asset.id);
    while (this.priorityAssetIds.size >= this.options.maxAssets) {
      const evictedId = this.priorityAssetIds.values().next().value as string | undefined;
      if (!evictedId) break;
      this.priorityAssetIds.delete(evictedId);
      const evicted = [...this.assetsBySymbol.values()].find((candidate) => candidate.id === evictedId);
      if (!evicted) continue;
      this.assetsBySymbol.delete(evicted.pocketSymbol);
      this.transport?.unsubscribe(evicted.pocketSymbol);
      this.options.pipeline.releaseAsset(evicted.id);
      for (const key of [...this.requestedSubscriptions]) {
        if (key.startsWith(`${evicted.pocketSymbol}:`)) this.requestedSubscriptions.delete(key);
      }
    }
    this.priorityAssetIds.add(asset.id);
    this.assetsBySymbol.set(asset.pocketSymbol, asset);
  }

  private async hydrateStoredCandles(asset: CollectorAsset): Promise<void> {
    try {
      const stored = await Promise.all([
        this.options.candleStore.list(asset.id, 30, HISTORY_CANDLE_LIMITS[30]),
        this.options.candleStore.list(asset.id, 60, HISTORY_CANDLE_LIMITS[60]),
        this.options.candleStore.list(asset.id, 300, HISTORY_CANDLE_LIMITS[300])
      ]);
      this.options.pipeline.hydrateHistoricalCandles(
        stored.flatMap((response) =>
          response.candles
            .map(storedToMarketCandle)
            .filter((candle): candle is MarketCandle => candle !== null)
        )
      );
    } catch (error) {
      // Pocket history can still warm the selected asset when the cache is temporarily unavailable.
      this.lastError = safeMessage(error);
      this.options.onError?.(error, "Stored candle hydration failed");
    }
  }

  private subscribePriorityAssets(): void {
    for (const asset of this.assetsBySymbol.values()) {
      if (this.priorityAssetIds.has(asset.id)) this.subscribeAsset(asset, true);
    }
  }

  private subscribeAsset(asset: CollectorAsset, priority: boolean): number {
    if (!this.transport || !this.authenticated) return 0;
    let requested = 0;
    const periods: (30 | 60)[] = priority ? [30, 60] : [60];
    for (const period of periods) {
      if (!this.transport.subscribe(asset.pocketSymbol, period)) continue;
      this.requestedSubscriptions.add(`${asset.pocketSymbol}:${period}`);
      requested += 1;
    }
    return requested;
  }

  private scheduleCatalogPersist(): void {
    if (this.catalogTimer || !this.pendingCatalog) return;
    const delay = Math.max(
      0,
      CATALOG_WRITE_INTERVAL_MS - (Date.now() - this.lastCatalogPersistAtMs)
    );
    this.catalogTimer = setTimeout(() => {
      this.catalogTimer = null;
      this.flushCatalogPersist();
    }, delay);
    this.catalogTimer.unref();
  }

  private flushCatalogPersist(): void {
    const pending = this.pendingCatalog;
    if (!pending) return;
    this.pendingCatalog = null;
    this.catalogWrite = this.catalogWrite
      .then(async () => {
        await this.options.assetStore.applyLiveCatalog(
          pending.assets,
          new Date(pending.receivedAtMs).toISOString()
        );
        this.lastCatalogFingerprint = pending.fingerprint;
        this.lastCatalogPersistAtMs = Date.now();
        this.catalogWrites += 1;
      })
      .catch((error) => {
        this.lastError = safeMessage(error);
        this.options.onError?.(error, "Pocket live catalog persistence failed");
      })
      .finally(() => {
        if (this.pendingCatalog) this.scheduleCatalogPersist();
      });
  }

  private startWatchdog(): void {
    if (this.watchdogTimer) return;
    this.watchdogTimer = setInterval(() => {
      if (!this.authenticated || this.lastTickAt === null) return;
      if (Date.now() - this.lastTickAt > this.options.staleAfterMs) {
        this.state = "degraded";
        this.message = "Остання котировка Pocket застаріла";
      } else if (this.state === "degraded" && this.connected) {
        this.state = "ready";
        this.message = "Pocket Demo підключено";
      }
    }, WATCHDOG_INTERVAL_MS);
    this.watchdogTimer.unref();
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private clearAuthTimer(): void {
    if (this.authTimer) clearTimeout(this.authTimer);
    this.authTimer = null;
  }
}

export class UnavailablePocketCollector implements PocketCollectorRuntime {
  async start(): Promise<void> {}
  async stop(): Promise<void> {}

  status(): PocketCollectorStatus {
    return {
      state: "not_configured",
      configured: false,
      enabled: false,
      connected: false,
      authenticated: false,
      message: "Pocket collector недоступний без Supabase",
      activeAssets: 0,
      priorityAssets: 0,
      subscriptions: 0,
      reconnectAttempt: 0,
      reconnectScheduled: false,
      lastConnectedAt: null,
      lastAuthenticatedAt: null,
      lastStreamAt: null,
      lastTickAt: null,
      lastCatalogAt: null,
      lastHistoryAt: null,
      quoteAgeMs: null,
      rawPocketClockOffsetMs: null,
      pocketClockOffsetMs: null,
      pocketTimestampCorrectionMs: null,
      acceptedTicks: 0,
      rejectedTicks: 0,
      historyCandles: 0,
      maxPriorityAssets: 0,
      catalogWrites: 0,
      catalogWritesSkipped: 0,
      lastError: null
    };
  }

  async prepareAsset(assetId: string): Promise<PrepareAssetResult> {
    return {
      ok: false,
      code: "POCKET_COLLECTOR_UNAVAILABLE",
      message: "Pocket collector недоступний",
      assetId,
      collector: this.status()
    };
  }
}
