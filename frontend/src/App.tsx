import { useEffect, useState } from "react";

type ConnectionState = "checking" | "online" | "offline";
type Expiration = 1 | 2 | 3;

const apiBaseUrl = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:3000";

export function App() {
  const [connection, setConnection] = useState<ConnectionState>("checking");
  const [expiration, setExpiration] = useState<Expiration>(1);

  useEffect(() => {
    const controller = new AbortController();

    fetch(`${apiBaseUrl}/api/health`, { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error("Backend unavailable");
        setConnection("online");
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setConnection("offline");
      });

    return () => controller.abort();
  }, []);

  return (
    <div className="app-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">MARKET PULSE</p>
          <h1>Короткий прогноз</h1>
        </div>
        <span className="demo-badge">ДЕМО</span>
      </header>

      <main>
        <section className="status-card" aria-live="polite">
          <span className={`status-dot status-dot--${connection}`} />
          <div>
            <span className="label">Стан сервера</span>
            <strong>
              {connection === "online"
                ? "Система готова"
                : connection === "checking"
                  ? "Перевіряємо з’єднання"
                  : "Сервер недоступний"}
            </strong>
          </div>
        </section>

        <section className="analysis-card">
          <div className="section-heading">
            <div>
              <span className="label">Вибраний актив</span>
              <h2>Оберіть актив</h2>
            </div>
            <button className="text-button" type="button" disabled>
              Каталог
            </button>
          </div>

          <div className="placeholder-row">
            <span>Виплата</span>
            <strong>—</strong>
          </div>

          <fieldset>
            <legend>Експірація</legend>
            <div className="expiration-grid">
              {([1, 2, 3] as const).map((minutes) => (
                <button
                  className={expiration === minutes ? "expiration active" : "expiration"}
                  key={minutes}
                  onClick={() => setExpiration(minutes)}
                  type="button"
                >
                  <strong>{minutes}</strong>
                  <span>{minutes === 1 ? "хвилина" : "хвилини"}</span>
                </button>
              ))}
            </div>
          </fieldset>

          <button className="analyze-button" type="button" disabled>
            Проаналізувати
          </button>
          <p className="helper-text">Каталог і аналіз з’являться після підключення Pocket.</p>
        </section>

        <aside className="research-note">
          Інструмент створений для досліджень на деморахунку та не гарантує прибутку.
        </aside>
      </main>

      <nav className="bottom-nav" aria-label="Основна навігація">
        {[
          ["pulse", "Аналіз"],
          ["clock", "Історія"],
          ["chart", "Статистика"],
          ["settings", "Контроль"]
        ].map(([icon, label], index) => (
          <button className={index === 0 ? "nav-item active" : "nav-item"} key={label} type="button">
            <span className={`nav-icon nav-icon--${icon}`} aria-hidden="true" />
            <span>{label}</span>
          </button>
        ))}
      </nav>
    </div>
  );
}
