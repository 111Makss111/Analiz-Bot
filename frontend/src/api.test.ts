import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchAssets } from "./api";

afterEach(() => {
  vi.unstubAllGlobals();
});
describe("asset catalog API", () => {
  it("завантажує тільки агрегований backend-каталог", async () => {
    const responseBody = {
      ok: true,
      category: "currency",
      status: "ready",
      source: "supabase-cache",
      updatedAt: "2026-07-18T15:00:00.000Z",
      assets: [{ id: "asset-1", pocketSymbol: "EUR/USD OTC", payoutPercent: 92 }]
    };
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(responseBody), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchAssets(new AbortController().signal);

    expect(result).toEqual(responseBody);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:3000/api/assets?market=all",
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
  });

  it("не маскує HTTP-помилку порожнім каталогом", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("unavailable", { status: 503 })));

    await expect(fetchAssets(new AbortController().signal)).rejects.toThrow("Asset catalog unavailable");
  });
});
