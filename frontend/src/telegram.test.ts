import { afterEach, describe, expect, it, vi } from "vitest";
import { initializeTelegram } from "./telegram";

afterEach(() => vi.unstubAllGlobals());

describe("initializeTelegram", () => {
  it("залишає прямий браузерний запуск без initData", () => {
    vi.stubGlobal("window", {});

    expect(initializeTelegram()).toEqual({ environment: "browser", initData: "" });
  });

  it("повідомляє Telegram про готовність і передає сирий initData", () => {
    const ready = vi.fn();
    const expand = vi.fn();
    const setHeaderColor = vi.fn();
    const setBackgroundColor = vi.fn();
    vi.stubGlobal("window", {
      Telegram: {
        WebApp: {
          initData: "auth_date=123&hash=abc",
          platform: "android",
          colorScheme: "dark",
          ready,
          expand,
          setHeaderColor,
          setBackgroundColor
        }
      }
    });

    expect(initializeTelegram()).toEqual({
      environment: "telegram",
      initData: "auth_date=123&hash=abc",
      platform: "android"
    });
    expect(ready).toHaveBeenCalledOnce();
    expect(expand).toHaveBeenCalledOnce();
    expect(setHeaderColor).toHaveBeenCalledWith("#071d17");
  });
});
