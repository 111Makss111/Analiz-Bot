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
