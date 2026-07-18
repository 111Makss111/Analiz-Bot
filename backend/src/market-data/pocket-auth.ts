export type PocketDemoAuth = {
  session: string;
  isDemo: 1;
  uid: number;
  platform: number;
  isFastHistory: true;
  isOptimized: true;
};

export class PocketAuthPacketError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PocketAuthPacketError";
  }
}

export function parsePocketDemoAuthPacket(raw: string): PocketDemoAuth {
  const text = raw.trim();
  if (!text) throw new PocketAuthPacketError("POCKET_AUTH_PACKET не налаштований");
  if (text.length > 16_384) throw new PocketAuthPacketError("POCKET_AUTH_PACKET має некоректний розмір");

  let decoded: unknown;
  try {
    decoded = JSON.parse(text.startsWith("42") ? text.slice(2) : text);
  } catch {
    throw new PocketAuthPacketError("POCKET_AUTH_PACKET не є коректним JSON-пакетом");
  }

  const event = Array.isArray(decoded) ? decoded[0] : "auth";
  const payload = (Array.isArray(decoded) ? decoded[1] : decoded) as Record<string, unknown> | null;
  const session = typeof payload?.session === "string" ? payload.session.trim() : "";
  const uid = Number(payload?.uid);
  const isDemo = Number(payload?.isDemo);
  const platform = Number(payload?.platform ?? 2);

  if (event !== "auth" || !session || session.length > 8_192 || !Number.isSafeInteger(uid) || uid < 1) {
    throw new PocketAuthPacketError("POCKET_AUTH_PACKET має неправильний формат");
  }
  if (isDemo !== 1) {
    throw new PocketAuthPacketError("Колектор приймає лише Pocket Demo-сесію (isDemo=1)");
  }

  return {
    session,
    isDemo: 1,
    uid,
    platform: Number.isInteger(platform) && platform > 0 ? platform : 2,
    isFastHistory: true,
    isOptimized: true
  };
}
