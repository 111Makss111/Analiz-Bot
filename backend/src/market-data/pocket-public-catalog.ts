import type { CurrencyCatalogAsset, CurrencyCatalogSnapshot } from "./types.js";

const OFFICIAL_CURRENT_ASSETS_URL = "https://pocketoption.com/en/assets-current/";
const MINIMUM_CURRENCY_ASSETS = 5;

function normalizeHtmlText(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/&#x2f;|&#47;|&sol;/gi, "/")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
export function parsePocketCurrencyCatalog(html: string): CurrencyCatalogAsset[] {
  const text = normalizeHtmlText(html);
  const pattern = /\b([A-Z]{3})\s*\/\s*([A-Z]{3})(?:\s+(OTC))?\s+(\d{1,3}(?:[.,]\d{1,2})?)\s*%/g;
  const assets = new Map<string, CurrencyCatalogAsset>();

  for (const match of text.matchAll(pattern)) {
    const [, baseCurrency, quoteCurrency, otcMarker, rawPayout] = match;
    if (!baseCurrency || !quoteCurrency || !rawPayout) continue;

    const payoutPercent = Number(rawPayout.replace(",", "."));
    if (!Number.isFinite(payoutPercent) || payoutPercent < 0 || payoutPercent > 100) continue;

    const marketType = otcMarker ? "otc" : "regular";
    const displayName = `${baseCurrency}/${quoteCurrency}${marketType === "otc" ? " OTC" : ""}`;
    const pocketSymbol = `${baseCurrency}${quoteCurrency}${marketType === "otc" ? "_otc" : ""}`;

    assets.set(pocketSymbol, {
      pocketSymbol,
      displayName,
      baseCurrency,
      quoteCurrency,
      marketType,
      payoutPercent,
      sourcePayload: {
        officialDisplayName: displayName,
        source: "pocket-official-assets-page"
      }
    });
  }

  return [...assets.values()].sort((left, right) => {
    if (left.marketType !== right.marketType) return left.marketType === "regular" ? -1 : 1;
    if (left.payoutPercent !== right.payoutPercent) return right.payoutPercent - left.payoutPercent;
    return left.displayName.localeCompare(right.displayName);
  });
}

type Fetcher = (input: string | URL, init?: RequestInit) => Promise<Response>;

export class PocketPublicCatalogSource {
  constructor(
    private readonly fetcher: Fetcher = fetch,
    private readonly url = OFFICIAL_CURRENT_ASSETS_URL
  ) {}

  async loadCurrencyCatalog(): Promise<CurrencyCatalogSnapshot> {
    const response = await this.fetcher(this.url, {
      headers: {
        Accept: "text/html,application/xhtml+xml",
        "User-Agent": "MarketPulseResearch/0.1 (read-only catalog cache)"
      },
      redirect: "follow",
      signal: AbortSignal.timeout(10_000)
    });

    if (!response.ok) {
      throw new Error(`Pocket catalog returned HTTP ${response.status}`);
    }

    const assets = parsePocketCurrencyCatalog(await response.text());
    if (assets.length < MINIMUM_CURRENCY_ASSETS) {
      throw new Error(`Pocket catalog contains only ${assets.length} recognized currency assets`);
    }

    return {
      source: "pocket-official-assets-page",
      fetchedAt: new Date().toISOString(),
      assets
    };
  }
}
