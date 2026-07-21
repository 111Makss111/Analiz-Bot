# Етап 6: тики, котировка та свічки

> Початковий high-volume writer цього етапу замінено міграцією
> [`collector-load-control-v1`](collector-load-control-v1.md). Нижче збережено опис ядра свічок,
> але live ticks і незакриті candle snapshots більше не записуються щосекунди у Supabase.

## Реалізоване ядро

- `QuoteBook` приймає лише валідні Pocket-тики та відкидає дублікати й старі повідомлення.
- Свіжість котировки перевіряється окремо за часом отримання Render і нормалізованим Pocket timestamp. Якщо Pocket кодує timezone термінала у числовий час, стабільний зсув спочатку калібрується на live-потоці й окремо фіксується в діагностиці.
- `CandleEngine` одночасно формує 30-секундні, M1 та M5 OHLC-свічки.
- Прогалини у тиках не заповнюються вигаданими свічками.
- `tickCount` зберігається як кількість прийнятих тиків і не називається біржовим обсягом.
- `MarketDataPipeline` тримає останні 10 хвилин тиків і незакриті candle snapshots у bounded Render memory.
- Supabase отримує лише завершені свічки через `ingest_pocket_completed_candles` один batch кожні 15 секунд.
- Після restart вибраний актив отримує збережені завершені свічки та свіжу Pocket history, без повторного накопичення 35 хвилин.

Межі bucket визначаються лише Pocket server time:

```text
open_time = floor(pocket_time / timeframe) * timeframe
close_time = open_time + timeframe
```

Тик із часом, рівним `close_time`, належить наступній свічці.

## API історії

```text
GET /api/assets/:assetId/candles?timeframe=30&limit=120
GET /api/assets/:assetId/candles?timeframe=60&limit=120
GET /api/assets/:assetId/candles?timeframe=300&limit=120
```

Підтримуються тільки `30`, `60` і `300` секунд. `limit` — від 1 до 500. Відповідь повертається від старішої свічки до новішої.

## Міграція

Перед деплоєм застосувати:

```text
supabase/migrations/20260718180000_candle_tick_integrity.sql
supabase/migrations/20260721100000_compact_market_data.sql
```

```powershell
supabase db push
```

## Що навмисно не імітується

Система не створює випадкові тики та не використовує TradingView, Binance або Twelve Data. До налаштування авторизованої Pocket Demo-сесії свічки можуть бути порожніми зі статусом `warming`.

Read-only мережевий адаптер описано в [`pocket-collector-v1.md`](pocket-collector-v1.md). Він лише декодує реальні Pocket-повідомлення та передає нормалізовані тики у `MarketDataPipeline`. Відкриття угод до цього потоку не входить.
