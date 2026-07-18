import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { AppConfig } from "../config.js";

export function createSupabaseAdminClient(config: AppConfig): SupabaseClient | null {
  if (!config.supabaseUrl || !config.supabaseSecretKey) return null;

  return createClient(config.supabaseUrl, config.supabaseSecretKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      detectSessionInUrl: false
    },
    global: {
      headers: { "X-Client-Info": "market-pulse-backend" }
    }
  });
}
