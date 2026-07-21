# Supabase schema

Схема змінюється лише через файли у `migrations/`. Не редагуйте production-схему вручну в Dashboard після підключення migration workflow.

## Застосування

Після встановлення Supabase CLI:

```powershell
supabase login
supabase link
supabase db push
```

Для локального Supabase:

```powershell
supabase start
supabase db reset
```

Початкова схема навмисно не має політик для `anon` або `authenticated`. Усі запити застосунку йдуть через Render API з server-only secret key після перевірки Telegram `initData`.

Порядок міграцій для чинного середовища:

1. `20260718110000_initial_market_pulse_schema.sql`
2. `20260718170000_currency_asset_catalog.sql`
3. `20260718180000_candle_tick_integrity.sql`
4. `20260718190000_pocket_collector_runtime.sql`
5. `20260721100000_compact_market_data.sql`

Остання міграція обов’язкова перед повторним увімкненням Pocket collector. Вона вимикає
старий high-volume RPC для сирих тиків і дозволяє лише компактний запис завершених свічок.
