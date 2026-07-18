# Етап 6: тики, котировка та свічки

## Реалізоване ядро

- `QuoteBook` приймає лише валідні Pocket-тики та відкидає дублікати й старі повідомлення.
- Свіжість котировки перевіряється окремо за часом отримання Render і Pocket timestamp.
- `CandleEngine` одночасно формує 30-секундні, M1 та M5 OHLC-свічки.
- Прогалини у тиках не заповнюються вигаданими свічками.
- `tickCount` зберігається як кількість прийнятих тиків і не називається біржовим обсягом.
- `MarketDataPipeline` раз на секунду пакетно записує тики, candle snapshots та останні котировки.
- Один SQL-виклик `ingest_pocket_market_data` атомарно оновлює всі три набори даних.
- Після restart незакриті buckets відновлюються з `last_tick_at`, тому старий повторний тик не переписує їхній `close`.

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
```

```powershell
supabase db push
```

## Що навмисно не імітується

Система не створює випадкові тики та не використовує TradingView, Binance або Twelve Data. До налаштування авторизованої Pocket Demo-сесії свічки можуть бути порожніми зі статусом `warming`.

Read-only мережевий адаптер описано в [`pocket-collector-v1.md`](pocket-collector-v1.md). Він лише декодує реальні Pocket-повідомлення та передає нормалізовані тики у `MarketDataPipeline`. Відкриття угод до цього потоку не входить.
