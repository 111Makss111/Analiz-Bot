import { createHash } from "node:crypto";

export type AppConfig = {
  nodeEnv: "development" | "test" | "production";
  host: string;
  port: number;
  frontendOrigin: string;
  telegramBotToken: string;
  telegramWebhookSecret: string;
  telegramMiniAppUrl: string;
  backendPublicUrl: string;
  telegramInitDataTtlSeconds: number;
  supabaseUrl: string;
  supabaseSecretKey: string;
  diagnosticsSecret: string;
  pocketCollectorEnabled: boolean;
  pocketAuthPacket: string;
  pocketDemoEndpoint: string;
  pocketMaxAssets: number;
  pocketStaleAfterMs: number;
};

const POCKET_DEMO_ENDPOINTS = {
  EU: "wss://demo-api-eu.po.market",
  EU_ALT: "wss://try-demo-eu.po.market"
} as const;

function readPort(value: string | undefined): number {
  const port = Number(value ?? "3000");

  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("PORT має бути цілим числом від 1 до 65535");
  }

  return port;
}

function readPositiveInteger(value: string | undefined, fallback: number, name: string): number {
  const parsed = Number(value ?? fallback);

  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${name} має бути додатним цілим числом`);
  }

  return parsed;
}

function readBoundedPositiveInteger(
  value: string | undefined,
  fallback: number,
  maximum: number,
  name: string
): number {
  const parsed = readPositiveInteger(value, fallback, name);
  if (parsed > maximum) throw new Error(`${name} має бути не більше ${maximum}`);
  return parsed;
}

function readBoolean(value: string | undefined, fallback: boolean, name: string): boolean {
  if (value === undefined || value === "") return fallback;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${name} має бути true або false`);
}

function readPocketEndpoint(region: string | undefined): string {
  const selected = (region ?? "EU") as keyof typeof POCKET_DEMO_ENDPOINTS;
  const endpoint = POCKET_DEMO_ENDPOINTS[selected];
  if (!endpoint) throw new Error("POCKET_DEMO_REGION має бути EU або EU_ALT");
  return endpoint;
}

function readFrontendOrigin(value: string | undefined, nodeEnv: AppConfig["nodeEnv"]): string {
  const origin = value ?? "http://localhost:5173";
  let url: URL;

  try {
    url = new URL(origin);
  } catch {
    throw new Error("FRONTEND_ORIGIN має бути коректним URL");
  }

  if (url.origin !== origin) {
    throw new Error("FRONTEND_ORIGIN має містити лише origin без шляху або кінцевого слеша");
  }

  if (nodeEnv === "production" && url.protocol !== "https:") {
    throw new Error("У production FRONTEND_ORIGIN повинен використовувати HTTPS");
  }

  return origin;
}

function readSupabaseConfig(
  env: NodeJS.ProcessEnv,
  nodeEnv: AppConfig["nodeEnv"]
): Pick<AppConfig, "supabaseUrl" | "supabaseSecretKey"> {
  const supabaseUrl = env.SUPABASE_URL ?? "";
  const supabaseSecretKey = env.SUPABASE_SECRET_KEY ?? "";

  if ((supabaseUrl.length === 0) !== (supabaseSecretKey.length === 0)) {
    throw new Error("SUPABASE_URL і SUPABASE_SECRET_KEY потрібно задавати разом");
  }

  if (nodeEnv === "production" && supabaseUrl.length === 0) {
    throw new Error("Supabase configuration обов'язкова у production");
  }

  if (supabaseUrl.length > 0) {
    let url: URL;
    try {
      url = new URL(supabaseUrl);
    } catch {
      throw new Error("SUPABASE_URL має бути коректним URL");
    }
    if (url.protocol !== "https:" || url.origin !== supabaseUrl) {
      throw new Error("SUPABASE_URL має бути HTTPS origin без шляху");
    }
  }

  return { supabaseUrl, supabaseSecretKey };
}

