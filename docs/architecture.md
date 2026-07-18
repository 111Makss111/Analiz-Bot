# Архітектурні межі

## Джерело істини

Pocket є єдиним джерелом офіційної ціни входу, ціни експірації, часу, активів, виплат, тиків і свічок. Зовнішні ринки ніколи не визначають результат прогнозу.

## Frontend (Vercel)

Frontend показує інтерфейс і звертається тільки до Render API. Йому дозволена лише публічна змінна `VITE_API_BASE_URL`. Telegram Bot Token, Pocket auth packet, Supabase service role key і cron secret тут заборонені.

## Backend (Render)

Backend володіє перевіркою Telegram initData, Pocket-з'єднанням, аналізом, серверними таймерами, результатами та доступом до Supabase. Після Етапу 2 доступні базові health/wake endpoints та захищена перевірка Telegram-сесії.

## Telegram trust boundary

Frontend передає сирий `Telegram.WebApp.initData`, але не приймає рішення про справжність користувача. Backend перевіряє HMAC-SHA-256 із Bot Token, `auth_date`, відсутність дубльованих параметрів та структуру користувача. `initDataUnsafe` не є джерелом ідентичності.

## Майбутні модулі backend

- `telegram` — перевірка initData і Bot API;
- `pocket` — read-only сесія, каталог, виплати, історія й тики;
- `analysis` — окремі детерміновані моделі regular/OTC;
- `trades` — фіксація входу, експірація й результат;
- `statistics` — серверні агрегації;
- `learning` — тіньова пам'ять без самовільної зміни активної моделі.

Залежності між цими модулями додаватимуться лише на відповідних етапах.
