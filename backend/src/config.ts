export type AppConfig = {
  nodeEnv: "development" | "test" | "production";
  host: string;
  port: number;
  frontendOrigin: string;
  telegramBotToken: string;
  telegramInitDataTtlSeconds: number;
};

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

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const nodeEnv = env.NODE_ENV ?? "development";

  if (!["development", "test", "production"].includes(nodeEnv)) {
    throw new Error("NODE_ENV має бути development, test або production");
  }

  const validatedNodeEnv = nodeEnv as AppConfig["nodeEnv"];
  const telegramBotToken = env.TELEGRAM_BOT_TOKEN ?? "";

  if (validatedNodeEnv === "production" && telegramBotToken.length === 0) {
    throw new Error("TELEGRAM_BOT_TOKEN обов'язковий у production");
  }

  return {
    nodeEnv: validatedNodeEnv,
    host: env.HOST ?? "0.0.0.0",
    port: readPort(env.PORT),
    frontendOrigin: readFrontendOrigin(env.FRONTEND_ORIGIN, validatedNodeEnv),
    telegramBotToken,
    telegramInitDataTtlSeconds: readPositiveInteger(
      env.TELEGRAM_INIT_DATA_TTL_SECONDS,
      86_400,
      "TELEGRAM_INIT_DATA_TTL_SECONDS"
    )
  };
}
