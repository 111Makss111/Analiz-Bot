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
  timestamp: string;
};

const apiBaseUrl = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:3000";

export async function checkHealth(signal: AbortSignal): Promise<HealthResponse> {
  const response = await fetch(`${apiBaseUrl}/api/health`, { signal });
  if (!response.ok) throw new Error("Backend unavailable");
  return (await response.json()) as HealthResponse;
}

export async function verifySession(initData: string, signal: AbortSignal): Promise<SessionResponse> {
  const response = await fetch(`${apiBaseUrl}/api/auth/session`, {
    headers: { "X-Telegram-Init-Data": initData },
    signal
  });

  if (!response.ok) throw new Error("Telegram session rejected");
  return (await response.json()) as SessionResponse;
}
