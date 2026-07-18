import type { MarketType, TimeframeSeconds } from "./types.js";

const MIN_TIMESTAMP_MS = Date.UTC(2020, 0, 1);
const MAX_TIMESTAMP_MS = Date.UTC(2100, 0, 1);

export type PocketProtocolTick = {
  pocketSymbol: string;
  price: number;
  pocketTimeMs: number;
  sequence: string | null;
};

export type PocketProtocolCandle = {
  pocketSymbol: string;
  timeframeSeconds: TimeframeSeconds;
  openTimeMs: number;
  open: number;
  high: number;
  low: number;
  close: number;
};

export type PocketLiveAsset = {
  pocketSymbol: string;
  displayName: string;
  baseCurrency: string;
  quoteCurrency: string;
  marketType: MarketType;
  payoutPercent: number | null;
  isAvailable: boolean;
};

export type PocketHistory = {
  pocketSymbol: string;
  periodSeconds: number;
  ticks: PocketProtocolTick[];
  candles: PocketProtocolCandle[];
  rejected: number;
};

function finiteNumber(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function normalizePocketTimestamp(value: unknown): number | null {
  const parsed = finiteNumber(value);
  if (parsed === null || parsed <= 0) return null;
  const milliseconds = parsed < 10_000_000_000 ? Math.round(parsed * 1_000) : Math.round(parsed);
  return milliseconds >= MIN_TIMESTAMP_MS && milliseconds <= MAX_TIMESTAMP_MS ? milliseconds : null;
}

export function decodePocketPayload(payload: unknown): unknown {
  let bytes: Uint8Array | null = null;
  if (payload instanceof ArrayBuffer) bytes = new Uint8Array(payload);
  else if (ArrayBuffer.isView(payload)) {
    bytes = new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength);
  }
  if (!bytes) return payload;

  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}

function decodeJson(payload: unknown): unknown {
  const decoded = decodePocketPayload(payload);
  if (typeof decoded !== "string") return decoded;
  try {
    return JSON.parse(decoded);
  } catch {
    return null;
  }
}

function validPocketSymbol(value: unknown): string | null {
  const symbol = typeof value === "string" ? value.trim() : "";
  return /^[A-Z]{6}(?:_otc)?$/i.test(symbol) ? symbol : null;
}

export function describePocketSymbol(value: unknown): Omit<PocketLiveAsset, "payoutPercent" | "isAvailable"> | null {
  const pocketSymbol = validPocketSymbol(value);
  if (!pocketSymbol) return null;
  const match = /^([A-Z]{3})([A-Z]{3})(_otc)?$/i.exec(pocketSymbol);
  if (!match) return null;
  const baseCurrency = match[1]!.toUpperCase();
  const quoteCurrency = match[2]!.toUpperCase();
  const marketType: MarketType = match[3] ? "otc" : "regular";
  return {
    pocketSymbol,
    displayName: `${baseCurrency}/${quoteCurrency}${marketType === "otc" ? " OTC" : ""}`,
    baseCurrency,
    quoteCurrency,
    marketType
  };
}

