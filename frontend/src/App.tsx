import { useEffect, useState, type ReactNode } from "react";
import {
  checkHealth,
  fetchAssets,
  prepareAsset,
  verifySession,
  type AssetSummary,
  type AssetsResponse,
  type HealthResponse
} from "./api";
import { browserLaunchContext, type TelegramLaunchContext } from "./telegram";

type ConnectionState = "checking" | "online" | "offline";
type Expiration = 1 | 2 | 3;
type SessionState = "browser" | "checking" | "verified" | "rejected";
type Tab = "analysis" | "history" | "statistics" | "control";
type MarketFilter = "all" | "regular" | "otc";
type CatalogLoadState = "loading" | "ready" | "error";
type IconName = "pulse" | "history" | "chart" | "control" | "chevron" | "search" | "asset" | "shield";

const tabs: { id: Tab; label: string; icon: IconName }[] = [
  { id: "analysis", label: "Аналіз", icon: "pulse" },
  { id: "history", label: "Історія", icon: "history" },
  { id: "statistics", label: "Статистика", icon: "chart" },
  { id: "control", label: "Контроль", icon: "control" }
];

function Icon({ name, size = 20 }: { name: IconName; size?: number }) {
  const paths: Record<IconName, ReactNode> = {
    pulse: <path d="M3 12h3.2l2.1-5.3 3.4 10.6 2.2-5.3H21" />,
    history: <><path d="M4 5v5h5" /><path d="M5.2 17a8 8 0 1 0-.8-9" /><path d="M12 7v5l3 2" /></>,
    chart: <><path d="M4 19V9" /><path d="M10 19V5" /><path d="M16 19v-7" /><path d="M22 19H2" /></>,
    control: <><path d="M4 7h10" /><path d="M18 7h2" /><path d="M10 17h10" /><path d="M4 17h2" /><circle cx="16" cy="7" r="2" /><circle cx="8" cy="17" r="2" /></>,
    chevron: <path d="m9 6 6 6-6 6" />,
    search: <><circle cx="11" cy="11" r="7" /><path d="m20 20-4-4" /></>,
    asset: <><circle cx="12" cy="12" r="8" /><path d="M8 13.5 11 10l2 2 3-4" /></>,
    shield: <><path d="M12 3 5 6v5c0 4.6 2.8 8 7 10 4.2-2 7-5.4 7-10V6l-7-3Z" /><path d="m9 12 2 2 4-4" /></>
  };

  return (
    <svg aria-hidden="true" className="icon" fill="none" height={size} viewBox="0 0 24 24" width={size}>
      <g stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8">{paths[name]}</g>
    </svg>
  );
}

function EmptyState({ icon, title, text }: { icon: IconName; title: string; text: string }) {
  return (
    <div className="empty-state">
      <span className="empty-icon"><Icon name={icon} size={24} /></span>
      <strong>{title}</strong>
      <p>{text}</p>
    </div>
  );
}

function formatPayout(value: number | null): string {
  return value === null ? "—" : `${Math.round(value)}%`;
}

function formatQuote(value: number | null): string {
  if (value === null) return "—";
  return new Intl.NumberFormat("uk-UA", { maximumFractionDigits: 6 }).format(value);
}

function formatDataAge(value: string | null): string {
  if (!value) return "ще не оновлено";
  const ageMs = Math.max(0, Date.now() - Date.parse(value));
  if (!Number.isFinite(ageMs)) return "час невідомий";
  if (ageMs < 60_000) return "щойно";
  if (ageMs < 3_600_000) return `${Math.floor(ageMs / 60_000)} хв тому`;
  return `${Math.floor(ageMs / 3_600_000)} год тому`;
}

function assetDataLabel(asset: AssetSummary | null): string {
  if (!asset) return "Очікують";
  if (asset.dataState === "ready") return "Готові";
  if (asset.dataState === "stale") return "Застарілі";
  if (asset.dataState === "error") return "Помилка";
  if (asset.dataState === "unavailable") return "Недоступні";
  return "Без котировки";
}

