# Market Pulse Research

Новий Telegram Mini App для дослідження короткострокових прогнозів Pocket Option на деморахунку.

> Це дослідницький інструмент. Він не гарантує прибутку, не відкриває угоди автоматично й не використовує мартингейл.

## Структура

- `frontend` — мобільний інтерфейс Telegram Mini App для Vercel.
- `backend` — API, серверні таймери та read-only Pocket Demo collector для Render.
- `docs` — архітектурні рішення та поетапний план.

Frontend і backend є окремими застосунками. Секрети ніколи не передаються у frontend.

## Вимоги

- Node.js 24 LTS
- npm 10+

## Перший локальний запуск

```powershell
npm install
Copy-Item backend/.env.example backend/.env
Copy-Item frontend/.env.example frontend/.env
```

Запустіть у двох терміналах:

```powershell
npm run dev:backend
npm run dev:frontend
```

- frontend: `http://localhost:5173`
- backend: `http://localhost:3000`
- health: `http://localhost:3000/api/health`
- wake: `http://localhost:3000/api/wake`
- currency assets: `http://localhost:3000/api/assets?market=all`
- M1 candles: `http://localhost:3000/api/assets/<asset-uuid>/candles?timeframe=60&limit=120`
- prepare selected asset: `POST http://localhost:3000/api/assets/prepare` (потребує справжній `initData`)
- protected diagnostics: `GET http://localhost:3000/api/diagnostics`
- Telegram session: `http://localhost:3000/api/auth/session` (потребує справжній `initData`)

## Перевірки

```powershell
npm run check
npm test
npm run build
```

## Поточний стан

- Етап 1: чиста структура, локальний запуск і базові endpoints.
- Етап 2: Vercel/Render-конфігурація, Telegram Mini App bootstrap, production CORS і перевірка `initData`.
- Етап 3: server-only Supabase client і початкова схема даних у migration workflow.
- Етап 5: кеш валютних пар, виплат і доступності Pocket через server-only API.
- Етап 6: детерміноване ядро Pocket-тиків і 30s/M1/M5 свічок із пакетним записом у Supabase.
- Pocket collector v1: Demo-only Socket.IO, live каталог/тики, історія, контроль свіжості та перепідключення.
- Telegram Bot: захищений webhook, `/start`, `/help` і кнопка запуску Mini App.

Інструкції: [`docs/deployment-stage-2.md`](docs/deployment-stage-2.md), [`docs/supabase-stage-3.md`](docs/supabase-stage-3.md), [`docs/asset-catalog-stage-5.md`](docs/asset-catalog-stage-5.md), [`docs/candle-data-stage-6.md`](docs/candle-data-stage-6.md) та [`docs/pocket-collector-v1.md`](docs/pocket-collector-v1.md).

Живі котировки з’являються лише після server-only налаштування дійсної Pocket Demo-сесії. Дані ніколи не імітуються.
