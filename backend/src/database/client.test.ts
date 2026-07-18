import { describe, expect, it } from "vitest";
import type { AppConfig } from "../config.js";
import { createSupabaseAdminClient } from "./client.js";

const baseConfig: AppConfig = {
  nodeEnv: "test",
  host: "127.0.0.1",
  port: 3000,
  frontendOrigin: "http://localhost:5173",
  telegramBotToken: "test-token",
  telegramInitDataTtlSeconds: 86_400,
  supabaseUrl: "",
  supabaseSecretKey: ""
};

describe("createSupabaseAdminClient", () => {
  it("дозволяє локальний запуск без Supabase", () => {
    expect(createSupabaseAdminClient(baseConfig)).toBeNull();
  });

  it("створює окремий server-only client без збереження сесії", () => {
    const client = createSupabaseAdminClient({
      ...baseConfig,
      supabaseUrl: "https://example.supabase.co",
      supabaseSecretKey: "sb_secret_test-only"
    });

    expect(client).not.toBeNull();
    expect(client?.supabaseUrl).toBe("https://example.supabase.co");
  });
});
