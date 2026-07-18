# Telegram Bot webhook

Після запуску на Render backend автоматично:

1. реєструє `POST <RENDER_EXTERNAL_URL>/api/telegram/webhook` через `setWebhook`;
2. передає Telegram webhook secret;
3. реєструє `/start` і `/help`;
4. встановлює постійну menu button для відкриття Mini App.

`/start` повертає коротке попередження про деморежим і кнопку `Відкрити Market Pulse` з production Vercel URL.

## Секрет webhook

`TELEGRAM_WEBHOOK_SECRET` можна додати у Render вручну: щонайменше 32 символи, лише `A-Z`, `a-z`, `0-9`, `_`, `-`. Якщо змінну не задано, backend детерміновано створює окремий SHA-256 secret із Bot Token. Сам Bot Token або похідний secret ніколи не повертаються через API.

## Перевірка deployment

У Render logs після старту має бути повідомлення `Telegram webhook і команди налаштовано`. Якщо Telegram API тимчасово недоступний, backend продовжує працювати й пише чітку помилку; наступний restart повторить безпечну ідемпотентну реєстрацію.

Webhook приймає команди лише з правильним `X-Telegram-Bot-Api-Secret-Token`. Непідтримувані updates підтверджуються без дій, а `/start` обробляється тільки у приватному чаті.
