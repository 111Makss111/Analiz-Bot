# Supabase — Етап 3

## Серверні змінні Render

- `SUPABASE_URL=https://<project-ref>.supabase.co`
- `SUPABASE_SECRET_KEY=sb_secret_...`

Рекомендовано використовувати новий secret key. Legacy `service_role` має ті самі підвищені права, але не повинен додаватися у frontend або Vercel за жодних умов.

## Модель доступу

- Frontend не створює Supabase client і не знає жодного ключа.
- Render створює окремий server-only client із вимкненими session persistence, auto refresh і URL session detection.
- Усі таблиці мають RLS.
- Ролі `anon` та `authenticated` не мають політик і прямих прав на таблиці.
- Перевірений Telegram user отримує дані лише через Render endpoints.

## Початкова міграція

`supabase/migrations/20260718110000_initial_market_pulse_schema.sql` створює:

- кеш каталогу активів і поточного payout;
- Pocket-свічки M30/M1/M5 і тики;
- версії алгоритмів окремо для regular та OTC;
- прогнози, entry/final quote, таймінги й результати;
- повні математичні ознаки та тикові знімки;
- діагностичні події;
- тіньові навчальні записи;
- server-only SQL-агрегацію статистики.

`decided_win_rate` рахується тільки як `WIN / (WIN + LOSS)`. DRAW, INVALID і CANCELLED повертаються окремими лічильниками та не спотворюють результат.

## Застосування

Після створення Supabase project:

```powershell
supabase login
supabase link
supabase db push
```

Не створюйте таблиці вручну в production Dashboard. Після `db push` потрібно перевірити migration status, RLS, SQL-функцію статистики та короткий `/api/health` на Render.
