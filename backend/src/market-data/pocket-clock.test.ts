import { describe, expect, it } from "vitest";
import { PocketClock } from "./pocket-clock.js";

describe("PocketClock", () => {
  it("одразу приймає свіжий UTC timestamp", () => {
    const clock = new PocketClock(15_000);
    const receivedAtMs = Date.UTC(2026, 6, 18, 17, 15, 0);

    expect(clock.normalize(receivedAtMs - 15, receivedAtMs)).toMatchObject({
      accepted: true,
      calibrated: true,
      normalizedTimestampMs: receivedAtMs - 15,
      normalizedOffsetMs: 15,
      correctionMs: 0
    });
  });

  it("калібрує стабільний UTC+2 wall-clock shift і зберігає перевірку свіжості", () => {
    const clock = new PocketClock(15_000);
    const receivedAtMs = Date.UTC(2026, 6, 18, 17, 15, 0);
    const shiftedTimestampMs = receivedAtMs + 2 * 60 * 60 * 1_000 - 10;

    expect(clock.normalize(shiftedTimestampMs, receivedAtMs).accepted).toBe(false);
    expect(clock.normalize(shiftedTimestampMs + 1, receivedAtMs + 1).accepted).toBe(false);
    expect(clock.normalize(shiftedTimestampMs + 2, receivedAtMs + 2)).toMatchObject({
      accepted: true,
      calibrated: true,
      justCalibrated: true,
      normalizedTimestampMs: receivedAtMs - 8,
      normalizedOffsetMs: 10,
      correctionMs: 7_200_000
    });

    expect(
      clock.normalize(shiftedTimestampMs - 60_000, receivedAtMs)
    ).toMatchObject({ accepted: false, calibrated: true, correctionMs: 7_200_000 });
  });

  it("не маскує звичайний застарілий tick як timezone shift", () => {
    const clock = new PocketClock(15_000);
    const receivedAtMs = Date.UTC(2026, 6, 18, 17, 15, 0);

    expect(clock.normalize(receivedAtMs - 60_000, receivedAtMs)).toMatchObject({
      accepted: false,
      calibrated: false,
      correctionMs: null
    });
  });

  it("відхиляє довільний зсув, який не схожий на часовий пояс", () => {
    const clock = new PocketClock(15_000);
    const receivedAtMs = Date.UTC(2026, 6, 18, 17, 15, 0);

    expect(clock.normalize(receivedAtMs + 17 * 60_000, receivedAtMs)).toMatchObject({
      accepted: false,
      calibrated: false
    });
  });
});