export function App({ launchContext = browserLaunchContext }: { launchContext?: TelegramLaunchContext }) {
  const [connection, setConnection] = useState<ConnectionState>("checking");
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [expiration, setExpiration] = useState<Expiration>(1);
  const [activeTab, setActiveTab] = useState<Tab>("analysis");
  const [catalogOpen, setCatalogOpen] = useState(false);
  const [marketFilter, setMarketFilter] = useState<MarketFilter>("all");
  const [catalog, setCatalog] = useState<AssetsResponse | null>(null);
  const [catalogState, setCatalogState] = useState<CatalogLoadState>("loading");
  const [catalogReloadToken, setCatalogReloadToken] = useState(0);
  const [assetSearch, setAssetSearch] = useState("");
  const [selectedAssetId, setSelectedAssetId] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [haptics, setHaptics] = useState(true);
  const [compactNumbers, setCompactNumbers] = useState(false);
  const [session, setSession] = useState<SessionState>(
    launchContext.environment === "telegram" ? "checking" : "browser"
  );

  useEffect(() => {
    let controller = new AbortController();
    const refresh = () => {
      controller.abort();
      controller = new AbortController();
      checkHealth(controller.signal)
        .then((response) => {
          setHealth(response);
          setConnection("online");
        })
        .catch((error: unknown) => {
          if (error instanceof DOMException && error.name === "AbortError") return;
          setConnection("offline");
        });
    };
    refresh();
    const interval = window.setInterval(refresh, 10_000);
    return () => {
      window.clearInterval(interval);
      controller.abort();
    };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setCatalogState("loading");
    fetchAssets(controller.signal)
      .then((response) => {
        setCatalog(response);
        setCatalogState("ready");
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setCatalogState("error");
      });
    return () => controller.abort();
  }, [catalogReloadToken]);

  useEffect(() => {
    if (!selectedAssetId) return;
    let controller = new AbortController();
    const interval = window.setInterval(() => {
      controller.abort();
      controller = new AbortController();
      fetchAssets(controller.signal)
        .then((response) => setCatalog(response))
        .catch(() => undefined);
    }, 3_000);
    return () => {
      window.clearInterval(interval);
      controller.abort();
    };
  }, [selectedAssetId]);

  useEffect(() => {
    if (!selectedAssetId || session !== "verified" || !launchContext.initData) return;
    void prepareAsset(selectedAssetId, launchContext.initData).catch(() =>
      setToast("Актив обрано, але Pocket ще не готовий")
    );
  }, [launchContext.initData, selectedAssetId, session]);

  useEffect(() => {
    if (launchContext.environment !== "telegram" || !launchContext.initData) return;
    const controller = new AbortController();
    verifySession(launchContext.initData, controller.signal)
      .then(() => setSession("verified"))
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setSession("rejected");
      });
    return () => controller.abort();
  }, [launchContext]);

  useEffect(() => {
    if (!toast) return;
    const timeout = window.setTimeout(() => setToast(null), 2600);
    return () => window.clearTimeout(timeout);
  }, [toast]);

  const showFutureNotice = (message: string) => setToast(message);
  const selectedAsset = catalog?.assets.find((asset) => asset.id === selectedAssetId) ?? null;
  const normalizedSearch = assetSearch.trim().toLocaleUpperCase("uk-UA");
  const visibleAssets = (catalog?.assets ?? []).filter((asset) => {
    if (marketFilter !== "all" && asset.marketType !== marketFilter) return false;
    if (!normalizedSearch) return true;
    return `${asset.displayName} ${asset.baseCurrency ?? ""} ${asset.quoteCurrency ?? ""}`
      .toLocaleUpperCase("uk-UA")
      .includes(normalizedSearch);
  });

  const chooseAsset = (asset: AssetSummary) => {
    setSelectedAssetId(asset.id);
    setCatalogOpen(false);
    setToast(`${asset.displayName} обрано`);
  };

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand-lockup">
          <span className="brand-mark"><Icon name="pulse" size={22} /></span>
          <div>
            <strong>Market Pulse</strong>
            <span>Research terminal</span>
          </div>
        </div>
        <div className="header-actions">
          <span className={`connection-pill connection-pill--${connection}`}>
            <i />{connection === "online" ? "Online" : connection === "checking" ? "Sync" : "Offline"}
          </span>
          <span className="demo-badge">ДЕМО</span>
        </div>
      </header>

      <main className="screen-stage">
        {activeTab === "analysis" && (
          <section className="screen analysis-screen" aria-labelledby="analysis-title">
            <div className="screen-title">
              <div><span className="kicker">ШВИДКИЙ АНАЛІЗ</span><h1 id="analysis-title">Новий прогноз</h1></div>
              <span className="timeframe-badge">1–3 хв</span>
            </div>

            {session !== "verified" && (
              <button className={`session-strip session-strip--${session}`} onClick={() => showFutureNotice("Перезапустіть Mini App через Telegram")} type="button">
                <Icon name="shield" size={17} />
                <span>{session === "checking" ? "Перевіряємо Telegram…" : session === "rejected" ? "Сесію не підтверджено" : "Режим перегляду у браузері"}</span>
              </button>
            )}

            <button className="asset-selector" onClick={() => setCatalogOpen(true)} type="button">
              <span className="asset-symbol"><Icon name="asset" size={24} /></span>
              <span className="asset-copy">
                <small>{selectedAsset ? `${selectedAsset.marketType === "otc" ? "OTC" : "REGULAR"} · ВАЛЮТНА ПАРА` : "АКТИВ"}</small>
                <strong>{selectedAsset?.displayName ?? "Оберіть інструмент"}</strong>
                <em>{selectedAsset ? (selectedAsset.isAvailable ? "Доступна зараз" : "Зараз недоступна") : "Regular або OTC"}</em>
              </span>
              <span className="selector-action">{selectedAsset ? "Змінити" : "Каталог"} <Icon name="chevron" size={17} /></span>
            </button>

            <div className="market-strip">
              <div><span>Виплата</span><strong className={selectedAsset?.payoutPercent !== null && (selectedAsset?.payoutPercent ?? 100) < 70 ? "payout-warning" : ""}>{formatPayout(selectedAsset?.payoutPercent ?? null)}</strong></div>
              <div><span>Котировка</span><strong>{formatQuote(selectedAsset?.lastQuote ?? null)}</strong></div>
              <div><span>Дані Pocket</span><strong className={selectedAsset?.dataState === "ready" ? "ready-value" : "waiting-value"}>{assetDataLabel(selectedAsset)}</strong></div>
            </div>

            <fieldset className="expiry-block">
              <div className="field-heading"><legend>Експірація</legend><span>{expiration * 60} секунд</span></div>
              <div className="expiration-grid">
                {([1, 2, 3] as const).map((minutes) => (
                  <button
                    aria-pressed={expiration === minutes}
                    className={expiration === minutes ? "expiration active" : "expiration"}
                    key={minutes}
                    onClick={() => setExpiration(minutes)}
                    type="button"
                  ><strong>{minutes}</strong><span>хв</span></button>
                ))}
              </div>
            </fieldset>

            <div className="analysis-action">
              <button className="analyze-button" onClick={() => {
                if (!selectedAsset) {
                  setToast("Спочатку оберіть актив");
                  setCatalogOpen(true);
                  return;
                }
                setToast(`Для ${selectedAsset.displayName} очікуємо живі котировки Pocket`);
              }} type="button">
                <Icon name="pulse" size={20} /> Проаналізувати
              </button>
              <p><Icon name="shield" size={14} /> Деморежим · без автоматичних угод</p>
            </div>
          </section>
        )}

        {activeTab === "history" && (
          <section className="screen secondary-screen">
            <div className="screen-title"><div><span className="kicker">ЖУРНАЛ</span><h1>Історія</h1></div><button className="icon-button" onClick={() => showFutureNotice("Фільтри історії готові до API")} type="button"><Icon name="control" /></button></div>
            <div className="chip-row"><button className="chip active" type="button">Усі</button><button className="chip" onClick={() => showFutureNotice("Фільтр: ручні прогнози")} type="button">Ручні</button><button className="chip" onClick={() => showFutureNotice("Фільтр: дослідження")} type="button">Дослідження</button></div>
            <EmptyState icon="history" title="Історія ще порожня" text="Завершені прогнози з’являться тут автоматично." />
          </section>
        )}

        {activeTab === "statistics" && (
          <section className="screen secondary-screen">
            <div className="screen-title"><div><span className="kicker">РЕЗУЛЬТАТИ</span><h1>Статистика</h1></div><button className="range-button" onClick={() => showFutureNotice("Вибір періоду готовий до API")} type="button">Увесь час <Icon name="chevron" size={15} /></button></div>
            <div className="stats-grid"><div><span>Прогнозів</span><strong>0</strong></div><div><span>Win rate</span><strong>—</strong></div><div><span>Regular</span><strong>0</strong></div><div><span>OTC</span><strong>0</strong></div></div>
            <div className="chip-row"><button className="chip active" type="button">Усі ринки</button><button className="chip" onClick={() => showFutureNotice("Фільтр Regular")} type="button">Regular</button><button className="chip" onClick={() => showFutureNotice("Фільтр OTC")} type="button">OTC</button></div>
            <EmptyState icon="chart" title="Потрібні завершені прогнози" text="INVALID і CANCELLED не впливатимуть на win rate." />
          </section>
        )}

        {activeTab === "control" && (
          <section className="screen secondary-screen control-screen">
            <div className="screen-title"><div><span className="kicker">СИСТЕМА</span><h1>Контроль</h1></div><span className="version-badge">v0.2</span></div>
            <div className="system-panel">
              <div><span><i className={`mini-dot mini-dot--${connection}`} />Render API</span><strong>{connection === "online" ? "Працює" : "Недоступний"}</strong></div>
              <div><span><i className={`mini-dot mini-dot--${session === "verified" ? "online" : "checking"}`} />Telegram</span><strong>{session === "verified" ? "Підтверджено" : "Перевірка"}</strong></div>
              <div><span><i className={`mini-dot mini-dot--${health?.database === "configured" ? "online" : "checking"}`} />Supabase</span><strong>{health?.database === "configured" ? "Підключено" : "Очікує"}</strong></div>
              <div><span><i className={`mini-dot mini-dot--${health?.pocket === "ready" ? "online" : health?.pocket === "error" ? "offline" : "waiting"}`} />Pocket</span><strong>{health?.pocket === "ready" ? "Підключено" : health?.pocket === "error" ? "Помилка сесії" : health?.pocket === "not_configured" ? "Потрібна сесія" : "Підключення"}</strong></div>
            </div>
            <div className="settings-panel">
              <button onClick={() => setHaptics((value) => !value)} type="button"><span><strong>Тактильний відгук</strong><small>Для основних дій</small></span><i className={haptics ? "switch on" : "switch"} /></button>
              <button onClick={() => setCompactNumbers((value) => !value)} type="button"><span><strong>Компактні числа</strong><small>Скорочений формат статистики</small></span><i className={compactNumbers ? "switch on" : "switch"} /></button>
            </div>
            <button className="diagnostics-button" onClick={() => showFutureNotice("Детальна діагностика буде захищена на backend")} type="button">Діагностика системи <Icon name="chevron" size={16} /></button>
          </section>
        )}
      </main>

      <nav className="bottom-nav" aria-label="Основна навігація">
        {tabs.map((tab) => (
          <button aria-current={activeTab === tab.id ? "page" : undefined} className={activeTab === tab.id ? "nav-item active" : "nav-item"} key={tab.id} onClick={() => setActiveTab(tab.id)} type="button">
            <span className="nav-icon"><Icon name={tab.icon} size={21} /></span><span>{tab.label}</span>
          </button>
        ))}
      </nav>

      {catalogOpen && (
        <div className="sheet-backdrop" onClick={() => setCatalogOpen(false)} role="presentation">
          <section aria-label="Каталог активів" aria-modal="true" className="catalog-sheet" onClick={(event) => event.stopPropagation()} role="dialog">
            <div className="sheet-handle" />
            <div className="sheet-header"><div><span className="kicker">POCKET OPTION</span><h2>Каталог активів</h2></div><button aria-label="Закрити каталог" className="close-button" onClick={() => setCatalogOpen(false)} type="button">×</button></div>
            <label className="search-field"><Icon name="search" size={18} /><input aria-label="Пошук активу" onChange={(event) => setAssetSearch(event.target.value)} placeholder="Наприклад, EUR/USD" type="search" value={assetSearch} /></label>
            <div className="chip-row catalog-filters">
              {(["all", "regular", "otc"] as const).map((filter) => <button className={marketFilter === filter ? "chip active" : "chip"} key={filter} onClick={() => setMarketFilter(filter)} type="button">{filter === "all" ? "Усі" : filter === "regular" ? "Regular" : "OTC"}</button>)}
            </div>
            {catalogState === "ready" && <div className={catalog?.status === "stale" ? "catalog-meta stale" : "catalog-meta"}>
              <span>{visibleAssets.length} пар</span>
              <span>{catalog?.status === "stale" ? "Кеш застарів · " : "Оновлено "}{formatDataAge(catalog?.updatedAt ?? null)}</span>
            </div>}
            {catalogState === "loading" && <EmptyState icon="asset" title="Оновлюємо каталог" text="Завантажуємо збережені пари й виплати Pocket." />}
            {catalogState === "error" && <>
              <EmptyState icon="asset" title="Каталог тимчасово недоступний" text="Перевірте Render API та повторіть запит." />
              <button className="sheet-action" onClick={() => setCatalogReloadToken((value) => value + 1)} type="button">Спробувати ще раз</button>
            </>}
            {catalogState === "ready" && visibleAssets.length === 0 && <EmptyState
              icon="asset"
              title={catalog?.status === "unavailable" ? "Supabase недоступний" : "Пари не знайдено"}
              text={catalog?.status === "warming" ? "Перший каталог ще завантажується на сервері." : "Змініть пошук або фільтр ринку."}
            />}
            {catalogState === "ready" && visibleAssets.length > 0 && <div className="asset-list">
              {visibleAssets.map((asset) => (
                <button className={selectedAssetId === asset.id ? "asset-row selected" : "asset-row"} key={asset.id} onClick={() => chooseAsset(asset)} type="button">
                  <span className="pair-code"><strong>{asset.baseCurrency ?? "—"}</strong><i />{asset.quoteCurrency ?? "—"}</span>
                  <span className="asset-row-copy"><strong>{asset.displayName}</strong><small><i className={asset.isAvailable ? "availability-dot online" : "availability-dot"} />{asset.marketType === "otc" ? "OTC" : "Regular"} · {asset.isAvailable ? "Доступна" : "Закрита"}</small></span>
                  <span className={(asset.payoutPercent ?? 0) < 70 ? "asset-payout low" : "asset-payout"}><strong>{formatPayout(asset.payoutPercent)}</strong><small>виплата</small></span>
                </button>
              ))}
            </div>}
          </section>
        </div>
      )}

      {toast && <div aria-live="polite" className="toast">{toast}</div>}
    </div>
  );
}
