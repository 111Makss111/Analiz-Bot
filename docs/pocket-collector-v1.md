# Pocket Demo read-only collector

Колектор працює всередині Render backend і передає лише дані в напрямку Pocket → Market Pulse. Команд відкриття, закриття або копіювання угод у транспорті немає.

## Потік даних

1. Backend відновлює кеш активів і незавершені 30s/M1/M5 candles із Supabase.
2. `POCKET_AUTH_PACKET` перевіряється локально на Render. Дозволено тільки `isDemo=1`.
3. Socket.IO підключається до вибраного Pocket Demo endpoint і очікує `successauth`.
4. Live `updateAssets` оновлює доступність та виплати, а `updateStream` передає тики у `MarketDataPipeline`.
5. `updateHistoryNewFast`, `updateHistoryNew` і `loadHistoryPeriod` заповнюють пропущену історію без очікування нових 35 свічок.
6. Вибраний користувачем актив через `POST /api/assets/prepare` отримує додатковий запит 30s та M1 history.

Якщо числовий timestamp Pocket містить часовий пояс термінала, колектор калібрує лише стабільний зсув, кратний 15 хвилинам і в межах реальних UTC-зон. Потрібні три узгоджені live-тики. Після нормалізації повторно застосовується звичайна перевірка свіжості, тому довільні майбутні або застарілі дані не стають валідними. Та сама зафіксована корекція застосовується до Pocket history перед побудовою 30s/M1/M5 buckets.

Повторна підписка на той самий символ і період дедуплікується. Socket.IO heartbeat обробляє ping timeout, а collector використовує обмежений backoff 1–30 секунд. Пакет, який Pocket не підтвердив за 20 секунд, позначається як відхилений і не запускається у нескінченному циклі.

## Безпека

- `POCKET_AUTH_PACKET` існує лише в Environment Variables Render.
- Пакет не записується у Supabase, відповіді API або application logs.
- Пакет реального рахунку блокується до створення WebSocket.
- `GET /api/diagnostics` потребує заголовок `X-Diagnostics-Secret`.
- `POST /api/assets/prepare` потребує справжній Telegram `initData`.
- Vercel не отримує Pocket, Telegram Bot, Supabase service-role або diagnostics secrets.

## Render variables

```env
POCKET_COLLECTOR_ENABLED=true
POCKET_AUTH_PACKET=42["auth",{..."isDemo":1...}]
POCKET_DEMO_REGION=EU
POCKET_MAX_ASSETS=80
POCKET_STALE_AFTER_MS=15000
DIAGNOSTICS_SECRET=long-random-server-only-secret
```

Допустимі регіони обмежені `EU` і `EU_ALT`; довільний WebSocket endpoint конфігурація не приймає.

## Отримання POCKET_AUTH_PACKET

1. Увійти у власний Pocket Option у Chrome або Edge.
2. Перемкнути термінал саме на **Demo account**.
3. Відкрити DevTools (`F12` або `Ctrl+Shift+I`), вкладку **Network**, фільтр **WS**.
4. Перезавантажити сторінку термінала, щоб побачити нове Socket.IO-з’єднання.
5. Відкрити рядок `socket.io/?EIO=4&transport=websocket`, потім вкладку **Messages**.
6. Знайти вихідне повідомлення, яке починається з `42["auth",`.
7. Перевірити всередині повідомлення `"isDemo":1`, скопіювати весь рядок без скорочення.
8. Render Dashboard → `market-pulse-backend` → **Environment** → додати або замінити `POCKET_AUTH_PACKET` → **Save and deploy**.

Пакет не можна надсилати у чат, комітити в Git або додавати у Vercel. Після виходу із Pocket, завершення сесії або її відкликання пакет може стати недійсним — тоді потрібно повторити процедуру.

## Supabase migration

Після трьох попередніх міграцій застосувати:

```text
supabase/migrations/20260718190000_pocket_collector_runtime.sql
```

Міграція зберігає UUID існуючих активів, але переводить старі ключі на точні WebSocket symbols (`AUD/CAD OTC` → `AUDCAD_otc`). Якщо обидві форми вже існують, вона об’єднує записи, переносить тики, свічки, прогнози й діагностику на canonical UUID та усуває лише дубль. Історія та зовнішні ключі не втрачаються.

## Перевірка після деплою

`GET /api/health` повинен показати:

```json
{"pocket":"ready"}
```

Детальний стан перевіряється без передачі секрету в URL:

```powershell
Invoke-RestMethod `
  -Uri "https://market-pulse-backend-9z5v.onrender.com/api/diagnostics" `
  -Headers @{ "X-Diagnostics-Secret" = "YOUR_DIAGNOSTICS_SECRET" }
```

Корисні поля: `authenticated`, `lastTickAt`, `quoteAgeMs`, `rawPocketClockOffsetMs`, `pocketClockOffsetMs`, `pocketTimestampCorrectionMs`, `acceptedTicks`, `rejectedTicks` і `lastError`.

- `rawPocketClockOffsetMs` — різниця Render і необробленого timestamp Pocket.
- `pocketTimestampCorrectionMs` — підтверджена корекція terminal wall clock до UTC.
- `pocketClockOffsetMs` — залишкова різниця після корекції; саме вона використовується для контролю свіжості.