function readHttpsOrigin(value: string, name: string, required: boolean): string {
  if (!value) {
    if (required) throw new Error(`${name} обов'язковий у production`);
    return "";
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} має бути коректним URL`);
  }

  if (url.protocol !== "https:" || url.origin !== value) {
    throw new Error(`${name} має бути HTTPS origin без шляху або кінцевого слеша`);
  }

  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const nodeEnv = env.NODE_ENV ?? "development";

  if (!["development", "test", "production"].includes(nodeEnv)) {
    throw new Error("NODE_ENV має бути development, test або production");
  }

  const validatedNodeEnv = nodeEnv as AppConfig["nodeEnv"];
  const telegramBotToken = env.TELEGRAM_BOT_TOKEN ?? "";
  const providedWebhookSecret = env.TELEGRAM_WEBHOOK_SECRET ?? "";
  const supabase = readSupabaseConfig(env, validatedNodeEnv);

  if (validatedNodeEnv === "production" && telegramBotToken.length === 0) {
    throw new Error("TELEGRAM_BOT_TOKEN обов'язковий у production");
  }

  if (
    providedWebhookSecret.length > 0 &&
    (!/^[A-Za-z0-9_-]+$/.test(providedWebhookSecret) || providedWebhookSecret.length > 256)
  ) {
    throw new Error("TELEGRAM_WEBHOOK_SECRET містить недозволені символи або завеликий");
  }

  if (validatedNodeEnv === "production" && providedWebhookSecret.length > 0 && providedWebhookSecret.length < 32) {
    throw new Error("TELEGRAM_WEBHOOK_SECRET повинен містити щонайменше 32 символи у production");
  }

  const telegramWebhookSecret =
    providedWebhookSecret ||
    (validatedNodeEnv === "production" && telegramBotToken
      ? createHash("sha256").update(`market-pulse-webhook:${telegramBotToken}`).digest("hex")
      : "");
  const diagnosticsSecret = env.DIAGNOSTICS_SECRET?.trim() || telegramWebhookSecret;

  if (
    validatedNodeEnv === "production" &&
    diagnosticsSecret.length > 0 &&
    diagnosticsSecret.length < 32
  ) {
    throw new Error("DIAGNOSTICS_SECRET повинен містити щонайменше 32 символи у production");
  }

  const frontendOrigin = readFrontendOrigin(env.FRONTEND_ORIGIN, validatedNodeEnv);
  const backendPublicUrl = readHttpsOrigin(
    env.RENDER_EXTERNAL_URL ?? env.BACKEND_PUBLIC_URL ?? "",
    "BACKEND_PUBLIC_URL",
    validatedNodeEnv === "production"
  );

  return {
    nodeEnv: validatedNodeEnv,
    host: env.HOST ?? "0.0.0.0",
    port: readPort(env.PORT),
    frontendOrigin,
    telegramBotToken,
    telegramWebhookSecret,
    telegramMiniAppUrl: readHttpsOrigin(
      env.TELEGRAM_MINI_APP_URL ?? (validatedNodeEnv === "production" ? frontendOrigin : ""),
      "TELEGRAM_MINI_APP_URL",
      validatedNodeEnv === "production"
    ),
    backendPublicUrl,
    telegramInitDataTtlSeconds: readPositiveInteger(
      env.TELEGRAM_INIT_DATA_TTL_SECONDS,
      86_400,
      "TELEGRAM_INIT_DATA_TTL_SECONDS"
    ),
    diagnosticsSecret,
    pocketCollectorEnabled: readBoolean(
      env.POCKET_COLLECTOR_ENABLED,
      true,
      "POCKET_COLLECTOR_ENABLED"
    ),
    pocketAuthPacket: env.POCKET_AUTH_PACKET?.trim() ?? "",
    pocketDemoEndpoint: readPocketEndpoint(env.POCKET_DEMO_REGION),
    pocketMaxAssets: readBoundedPositiveInteger(
      env.POCKET_MAX_ACTIVE_ASSETS,
      3,
      5,
      "POCKET_MAX_ACTIVE_ASSETS"
    ),
    pocketStaleAfterMs: readPositiveInteger(
      env.POCKET_STALE_AFTER_MS,
      15_000,
      "POCKET_STALE_AFTER_MS"
    ),
    ...supabase
  };
}
