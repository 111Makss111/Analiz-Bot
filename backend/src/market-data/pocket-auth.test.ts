import { describe, expect, it } from "vitest";
import { parsePocketDemoAuthPacket, PocketAuthPacketError } from "./pocket-auth.js";

describe("Pocket Demo auth packet", () => {
  it("приймає повний Socket.IO auth packet лише для Demo", () => {
    const auth = parsePocketDemoAuthPacket(
      '42["auth",{"session":"private-session","isDemo":1,"uid":123,"platform":1}]'
    );

    expect(auth).toEqual({
      session: "private-session",
      isDemo: 1,
      uid: 123,
      platform: 1,
      isFastHistory: true,
      isOptimized: true
    });
  });

  it("блокує пакет реального рахунку", () => {
    expect(() =>
      parsePocketDemoAuthPacket(
        '42["auth",{"session":"must-not-leak","isDemo":0,"uid":123,"platform":1}]'
      )
    ).toThrow(/лише Pocket Demo/);
  });

  it("повертає безпечну помилку без вмісту пошкодженої сесії", () => {
    const secret = "very-secret-session-value";
    let error: unknown;
    try {
      parsePocketDemoAuthPacket(`42["auth",{"session":"${secret}"`);
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(PocketAuthPacketError);
    expect(String(error)).not.toContain(secret);
  });
});
