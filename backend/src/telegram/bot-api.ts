export type TelegramBotApi = {
  sendStartMessage(chatId: number): Promise<void>;
  configureWebhook(webhookUrl: string, secretToken: string): Promise<void>;
};

type BotApiResponse = { ok: boolean; description?: string };
type BotApiOptions = { botToken: string; miniAppUrl: string; fetchImpl?: typeof fetch };

export function createTelegramBotApi({
  botToken,
  miniAppUrl,
  fetchImpl = fetch
}: BotApiOptions): TelegramBotApi {
  async function call(method: string, payload: object): Promise<void> {
    const response = await fetchImpl(`https://api.telegram.org/bot${botToken}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000)
    });
    const result = (await response.json()) as BotApiResponse;

    if (!response.ok || !result.ok) {
      throw new Error(`Telegram Bot API ${method}: ${result.description ?? `HTTP ${response.status}`}`);
    }
  }

  return {
    async sendStartMessage(chatId) {
      await call("sendMessage", {
        chat_id: chatId,
        text:
          "Вітаємо у Market Pulse 👋\n\n" +
          "Це дослідницький інструмент для деморахунку. Оберіть актив та експірацію 1–3 хвилини у Mini App.",
        reply_markup: {
          inline_keyboard: [[{ text: "Відкрити Market Pulse", web_app: { url: miniAppUrl } }]]
        }
      });
    },

    async configureWebhook(webhookUrl, secretToken) {
      await Promise.all([
        call("setWebhook", {
          url: webhookUrl,
          secret_token: secretToken,
          allowed_updates: ["message"],
          drop_pending_updates: false
        }),
        call("setMyCommands", {
          commands: [
            { command: "start", description: "Відкрити Market Pulse" },
            { command: "help", description: "Допомога" }
          ]
        }),
        call("setChatMenuButton", {
          menu_button: {
            type: "web_app",
            text: "Market Pulse",
            web_app: { url: miniAppUrl }
          }
        })
      ]);
    }
  };
}
