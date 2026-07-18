import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { TelegramInitDataError, verifyTelegramInitData } from "./init-data.js";

const BOT_TOKEN = "123456789:test-token-for-signature-tests";
const NOW = new Date("2026-07-18T10:00:00.000Z");

function compareKeys([left]: [string, string], [right]: [string, string]): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function sign(fields: Record<string, string>): string {
  const dataCheckString = Object.entries(fields)
    .sort(compareKeys)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  const secret = createHmac("sha256", "WebAppData").update(BOT_TOKEN).digest();
  const hash = createHmac("sha256", secret).update(dataCheckString).digest("hex");
  return new URLSearchParams({ ...fields, hash }).toString();
}

const validFields = {
  auth_date: String(Math.floor(NOW.getTime() / 1000) - 60),
  query_id: "AAHdF6IQAAAAAN0XohDhrOrc",
  user: JSON.stringify({ id: 42, first_name: "Марія", username: "maria" })
};

describe("verifyTelegramInitData", () => {
  it("повертає користувача лише після коректної HMAC-перевірки", () => {
    const result = verifyTelegramInitData(sign(validFields), {
      botToken: BOT_TOKEN,
      maxAgeSeconds: 300,
      now: NOW
    });

    expect(result.user).toMatchObject({ id: 42, first_name: "Марія" });
    expect(result.queryId).toBe(validFields.query_id);
  });

  it("відхиляє змінені після підпису дані", () => {
    const tampered = sign(validFields).replace("%D0%9C%D0%B0%D1%80%D1%96%D1%8F", "Attacker");

    expect(() =>
      verifyTelegramInitData(tampered, { botToken: BOT_TOKEN, maxAgeSeconds: 300, now: NOW })
    ).toThrowError(expect.objectContaining({ code: "INVALID_SIGNATURE" }));
  });

  it("відхиляє застарілу сесію", () => {
    const expired = sign({ ...validFields, auth_date: String(Math.floor(NOW.getTime() / 1000) - 301) });

    expect(() =>
      verifyTelegramInitData(expired, { botToken: BOT_TOKEN, maxAgeSeconds: 300, now: NOW })
    ).toThrowError(expect.objectContaining({ code: "EXPIRED_INIT_DATA" }));
  });

  it("відхиляє дубльовані параметри", () => {
    const duplicated = `${sign(validFields)}&auth_date=${validFields.auth_date}`;

    expect(() =>
      verifyTelegramInitData(duplicated, { botToken: BOT_TOKEN, maxAgeSeconds: 300, now: NOW })
    ).toThrowError(TelegramInitDataError);
  });
});
