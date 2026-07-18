# Market Pulse Research

Новий Telegram Mini App для дослідження короткострокових прогнозів Pocket Option на деморахунку.

> Це дослідницький інструмент. Він не гарантує прибутку, не відкриває угоди автоматично й не використовує мартингейл.

## Структура

- `frontend` — мобільний інтерфейс Telegram Mini App для Vercel.
- `backend` — API, серверні таймери та майбутній read-only колектор Pocket для Render.
- `docs` — архітектурні рішення та поетапний план.

Frontend і backend є окремими застосунками. Секрети ніколи не передаються у frontend.

## Вимоги

- Node.js 22+
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

## Перевірки

```powershell
npm run check
npm test
npm run build
```

## Межі першого етапу

Етап 1 створює чисту структуру, локальний запуск і тестовані базові endpoints. Підключення Telegram, Supabase та Pocket не імітується і буде реалізоване окремими етапами.
