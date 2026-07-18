import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchAssets, prepareAsset } from "./api";

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
      assets: [{ id: "asset-1", pocketSymbol: "EURUSD_otc", payoutPercent: 92 }]
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

  it("передає вибраний актив тільки через backend із Telegram initData", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await prepareAsset("asset-1", "query_id=test&hash=signed");

    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:3000/api/assets/prepare",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ "X-Telegram-Init-Data": "query_id=test&hash=signed" }),
        body: JSON.stringify({ assetId: "asset-1" })
      })
    );
  });
});
