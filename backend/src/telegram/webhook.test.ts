import { describe, expect, it } from "vitest";
import { parseWebhookCommand, verifyWebhookSecret } from "./webhook.js";

describe("Telegram webhook", () => {
  it("порівнює secret без витоку через звичайне порівняння", () => {
    expect(verifyWebhookSecret("secret_123", "secret_123")).toBe(true);
    expect(verifyWebhookSecret("wrong", "secret_123")).toBe(false);
    expect(verifyWebhookSecret("", "")).toBe(false);
  });

  it("розпізнає /start, параметр і згадку бота у приватному чаті", () => {
    expect(
      parseWebhookCommand({
        update_id: 1,
        message: { chat: { id: 42, type: "private" }, text: "/start@MarketPulseBot campaign" }
      })
    ).toEqual({ chatId: 42, command: "start" });
  });

  it("ігнорує невідомі команди та групові повідомлення", () => {
    expect(parseWebhookCommand({ message: { chat: { id: 42, type: "private" }, text: "/unknown" } })).toBeNull();
    expect(parseWebhookCommand({ message: { chat: { id: -42, type: "group" }, text: "/start" } })).toBeNull();
  });
});
