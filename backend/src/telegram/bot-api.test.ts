import { describe, expect, it, vi } from "vitest";
import { createTelegramBotApi } from "./bot-api.js";

function okResponse(): Response {
  return new Response(JSON.stringify({ ok: true, result: true }), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });
}

describe("Telegram Bot API client", () => {
  it("надсилає /start повідомлення з Mini App кнопкою", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => okResponse());
    const client = createTelegramBotApi({
      botToken: "123:test-token",
      miniAppUrl: "https://market-pulse.vercel.app",
      fetchImpl
    });

    await client.sendStartMessage(42);

    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, options] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toContain("/sendMessage");
    expect(JSON.parse(String(options?.body))).toMatchObject({
      chat_id: 42,
      reply_markup: {
        inline_keyboard: [[{ web_app: { url: "https://market-pulse.vercel.app" } }]]
      }
    });
  });

  it("реєструє webhook, команди та постійну menu button", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => okResponse());
    const client = createTelegramBotApi({
      botToken: "123:test-token",
      miniAppUrl: "https://market-pulse.vercel.app",
      fetchImpl
    });

    await client.configureWebhook(
      "https://market-pulse.onrender.com/api/telegram/webhook",
      "webhook_secret"
    );

    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(fetchImpl.mock.calls.map(([url]) => String(url))).toEqual(
      expect.arrayContaining([
        expect.stringContaining("/setWebhook"),
        expect.stringContaining("/setMyCommands"),
        expect.stringContaining("/setChatMenuButton")
      ])
    );
  });
});
