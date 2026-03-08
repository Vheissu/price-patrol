import { BaseRetailerAdapter } from "./base.js";
import { getRetailerConfig } from "../config/project-config.js";
import { SearchIntent, SearchOptions, NormalizedProduct } from "../types/domain.js";
import { clearAndType, humanDelay, navigateLikeUser, withBrowserPage } from "./shared/browser.js";
import { buildProductFromScrape } from "./shared/normalize.js";
import { normalizeText } from "../parsing/query.js";

type WoolworthsResult = {
  Stockcode?: number;
  Name?: string;
  DisplayName?: string;
  Brand?: string;
  UrlFriendlyName?: string;
  Price?: number;
  WasPrice?: number;
  CupString?: string;
  PackageSize?: string;
  IsAvailable?: boolean;
  IsInStock?: boolean;
  ProductWarningMessage?: string | null;
  Tags?: Array<{ Content?: { Attributes?: { Text?: string } } }>;
  HeaderTag?: { Content?: string | null };
  CentreTag?: { TagContentText?: string | null };
  AdditionalAttributes?: Record<string, string>;
};

type WoolworthsSearchState = {
  products?: WoolworthsResult[];
  items?: Array<{ type?: string; model?: WoolworthsResult }>;
  results?: {
    Products?: Array<{
      Products?: WoolworthsResult[];
    }>;
  };
};

type WoolworthsDomCard = {
  href: string;
  name: string;
  priceText?: string | null;
  unitPriceText?: string | null;
  promotionText?: string | null;
};

export class WoolworthsAdapter extends BaseRetailerAdapter {
  constructor() {
    super("woolworths");
  }

  protected async searchLive(intent: SearchIntent, options: SearchOptions): Promise<NormalizedProduct[]> {
    const retailerConfig = await getRetailerConfig(this.retailer);

    return withBrowserPage({ retailer: this.retailer, location: options.location }, async (page) => {
      await navigateLikeUser(page, "https://www.woolworths.com.au/");
      await clearAndType(page, "#wx-headerSearch", intent.rawQuery);
      await humanDelay();
      await Promise.allSettled([
        page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 30_000 }),
        page.click("#wx-button-header-search-find")
      ]);
      await page.waitForFunction(() => {
        const data = (window as Window & { wowDataLayer?: { searchResults?: unknown } }).wowDataLayer?.searchResults;
        return Boolean(data);
      }, {
        timeout: 30_000
      });
      await humanDelay();

      const data = await page.evaluate(() => {
        const wowDataLayer = (window as Window & { wowDataLayer?: Record<string, unknown> }).wowDataLayer;
        return wowDataLayer?.searchResults ?? null;
      });

      const rawResults = extractWoolworthsResults(data);
      if (rawResults.length) {
        return rawResults
          .map((result) => {
            const displayName = result.DisplayName ?? result.Name;
            if (!displayName || result.Price == null) {
              return null;
            }

            return buildProductFromScrape({
              retailer: "woolworths",
              productId: String(result.Stockcode ?? result.UrlFriendlyName ?? displayName),
              sourceUrl: buildWoolworthsSourceUrl(result, displayName),
              sourceType: "network",
              rawName: displayName,
              brand: result.Brand,
              shelfPrice: result.Price,
              unitPriceText: result.CupString,
              promotionText: deriveWoolworthsPromotionText(result),
              categoryPath: ["Pantry"],
              availabilityState: result.IsAvailable || result.IsInStock ? "in-stock" : "out-of-stock",
              structuredAttributes: deriveWoolworthsAttributes(result),
              diagnostics: {
                live: true,
                stockcode: result.Stockcode,
                wasPrice: result.WasPrice,
                warning: result.ProductWarningMessage ?? undefined
              },
              storeContext: options.location
            });
          })
          .filter((product): product is NormalizedProduct => Boolean(product))
          .slice(0, options.maxResults ?? retailerConfig.maxResults);
      }

      const rawCards = await page.evaluate(() => {
        const links = Array.from(document.querySelectorAll('a[href*="/shop/productdetails/"]'));
        const cards: Array<{
          href: string;
          name: string;
          priceText?: string | null;
          unitPriceText?: string | null;
          promotionText?: string | null;
        }> = [];
        const seen = new Set<string>();

        for (const link of links) {
          const href = link.getAttribute("href");
          const label = link.getAttribute("aria-label");
          const name = label?.trim() || link.textContent?.trim();
          if (!href || !name || seen.has(href)) {
            continue;
          }

          seen.add(href);
          const container = link.closest("article, li, div, section");
          const text = container?.textContent ?? "";
          const priceText = text.match(/\$\d+(?:\.\d{1,2})?/)?.[0] ?? null;
          const unitPriceText = text.match(/\$\d+(?:\.\d{1,2})?\s*\/\s*(?:100g|1kg|100ml|1l|1each)/i)?.[0] ?? null;
          const promotionText = text.match(/save \$\d+(?:\.\d{1,2})?|was \$\d+(?:\.\d{1,2})?/i)?.[0] ?? null;
          cards.push({ href, name, priceText, unitPriceText, promotionText });
        }

        return cards;
      });

      if (!rawCards.length) {
        throw new Error("Woolworths search state was not available in wowDataLayer.");
      }

      return rawCards
        .map((card) => mapWoolworthsDomCard(card, options))
        .filter((product): product is NormalizedProduct => Boolean(product))
        .slice(0, options.maxResults ?? retailerConfig.maxResults);
    });
  }
}