function parseTick(value: unknown): PocketProtocolTick | null {
  if (Array.isArray(value) && value.length >= 3 && typeof value[0] === "string") {
    return parseTick({ asset: value[0], timestamp: value[1], price: value[2], sequence: value[3] });
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;

  const item = value as Record<string, unknown>;
  const pocketSymbol = validPocketSymbol(item.pocketSymbol ?? item.asset ?? item.symbol);
  const pocketTimeMs = normalizePocketTimestamp(item.timestamp ?? item.time);
  const price = finiteNumber(item.value ?? item.price ?? item.close);
  const rawSequence = item.sequence ?? item.id ?? null;
  if (!pocketSymbol || !pocketTimeMs || price === null || price <= 0) return null;

  return {
    pocketSymbol,
    pocketTimeMs,
    price,
    sequence:
      typeof rawSequence === "string" || typeof rawSequence === "number"
        ? String(rawSequence).slice(0, 120)
        : null
  };
}

export function parsePocketStream(payload: unknown): PocketProtocolTick[] {
  const decoded = decodeJson(payload);
  if (Array.isArray(decoded)) {
    const direct = parseTick(decoded);
    return direct ? [direct] : decoded.flatMap((item) => parsePocketStream(item));
  }
  const tick = parseTick(decoded);
  return tick ? [tick] : [];
}

export function parsePocketAssets(payload: unknown): PocketLiveAsset[] {
  const decoded = decodeJson(payload);
  if (!Array.isArray(decoded)) return [];

  const assets = new Map<string, PocketLiveAsset>();
  for (const raw of decoded) {
    const symbol = Array.isArray(raw) ? raw[1] : (raw as Record<string, unknown> | null)?.symbol;
    const description = describePocketSymbol(symbol);
    if (!description) continue;
    const payout = finiteNumber(
      Array.isArray(raw) ? raw[5] : (raw as Record<string, unknown>).payout
    );
    const rawAvailability = Array.isArray(raw)
      ? raw[14]
      : ((raw as Record<string, unknown>).is_active ??
        (raw as Record<string, unknown>).isActive ??
        (raw as Record<string, unknown>).active);
    const payoutPercent = payout !== null && payout >= 0 && payout <= 100 ? payout : null;

    assets.set(description.pocketSymbol, {
      ...description,
      payoutPercent,
      isAvailable: rawAvailability === undefined ? payoutPercent !== null : Boolean(rawAvailability)
    });
  }
  return [...assets.values()];
}

function validOhlc(open: number | null, high: number | null, low: number | null, close: number | null) {
  return (
    open !== null &&
    high !== null &&
    low !== null &&
    close !== null &&
    low > 0 &&
    high >= low &&
    open >= low &&
    open <= high &&
    close >= low &&
    close <= high
  );
}

function parseHistoryEntry(
  entry: unknown,
  pocketSymbol: string,
  periodSeconds: number
): { tick?: PocketProtocolTick; candle?: PocketProtocolCandle } | null {
  if (Array.isArray(entry) && entry.length === 2) {
    const firstTime = normalizePocketTimestamp(entry[0]);
    const secondTime = normalizePocketTimestamp(entry[1]);
    const pocketTimeMs = firstTime ?? secondTime;
    const price = finiteNumber(firstTime ? entry[1] : entry[0]);
    return pocketTimeMs && price !== null && price > 0
      ? { tick: { pocketSymbol, pocketTimeMs, price, sequence: null } }
      : null;
  }

  const value = entry as Record<string, unknown> | null;
  const timestamp = normalizePocketTimestamp(Array.isArray(entry) ? entry[0] : value?.timestamp ?? value?.time);
  if (!timestamp) return null;

  const conventional: [number | null, number | null, number | null, number | null] = Array.isArray(entry)
    ? [finiteNumber(entry[1]), finiteNumber(entry[2]), finiteNumber(entry[3]), finiteNumber(entry[4])]
    : [finiteNumber(value?.open), finiteNumber(value?.high), finiteNumber(value?.low), finiteNumber(value?.close)];
  let [open, high, low, close] = conventional;
  if (!validOhlc(open, high, low, close) && Array.isArray(entry)) {
    [open, close, high, low] = conventional;
  }

  if (validOhlc(open, high, low, close) && [30, 60, 300].includes(periodSeconds)) {
    return {
      candle: {
        pocketSymbol,
        timeframeSeconds: periodSeconds as TimeframeSeconds,
        openTimeMs: Math.floor(timestamp / (periodSeconds * 1_000)) * periodSeconds * 1_000,
        open: open!,
        high: high!,
        low: low!,
        close: close!
      }
    };
  }

  if (!Array.isArray(entry)) {
    const price = finiteNumber(value?.value ?? value?.price ?? value?.close);
    if (price !== null && price > 0) {
      return { tick: { pocketSymbol, pocketTimeMs: timestamp, price, sequence: null } };
    }
  }
  return null;
}

export function parsePocketHistory(payload: unknown): PocketHistory | null {
  const decoded = decodeJson(payload) as Record<string, unknown> | null;
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) return null;
  const pocketSymbol = validPocketSymbol(decoded.asset ?? decoded.symbol);
  const periodSeconds = Number(decoded.period);
  const history = Array.isArray(decoded.history) ? decoded.history : [];
  if (!pocketSymbol || !Number.isInteger(periodSeconds) || periodSeconds < 1 || history.length === 0) {
    return null;
  }

  const ticks: PocketProtocolTick[] = [];
  const candles: PocketProtocolCandle[] = [];
  let rejected = 0;
  for (const entry of history) {
    const parsed = parseHistoryEntry(entry, pocketSymbol, periodSeconds);
    if (parsed?.tick) ticks.push(parsed.tick);
    else if (parsed?.candle) candles.push(parsed.candle);
    else rejected += 1;
  }
  return { pocketSymbol, periodSeconds, ticks, candles, rejected };
}
