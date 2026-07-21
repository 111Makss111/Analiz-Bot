import { io, type Socket } from "socket.io-client";
import type { PocketDemoAuth } from "./pocket-auth.js";

export type PocketTransportHandlers = {
  onConnected(): void;
  onAuthenticated(): void;
  onAuthRejected(message: string): void;
  onDisconnected(reason: string): void;
  onConnectError(message: string): void;
  onStream(payload: unknown): void;
  onAssets(payload: unknown): void;
  onHistory(payload: unknown): void;
  onBinary(payload: unknown): void;
};

export interface PocketTransport {
  connect(auth: PocketDemoAuth): void;
  disconnect(): void;
  subscribe(pocketSymbol: string, periodSeconds: 30 | 60): boolean;
  unsubscribe(pocketSymbol: string): boolean;
  isConnected(): boolean;
}

export type PocketTransportFactory = (handlers: PocketTransportHandlers) => PocketTransport;

type SocketFactory = typeof io;

export class SocketIoPocketTransport implements PocketTransport {
  private readonly socket: Socket;
  private auth: PocketDemoAuth | null = null;
  private readonly symbolSubscriptions = new Set<string>();
  private readonly historySubscriptions = new Set<string>();

  constructor(
    endpoint: string,
    private readonly handlers: PocketTransportHandlers,
    socketFactory: SocketFactory = io
  ) {
    this.socket = socketFactory(endpoint, {
      autoConnect: false,
      transports: ["websocket"],
      path: "/socket.io",
      reconnection: false,
      timeout: 10_000,
      extraHeaders: {
        Origin: "https://m.pocketoption.com",
        "User-Agent": "MarketPulse-ReadOnly-Demo-Collector/1.0"
      }
    });

    this.socket.on("connect", () => {
      this.symbolSubscriptions.clear();
      this.historySubscriptions.clear();
      this.handlers.onConnected();
      if (this.auth) this.socket.emit("auth", this.auth);
    });
    this.socket.on("successauth", () => this.handlers.onAuthenticated());
    for (const event of ["errorauth", "authError", "authFailed"]) {
      this.socket.on(event, () =>
        this.handlers.onAuthRejected(
          "Pocket відхилив Demo-сесію; потрібно оновити POCKET_AUTH_PACKET"
        )
      );
    }
    this.socket.on("updateStream", (payload: unknown) => this.handlers.onStream(payload));
    this.socket.on("updateAssets", (payload: unknown) => this.handlers.onAssets(payload));
    for (const event of ["updateHistoryNewFast", "updateHistoryNew", "loadHistoryPeriod"]) {
      this.socket.on(event, (payload: unknown) => this.handlers.onHistory(payload));
    }
    this.socket.on("disconnect", (reason) => {
      this.symbolSubscriptions.clear();
      this.historySubscriptions.clear();
      this.handlers.onDisconnected(String(reason));
    });
    this.socket.on("connect_error", (error) => this.handlers.onConnectError(error.message));

    this.socket.io.on("open", () => {
      const engine = this.socket.io.engine;
      engine?.off("packet", this.handleEnginePacket);
      engine?.on("packet", this.handleEnginePacket);
    });
  }

  private readonly handleEnginePacket = (packet: { type?: string; data?: unknown }) => {
    if (packet.type !== "message") return;
    const data = packet.data;
    if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) this.handlers.onBinary(data);
  };

  connect(auth: PocketDemoAuth): void {
    this.auth = auth;
    if (!this.socket.connected) this.socket.connect();
  }

  disconnect(): void {
    this.symbolSubscriptions.clear();
    this.historySubscriptions.clear();
    this.socket.io.engine?.off("packet", this.handleEnginePacket);
    this.socket.disconnect();
  }

  subscribe(pocketSymbol: string, periodSeconds: 30 | 60): boolean {
    if (!this.socket.connected || !this.authenticatedSubscriptionKey(pocketSymbol, periodSeconds)) {
      return false;
    }
    const key = `${pocketSymbol}:${periodSeconds}`;
    if (this.historySubscriptions.has(key)) return false;
    this.historySubscriptions.add(key);
    if (!this.symbolSubscriptions.has(pocketSymbol)) {
      this.symbolSubscriptions.add(pocketSymbol);
      this.socket.emit("subscribeSymbol", pocketSymbol);
    }
    this.socket.emit("changeSymbol", { asset: pocketSymbol, period: periodSeconds });
    return true;
  }

  unsubscribe(pocketSymbol: string): boolean {
    if (!this.symbolSubscriptions.has(pocketSymbol)) return false;
    this.symbolSubscriptions.delete(pocketSymbol);
    for (const key of [...this.historySubscriptions]) {
      if (key.startsWith(`${pocketSymbol}:`)) this.historySubscriptions.delete(key);
    }
    if (this.socket.connected) this.socket.emit("unsubscribeSymbol", pocketSymbol);
    return true;
  }

  isConnected(): boolean {
    return this.socket.connected;
  }

  private authenticatedSubscriptionKey(pocketSymbol: string, periodSeconds: number): boolean {
    return Boolean(this.auth && /^[A-Z]{6}(?:_otc)?$/i.test(pocketSymbol) && [30, 60].includes(periodSeconds));
  }
}
