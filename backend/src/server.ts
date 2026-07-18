import "dotenv/config";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createTelegramBotApi } from "./telegram/bot-api.js";

const config = loadConfig();
const app = await createApp(config);

const shutdown = async (signal: string) => {
  app.log.info({ signal }, "Завершення роботи сервера");
  await app.close();
  process.exit(0);
};

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

try {
  await app.listen({ host: config.host, port: config.port });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}

if (config.telegramWebhookSecret && config.backendPublicUrl) {
  try {
    const telegramBotApi = createTelegramBotApi({
      botToken: config.telegramBotToken,
      miniAppUrl: config.telegramMiniAppUrl
    });
    await telegramBotApi.configureWebhook(
      `${config.backendPublicUrl}/api/telegram/webhook`,
      config.telegramWebhookSecret
    );
    app.log.info("Telegram webhook і команди налаштовано");
  } catch (error) {
    app.log.error(error, "Не вдалося налаштувати Telegram webhook; API продовжує роботу");
  }
}
