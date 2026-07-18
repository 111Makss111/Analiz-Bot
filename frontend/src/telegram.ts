export type TelegramWebApp = {
  initData: string;
  platform: string;
  colorScheme: "light" | "dark";
  ready(): void;
  expand(): void;
  setHeaderColor?(color: string): void;
  setBackgroundColor?(color: string): void;
};

export type TelegramLaunchContext = {
  environment: "telegram" | "browser";
  initData: string;
  platform?: string;
};

declare global {
  interface Window {
    Telegram?: { WebApp: TelegramWebApp };
  }
}

export const browserLaunchContext: TelegramLaunchContext = {
  environment: "browser",
  initData: ""
};

export function initializeTelegram(): TelegramLaunchContext {
  const webApp = window.Telegram?.WebApp;

  if (!webApp) return browserLaunchContext;

  webApp.setHeaderColor?.("#071d17");
  webApp.setBackgroundColor?.("#071d17");
  webApp.expand();
  webApp.ready();

  return {
    environment: "telegram",
    initData: webApp.initData,
    platform: webApp.platform
  };
}
