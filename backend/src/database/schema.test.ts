import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL("../../../supabase/migrations/20260718110000_initial_market_pulse_schema.sql", import.meta.url),
  "utf8"
);

const protectedTables = [
  "telegram_users",
  "assets",
  "algorithm_versions",
  "candles",
  "ticks",
  "predictions",
  "prediction_features",
  "prediction_tick_samples",
  "learning_records",
  "diagnostic_events"
];

describe("initial Supabase migration", () => {
  it("виконується у чистому PostgreSQL та вмикає RLS", async () => {
    const database = new PGlite({ extensions: { pgcrypto } });

    try {
      await database.exec(`
        create schema if not exists extensions;
        create role anon nologin;
        create role authenticated nologin;
        create role service_role nologin;
      `);
      await database.exec(migration);

      const result = await database.query<{ table_name: string; rls_enabled: boolean }>(`
        select c.relname as table_name, c.relrowsecurity as rls_enabled
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind = 'r'
      `);
      const protectedRows = result.rows.filter((row) => protectedTables.includes(row.table_name));

      expect(protectedRows).toHaveLength(protectedTables.length);
      expect(protectedRows.every((row) => row.rls_enabled)).toBe(true);
    } finally {
      await database.close();
    }
  }, 30_000);

  it.each(protectedTables)("створює та захищає RLS таблицю %s", (table) => {
    expect(migration).toContain(`create table public.${table}`);
    expect(migration).toContain(`alter table public.${table} enable row level security`);
  });

  it("не надає anon або authenticated доступ до таблиць", () => {
    expect(migration).toContain("revoke all on all tables in schema public from anon, authenticated");
    expect(migration).not.toMatch(/create policy/i);
  });

  it("відокремлює OTC, INVALID і CANCELLED у типах даних", () => {
    expect(migration).toContain("market_type as enum ('regular', 'otc')");
    expect(migration).toContain("prediction_result as enum ('win', 'loss', 'draw', 'invalid', 'cancelled')");
  });

  it("не включає INVALID, CANCELLED або DRAW у знаменник win rate", () => {
    expect(migration).toContain("result in ('win', 'loss')");
  });
});
