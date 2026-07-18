export type AppConfig = {
  nodeEnv: "development" | "test" | "production";
  host: string;
  port: number;
  frontendOrigin: string;
};

function readPort(value: string | undefined): number {
  const port = Number(value ?? "3000");

  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("PORT має бути цілим числом від 1 до 65535");
  }

  return port;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const nodeEnv = env.NODE_ENV ?? "development";

  if (!["development", "test", "production"].includes(nodeEnv)) {
    throw new Error("NODE_ENV має бути development, test або production");
  }

  return {
    nodeEnv: nodeEnv as AppConfig["nodeEnv"],
    host: env.HOST ?? "0.0.0.0",
    port: readPort(env.PORT),
    frontendOrigin: env.FRONTEND_ORIGIN ?? "http://localhost:5173"
  };
}
