import { timingSafeEqual } from "node:crypto";

export type TelegramWebhookMessage = {
  chatId: number;
  command: "start" | "help";
};

export function verifyWebhookSecret(received: string, expected: string): boolean {
  const receivedBuffer = Buffer.from(received);
  const expectedBuffer = Buffer.from(expected);

  return (
    receivedBuffer.length === expectedBuffer.length &&
    receivedBuffer.length > 0 &&
    timingSafeEqual(receivedBuffer, expectedBuffer)
  );
}

export function parseWebhookCommand(body: unknown): TelegramWebhookMessage | null {
  if (typeof body !== "object" || body === null || !("message" in body)) return null;
  const message = body.message;
  if (typeof message !== "object" || message === null || !("chat" in message) || !("text" in message)) {
    return null;
  }
  const chat = message.chat;
  if (
    typeof chat !== "object" ||
    chat === null ||
    !("id" in chat) ||
    typeof chat.id !== "number" ||
    !Number.isSafeInteger(chat.id) ||
    !("type" in chat) ||
    chat.type !== "private" ||
    typeof message.text !== "string"
  ) {
    return null;
  }

  const match = message.text.trim().match(/^\/(start|help)(?:@[A-Za-z0-9_]+)?(?:\s|$)/i);
  if (!match?.[1]) return null;

  return { chatId: chat.id, command: match[1].toLowerCase() as "start" | "help" };
}
