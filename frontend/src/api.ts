export type SessionResponse = {
  ok: true;
  user: {
    id: number;
    firstName: string;
    username?: string;
  };
};

export type HealthResponse = {
  ok: true;
  service: string;
  status: "ready";
  database: "configured" | "not_configured";
  telegram: "configured" | "not_configured";
  pocket: "ready" | "warming" | "not_configured" | "error";
  timestamp: string;
};

export type AssetSummary = {
  id: string;
  pocketSymbol: string;
  displayName: string;
  baseCurrency: string | null;
  quoteCurrency: string | null;
  marketType: "regular" | "otc";
  isAvailable: boolean;
  payoutPercent: number | null;
  dataState: "warming" | "ready" | "stale" | "unavailable" | "error";
  lastQuote: number | null;
  lastQuoteAt: string | null;
  quoteAgeMs: number | null;
  catalogUpdatedAt: string | null;
  catalogAgeMs: number | null;
};

export type AssetsResponse = {
  ok: true;
  category: "currency";
  status: "ready" | "warming" | "stale" | "unavailable";
  source: "supabase-cache";
  updatedAt: string | null;
  assets: AssetSummary[];
};

export type AnalysisDirection = "up" | "down";
export type AnalysisStrength = "stronger" | "normal" | "risky" | "very_risky";

export type AnalysisResult = {
  asset: {
    id: string;
    pocketSymbol: string;
    displayName: string;
    marketType: "regular" | "otc";
  };
  direction: AnalysisDirection;
  expirationMinutes: 1 | 2 | 3;
  expirationSeconds: 60 | 120 | 180;
  quote: { price: number; pocketTime: string; ageMs: number };
  payoutPercent: number | null;
  strengthScore: number;
  strength: AnalysisStrength;
  strengthIsProbability: false;
  regime: "trend" | "range" | "breakout" | "reversal" | "impulse" | "exhaustion" | "volatile" | "mixed";
  volatility: "low" | "normal" | "high";
  explanation: string;
  reasons: string[];
  risks: string[];
  algorithmVersion: string;
  createdAt: string;
  durationMs: number;
  data: {
    recentTicks: number;
    candles30s: number;
    candlesM1: number;
    candlesM5: number;
    qualityScore: number;
  };
};

type AnalysisApiResponse =
  | { ok: true; analysis: AnalysisResult }
  | { ok: false; error: { code: string; message: string } };

export class ApiError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "ApiError";
  }
}

const apiBaseUrl = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:3000";

export async function checkHealth(signal: AbortSignal): Promise<HealthResponse> {
  const response = await fetch(`${apiBaseUrl}/api/health`, { signal });
  if (!response.ok) throw new Error("Backend unavailable");
  return (await response.json()) as HealthResponse;
}

export async function fetchAssets(signal: AbortSignal): Promise<AssetsResponse> {
  const response = await fetch(`${apiBaseUrl}/api/assets?market=all`, { signal });
  if (!response.ok) throw new Error("Asset catalog unavailable");
  return (await response.json()) as AssetsResponse;
}

export async function prepareAsset(assetId: string, initData: string): Promise<void> {
  const response = await fetch(`${apiBaseUrl}/api/assets/prepare`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Telegram-Init-Data": initData
    },
    body: JSON.stringify({ assetId })
  });
  if (!response.ok) throw new Error("Pocket asset preparation failed");
}

export async function analyzeAsset(
  assetId: string,
  expirationMinutes: 1 | 2 | 3,
  initData: string
): Promise<AnalysisResult> {
  const response = await fetch(`${apiBaseUrl}/api/analyze`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Telegram-Init-Data": initData
    },
    body: JSON.stringify({ assetId, expirationMinutes })
  });
  const payload = (await response.json().catch(() => null)) as AnalysisApiResponse | null;
  if (!response.ok || !payload?.ok) {
    const error = payload && !payload.ok ? payload.error : null;
    throw new ApiError(error?.code ?? "ANALYSIS_FAILED", error?.message ?? "Аналіз тимчасово недоступний");
  }
  return payload.analysis;
}

export async function verifySession(initData: string, signal: AbortSignal): Promise<SessionResponse> {
  const response = await fetch(`${apiBaseUrl}/api/auth/session`, {
    headers: { "X-Telegram-Init-Data": initData },
    signal
  });

  if (!response.ok) throw new Error("Telegram session rejected");
  return (await response.json()) as SessionResponse;
}
