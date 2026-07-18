import { createHmac, timingSafeEqual } from "node:crypto";

const HASH_PATTERN = /^[a-f\d]{64}$/i;
const MAX_INIT_DATA_LENGTH = 16_384;
const ALLOWED_FUTURE_CLOCK_SKEW_SECONDS = 30;

function compareKeys([left]: [string, string], [right]: [string, string]): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

export type TelegramUser = {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
  language_code?: string;
  is_premium?: boolean;
  photo_url?: string;
};

export type VerifiedTelegramInitData = {
  authDate: Date;
  queryId?: string;
  user: TelegramUser;
};

export type TelegramInitDataErrorCode =
  | "MISSING_INIT_DATA"
  | "INIT_DATA_TOO_LARGE"
  | "MALFORMED_INIT_DATA"
  | "INVALID_SIGNATURE"
  | "EXPIRED_INIT_DATA"
  | "INVALID_USER";

export class TelegramInitDataError extends Error {
  constructor(public readonly code: TelegramInitDataErrorCode, message: string) {
    super(message);
    this.name = "TelegramInitDataError";
  }
}

type VerifyOptions = {
  botToken: string;
  maxAgeSeconds: number;
  now?: Date;
};

function parseUniqueParams(rawInitData: string): Map<string, string> {
  if (rawInitData.length === 0) {
    throw new TelegramInitDataError("MISSING_INIT_DATA", "Telegram initData відсутній");
  }

  if (rawInitData.length > MAX_INIT_DATA_LENGTH) {
    throw new TelegramInitDataError("INIT_DATA_TOO_LARGE", "Telegram initData завеликий");
  }

  const params = new URLSearchParams(rawInitData);
  const unique = new Map<string, string>();

  for (const [key, value] of params) {
    if (key.length === 0 || unique.has(key)) {
      throw new TelegramInitDataError("MALFORMED_INIT_DATA", "Telegram initData пошкоджений");
    }
    unique.set(key, value);
  }

  return unique;
}

function verifySignature(params: Map<string, string>, botToken: string): void {
  const receivedHash = params.get("hash") ?? "";

  if (!HASH_PATTERN.test(receivedHash) || botToken.length === 0) {
    throw new TelegramInitDataError("INVALID_SIGNATURE", "Не вдалося підтвердити Telegram-сесію");
  }

  const dataCheckString = [...params.entries()]
    .filter(([key]) => key !== "hash")
    .sort(compareKeys)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");

  const secretKey = createHmac("sha256", "WebAppData").update(botToken).digest();
  const expectedHash = createHmac("sha256", secretKey).update(dataCheckString).digest();
  const receivedHashBuffer = Buffer.from(receivedHash, "hex");

  if (!timingSafeEqual(expectedHash, receivedHashBuffer)) {
    throw new TelegramInitDataError("INVALID_SIGNATURE", "Не вдалося підтвердити Telegram-сесію");
  }
}

function verifyAuthDate(params: Map<string, string>, now: Date, maxAgeSeconds: number): Date {
  const authDateSeconds = Number(params.get("auth_date"));

  if (!Number.isSafeInteger(authDateSeconds) || authDateSeconds <= 0) {
    throw new TelegramInitDataError("MALFORMED_INIT_DATA", "Telegram initData не містить коректного часу");
  }

  const ageSeconds = Math.floor(now.getTime() / 1000) - authDateSeconds;
  if (ageSeconds > maxAgeSeconds || ageSeconds < -ALLOWED_FUTURE_CLOCK_SKEW_SECONDS) {
    throw new TelegramInitDataError("EXPIRED_INIT_DATA", "Telegram-сесія застаріла, відкрийте Mini App знову");
  }

  return new Date(authDateSeconds * 1000);
}

function parseUser(rawUser: string | undefined): TelegramUser {
  if (!rawUser) {
    throw new TelegramInitDataError("INVALID_USER", "Telegram initData не містить користувача");
  }

  let candidate: unknown;
  try {
    candidate = JSON.parse(rawUser);
  } catch {
    throw new TelegramInitDataError("INVALID_USER", "Дані користувача Telegram пошкоджені");
  }

  if (
    typeof candidate !== "object" ||
    candidate === null ||
    !("id" in candidate) ||
    typeof candidate.id !== "number" ||
    !Number.isSafeInteger(candidate.id) ||
    !("first_name" in candidate) ||
    typeof candidate.first_name !== "string" ||
    candidate.first_name.length === 0
  ) {
    throw new TelegramInitDataError("INVALID_USER", "Дані користувача Telegram некоректні");
  }

  return candidate as TelegramUser;
}

export function verifyTelegramInitData(
  rawInitData: string,
  { botToken, maxAgeSeconds, now = new Date() }: VerifyOptions
): VerifiedTelegramInitData {
  const params = parseUniqueParams(rawInitData);
  verifySignature(params, botToken);
  const authDate = verifyAuthDate(params, now, maxAgeSeconds);
  const user = parseUser(params.get("user"));

  return {
    authDate,
    ...(params.has("query_id") ? { queryId: params.get("query_id")! } : {}),
    user
  };
}
