import { readdirSync, readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { describe, expect, it } from "vitest";

const migrationsDirectory = new URL("../../../supabase/migrations/", import.meta.url);
const migrationFiles = readdirSync(migrationsDirectory)
  .filter((file) => file.endsWith(".sql"))
  .sort();
const migrations = migrationFiles.map((file) =>
  readFileSync(new URL(file, migrationsDirectory), "utf8")
);
const migration = migrations.join("\n");

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
      for (const sql of migrations) await database.exec(sql);

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

  it("атомарно записує Pocket tick, M1 candle і останню котировку без дублів", async () => {
    const database = new PGlite({ extensions: { pgcrypto } });
    const assetId = "123e4567-e89b-42d3-a456-426614174000";
    const ticks = JSON.stringify([
      {
        asset_id: assetId,
        pocket_time: "2026-07-18T12:00:10.000Z",
        received_at: "2026-07-18T12:00:10.080Z",
        price: 1.1,
        pocket_sequence: "tick-1"
      }
    ]);
    const candles = JSON.stringify([
      {
        asset_id: assetId,
        timeframe_seconds: 60,
        open_time: "2026-07-18T12:00:00.000Z",
        close_time: "2026-07-18T12:01:00.000Z",
        last_tick_at: "2026-07-18T12:00:10.000Z",
        open: 1.1,
        high: 1.1,
        low: 1.1,
        close: 1.1,
        tick_count: 1,
        is_complete: false
      }
    ]);
    const quotes = JSON.stringify([
      {
        asset_id: assetId,
        pocket_time: "2026-07-18T12:00:10.000Z",
        received_at: "2026-07-18T12:00:10.080Z",
        price: 1.1
      }
    ]);

    try {
      await database.exec(`
        create schema if not exists extensions;
        create role anon nologin;
        create role authenticated nologin;
        create role service_role nologin;
      `);
      for (const sql of migrations) await database.exec(sql);
      await database.exec(`
        insert into public.assets (
          id, pocket_symbol, display_name, market_type, base_currency, quote_currency
        ) values (
          '${assetId}', 'EUR/USD', 'EUR/USD', 'regular', 'EUR', 'USD'
        );
        select public.ingest_pocket_market_data(
          '${ticks}'::jsonb,
          '${candles}'::jsonb,
          '${quotes}'::jsonb
        );
        select public.ingest_pocket_market_data(
          '${ticks}'::jsonb,
          '${candles}'::jsonb,
          '${quotes}'::jsonb
        );
      `);

      const tickCount = await database.query<{ count: bigint }>("select count(*) from public.ticks");
      const candleCount = await database.query<{ count: bigint }>("select count(*) from public.candles");
      const asset = await database.query<{ last_quote: string; data_state: string }>(
        `select last_quote, data_state from public.assets where id = '${assetId}'`
      );

      expect(Number(tickCount.rows[0]?.count)).toBe(1);
      expect(Number(candleCount.rows[0]?.count)).toBe(1);
      expect(Number(asset.rows[0]?.last_quote)).toBe(1.1);
      expect(asset.rows[0]?.data_state).toBe("ready");
    } finally {
      await database.close();
    }
  }, 30_000);

  it("відокремлює OTC, INVALID і CANCELLED у типах даних", () => {
    expect(migration).toContain("market_type as enum ('regular', 'otc')");
    expect(migration).toContain("prediction_result as enum ('win', 'loss', 'draw', 'invalid', 'cancelled')");
  });

  it("не включає INVALID, CANCELLED або DRAW у знаменник win rate", () => {
    expect(migration).toContain("result in ('win', 'loss')");
  });

  it("додає атомарний кеш валютного каталогу без доступу клієнтських ролей", () => {
    expect(migration).toContain("create function public.replace_currency_asset_catalog");
    expect(migration).toContain("asset_category = 'currency'");
    expect(migration).toContain("from public, anon, authenticated");
  });

  it("додає атомарний server-only запис Pocket ticks і candles", () => {
    expect(migration).toContain("create function public.ingest_pocket_market_data");
    expect(migration).toContain("ticks_deduplicate_identical_samples");
    expect(migration).toContain("tick_count");
    expect(migration).toContain("Number of accepted Pocket ticks");
  });

  it("зберігає live Pocket symbol, payout і доступність атомарно", async () => {
    const database = new PGlite({ extensions: { pgcrypto } });
    try {
      await database.exec(`
        create schema if not exists extensions;
        create role anon nologin;
        create role authenticated nologin;
        create role service_role nologin;
      `);
      for (const sql of migrations) await database.exec(sql);
      await database.exec(`
        select public.apply_pocket_live_asset_catalog(
          '[{
            "pocket_symbol":"AUDCAD_otc",
            "display_name":"AUD/CAD OTC",
            "base_currency":"AUD",
            "quote_currency":"CAD",
            "market_type":"otc",
            "payout_percent":92,
            "is_available":true
          }]'::jsonb,
          '2026-07-18T17:00:00Z'::timestamptz
        );
      `);
      const result = await database.query<{
        pocket_symbol: string;
        display_name: string;
        payout_percent: string;
        is_available: boolean;
      }>(`
        select pocket_symbol, display_name, payout_percent, is_available
        from public.assets where pocket_symbol = 'AUDCAD_otc'
      `);

      expect(result.rows[0]).toMatchObject({
        pocket_symbol: "AUDCAD_otc",
        display_name: "AUD/CAD OTC",
        is_available: true
      });
      expect(Number(result.rows[0]?.payout_percent)).toBe(92);
    } finally {
      await database.close();
    }
  }, 30_000);

  it("мігрує старий display-key у WebSocket symbol без зміни asset UUID", async () => {
    const database = new PGlite({ extensions: { pgcrypto } });
    const assetId = "123e4567-e89b-42d3-a456-426614174000";
    try {
      await database.exec(`
        create schema if not exists extensions;
        create role anon nologin;
        create role authenticated nologin;
        create role service_role nologin;
      `);
      for (const sql of migrations.slice(0, -1)) await database.exec(sql);
      await database.exec(`
        insert into public.assets (
          id, pocket_symbol, display_name, market_type, base_currency, quote_currency
        ) values (
          '${assetId}', 'AUD/CAD OTC', 'AUD/CAD OTC', 'otc', 'AUD', 'CAD'
        );
      `);
      await database.exec(migrations.at(-1)!);
      await database.exec(`
        select public.replace_currency_asset_catalog(
          '[{
            "pocket_symbol":"AUD/CAD OTC",
            "display_name":"AUD/CAD OTC",
            "base_currency":"AUD",
            "quote_currency":"CAD",
            "market_type":"otc",
            "payout_percent":90,
            "catalog_payload":{}
          }]'::jsonb,
          'pocket-official-assets-page',
          '2026-07-18T17:10:00Z'::timestamptz
        );
      `);
      const result = await database.query<{ id: string; pocket_symbol: string }>(`
        select id, pocket_symbol from public.assets where id = '${assetId}'
      `);
      const count = await database.query<{ count: bigint }>(`
        select count(*) from public.assets where display_name = 'AUD/CAD OTC'
      `);

      expect(result.rows[0]).toEqual({ id: assetId, pocket_symbol: "AUDCAD_otc" });
      expect(Number(count.rows[0]?.count)).toBe(1);
    } finally {
      await database.close();
    }
  }, 30_000);
});