export function extractWoolworthsResults(searchResults: unknown): WoolworthsResult[] {
  if (!searchResults || typeof searchResults !== "object") {
    return [];
  }

  const state = searchResults as WoolworthsSearchState;
  const fromProducts = (state.products ?? []).filter((product) => Boolean(product.DisplayName ?? product.Name));
  const fromItems = (state.items ?? [])
    .filter((item) => item.type === "Product" && item.model)
    .map((item) => item.model as WoolworthsResult);
  const fromLegacyGroups = (state.results?.Products ?? []).flatMap((group) => group.Products ?? []);

  return dedupeWoolworthsResults([...fromProducts, ...fromItems, ...fromLegacyGroups]);
}

function dedupeWoolworthsResults(results: WoolworthsResult[]): WoolworthsResult[] {
  const seen = new Set<string>();
  const deduped: WoolworthsResult[] = [];

  for (const result of results) {
    const key = String(result.Stockcode ?? result.UrlFriendlyName ?? result.DisplayName ?? result.Name ?? "");
    if (!key || seen.has(key)) {
      continue;
    }

    seen.add(key);
    deduped.push(result);
  }

  return deduped;
}

function deriveWoolworthsPromotionText(result: WoolworthsResult): string | undefined {
  const promotionTokens = [
    result.CentreTag?.TagContentText,
    stripHtml(result.HeaderTag?.Content),
    ...(result.Tags?.map((tag) => tag.Content?.Attributes?.Text) ?? [])
  ]
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value));

  if (typeof result.WasPrice === "number" && typeof result.Price === "number" && result.WasPrice > result.Price) {
    promotionTokens.push(`Was $${result.WasPrice.toFixed(2)}`);
  }

  return promotionTokens.length ? promotionTokens.join(" ").replace(/\s+/g, " ").trim() : undefined;
}

function deriveWoolworthsAttributes(result: WoolworthsResult): string[] {
  const values = [
    result.PackageSize,
    ...Object.entries(result.AdditionalAttributes ?? {})
      .filter(([key, value]) => {
        const normalizedKey = normalizeText(key);
        const normalizedValue = normalizeText(String(value));
        return (
          ["brand", "contains", "countryoforigin", "description", "ingredients"].every((blocked) => !normalizedKey.includes(blocked)) &&
          normalizedValue !== "false" &&
          normalizedValue !== "null" &&
          normalizedValue.length > 0 &&
          normalizedValue.length < 40
        );
      })
      .map(([, value]) => normalizeText(String(value)))
  ];

  return Array.from(new Set(values.filter((value): value is string => Boolean(value)))).slice(0, 8);
}

function buildWoolworthsSourceUrl(result: WoolworthsResult, displayName: string): string {
  const slug = result.UrlFriendlyName ?? slugify(displayName);
  const stockcode = result.Stockcode ? `/${result.Stockcode}` : "";
  return `https://www.woolworths.com.au/shop/productdetails${stockcode}/${slug}`;
}

function mapWoolworthsDomCard(card: WoolworthsDomCard, options: SearchOptions): NormalizedProduct | null {
  const sourceUrl = card.href.startsWith("http") ? card.href : `https://www.woolworths.com.au${card.href}`;
  const productIdMatch = sourceUrl.match(/productdetails\/(\d+)/i);

  return buildProductFromScrape({
    retailer: "woolworths",
    productId: productIdMatch?.[1] ?? sourceUrl.split("/").pop(),
    sourceUrl,
    sourceType: "search",
    rawName: card.name,
    shelfPriceText: card.priceText,
    unitPriceText: card.unitPriceText,
    promotionText: card.promotionText,
    categoryPath: ["Pantry"],
    availabilityState: "in-stock",
    structuredAttributes: [],
    diagnostics: {
      live: true,
      domFallback: true
    },
    storeContext: options.location
  });
}

function stripHtml(value?: string | null): string | undefined {
  if (!value) {
    return undefined;
  }

  return value.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function slugify(value: string): string {
  return normalizeText(value).replace(/\s+/g, "-");
}
