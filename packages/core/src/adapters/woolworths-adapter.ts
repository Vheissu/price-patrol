import { BaseRetailerAdapter } from "./base.js";
import { getRetailerConfig } from "../config/project-config.js";
import { SearchIntent, SearchOptions, NormalizedProduct } from "../types/domain.js";
import { clearAndType, humanDelay, navigateLikeUser, withBrowserPage } from "./shared/browser.js";
import type { BrowserPage } from "./shared/browser.js";
import { buildProductFromScrape } from "./shared/normalize.js";
import { normalizeText } from "../parsing/query.js";

type WoolworthsResult = {
  Stockcode?: number;
  Name?: string;
  DisplayName?: string;
  Brand?: string;
  UrlFriendlyName?: string;
  SmallImageFile?: string;
  MediumImageFile?: string;
  LargeImageFile?: string;
  DetailsImagePaths?: string[];
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
  imageUrl?: string | null;
  priceText?: string | null;
  unitPriceText?: string | null;
  promotionText?: string | null;
};

export class WoolworthsAdapter extends BaseRetailerAdapter {
  constructor() {
    super("woolworths");
  }

  protected async searchLive(intent: SearchIntent, options: SearchOptions): Promise<NormalizedProduct[]> {
    const searchUrl = `https://www.woolworths.com.au/shop/search/products?searchTerm=${encodeURIComponent(intent.rawQuery)}`;
    const retailerConfig = await getRetailerConfig(this.retailer);

    return withBrowserPage({ retailer: this.retailer, location: options.location }, async (page) => {
      let ready = false;

      await navigateLikeUser(page, searchUrl);
      ready = await waitForWoolworthsResults(page, 15_000);

      if (!ready) {
        await navigateLikeUser(page, "https://www.woolworths.com.au/");
        const searchInputReady = await page
          .locator("#wx-headerSearch")
          .waitFor({ timeout: 10_000 })
          .then(() => true)
          .catch(() => false);

        if (searchInputReady) {
          await clearAndType(page, "#wx-headerSearch", intent.rawQuery);
          await humanDelay();
          await page.click("#wx-button-header-search-find").catch(() => undefined);
        }

        const reachedSearchPage = await waitForWoolworthsSearchPage(page);
        if (!reachedSearchPage) {
          await navigateLikeUser(page, searchUrl);
        }
        ready = await waitForWoolworthsResults(page, 15_000);
      }

      if (!ready) {
        throw new Error("Woolworths search state was not available in wowDataLayer.");
      }
      await humanDelay();

      const imageMap = await page.evaluate(() => {
        return Array.from(document.querySelectorAll('a[href*="/shop/productdetails/"]')).reduce<Record<string, string>>((acc, link) => {
          const href = link.getAttribute("href") ?? "";
          const stockcode = href.match(/productdetails\/(\d+)/i)?.[1];
          const container = link.closest("article, li, div, section");
          const image = container?.querySelector("img");
          const imageUrl = image?.getAttribute("src") ?? image?.getAttribute("data-src");
          if (stockcode && imageUrl && !acc[stockcode]) {
            acc[stockcode] = imageUrl;
          }
          return acc;
        }, {});
      });

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
              imageUrl: resolveWoolworthsImageUrl(result, imageMap[String(result.Stockcode ?? "")]),
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
            imageUrl?: string | null;
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
          const image = container?.querySelector("img");
          const imageUrl = image?.getAttribute("src") ?? image?.getAttribute("data-src") ?? null;
          const priceText = text.match(/\$\d+(?:\.\d{1,2})?/)?.[0] ?? null;
          const unitPriceText = text.match(/\$\d+(?:\.\d{1,2})?\s*\/\s*(?:100g|1kg|100ml|1l|1each)/i)?.[0] ?? null;
          const promotionText = text.match(/save \$\d+(?:\.\d{1,2})?|was \$\d+(?:\.\d{1,2})?/i)?.[0] ?? null;
          cards.push({ href, name, imageUrl, priceText, unitPriceText, promotionText });
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
    imageUrl: normalizeRetailerImageUrl(card.imageUrl, "https://www.woolworths.com.au"),
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

function resolveWoolworthsImageUrl(result: WoolworthsResult, fallbackImageUrl?: string): string | undefined {
  return normalizeRetailerImageUrl(
    result.LargeImageFile ?? result.MediumImageFile ?? result.SmallImageFile ?? result.DetailsImagePaths?.[0] ?? fallbackImageUrl,
    "https://assets.woolworths.com.au"
  );
}

function normalizeRetailerImageUrl(value: string | null | undefined, baseUrl: string): string | undefined {
  if (!value) {
    return undefined;
  }

  if (value.startsWith("http://") || value.startsWith("https://")) {
    return value;
  }

  if (value.startsWith("//")) {
    return `https:${value}`;
  }

  return value.startsWith("/") ? `${baseUrl}${value}` : `${baseUrl}/${value}`;
}

function slugify(value: string): string {
  return normalizeText(value).replace(/\s+/g, "-");
}

async function waitForWoolworthsSearchPage(page: BrowserPage): Promise<boolean> {
  return page
    .waitForFunction(() => location.pathname.startsWith("/shop/search"), { timeout: 10_000 })
    .then(() => true)
    .catch(() => false);
}

async function waitForWoolworthsResults(page: BrowserPage, timeout: number): Promise<boolean> {
  return page
    .waitForFunction(
      () => {
        const data = (window as Window & { wowDataLayer?: { searchResults?: unknown } }).wowDataLayer?.searchResults;
        if (data) {
          return true;
        }

        if (!location.pathname.startsWith("/shop/search")) {
          return false;
        }

        const bodyText = document.body?.innerText ?? "";
        return /showing results for/i.test(bodyText) || /product list/i.test(bodyText);
      },
      undefined,
      { timeout }
    )
    .then(() => true)
    .catch(() => false);
}
