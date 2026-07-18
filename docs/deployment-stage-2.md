# Розгортання Етапу 2

## Межі безпеки

- Vercel отримує тільки `VITE_API_BASE_URL` — публічну HTTPS-адресу Render.
- `TELEGRAM_BOT_TOKEN` зберігається тільки в Environment Variables Render.
- Значення `Telegram.WebApp.initDataUnsafe` не використовується як довірене джерело.
- Backend приймає сирий `initData` через `X-Telegram-Init-Data`, перевіряє HMAC, час створення і структуру користувача.
- У production backend не запускається без Bot Token або з HTTP frontend origin.

## 1. Створення Vercel project

1. Імпортувати GitHub-репозиторій у Vercel.
2. Встановити **Root Directory**: `frontend`.
3. Framework Preset: Vite. Команда та `dist` уже задані у `frontend/vercel.json`.
4. Додати одну змінну для Production і Preview:

   `VITE_API_BASE_URL=https://<render-service>.onrender.com`

Не додавати у Vercel Bot Token, Pocket auth packet, Supabase service key або cron secret. Змінні з префіксом `VITE_` потрапляють у клієнтську збірку й є публічними.

## 2. Створення Render web service

У корені є `render.yaml`. Створити Blueprint з цього репозиторію та задати секретні значення:

- `FRONTEND_ORIGIN=https://<vercel-production-domain>` — точний origin без `/` у кінці;
- `TELEGRAM_BOT_TOKEN=<token-from-BotFather>`;
- `TELEGRAM_INIT_DATA_TTL_SECONDS=86400` — уже має безпечне початкове значення.

Render збирає backend з кореневого lockfile, запускає тільки workspace `backend` і перевіряє `/api/health`.

## 3. Налаштування Telegram

1. У `@BotFather` створити або вибрати бота.
2. У Bot Settings відкрити налаштування Menu Button / Main Mini App.
3. Вказати production HTTPS URL Vercel.
4. Відкрити Mini App саме кнопкою Telegram і переконатися, що статус сесії підтверджено.

Backend не довіряє даним браузера. Звичайне відкриття Vercel URL показує локальний/браузерний режим і не дає доступу до приватних endpoints.

## 4. Перевірка після розгортання

- `GET https://<render-service>/api/wake` → `{"ok":true}`;
- `GET https://<render-service>/api/health` → короткий стан без секретів;
- запит `/api/auth/session` без `X-Telegram-Init-Data` → HTTP 401;
- CORS-відповідь дозволяє тільки точний production origin Vercel;
- Mini App з Telegram підтверджує сесію;
- пряме відкриття URL у браузері не підтверджує сесію.

## Локальний режим

У `backend/.env` потрібен тестовий або робочий Bot Token. У звичайному браузері Telegram `initData` відсутній, тому UI навмисно залишається в режимі без приватного доступу. Для повної перевірки використовується HTTPS deployment, відкритий через Telegram.
