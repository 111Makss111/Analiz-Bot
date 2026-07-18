export type SessionResponse = {
  ok: true;
  user: {
    id: number;
    firstName: string;
    username?: string;
  };
};

const apiBaseUrl = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:3000";

export async function checkHealth(signal: AbortSignal): Promise<void> {
  const response = await fetch(`${apiBaseUrl}/api/health`, { signal });
  if (!response.ok) throw new Error("Backend unavailable");
}

export async function verifySession(initData: string, signal: AbortSignal): Promise<SessionResponse> {
  const response = await fetch(`${apiBaseUrl}/api/auth/session`, {
    headers: { "X-Telegram-Init-Data": initData },
    signal
  });

  if (!response.ok) throw new Error("Telegram session rejected");
  return (await response.json()) as SessionResponse;
}
