import { BaseRetailerAdapter } from "./base.js";
import { getRetailerConfig } from "../config/project-config.js";
import { normalizeText } from "../parsing/query.js";
import { SearchIntent, SearchOptions, NormalizedProduct } from "../types/domain.js";
import { clearAndType, humanDelay, navigateLikeUser, withBrowserPage } from "./shared/browser.js";
import { buildProductFromScrape } from "./shared/normalize.js";

type ColesSearchState = {
  results?: ColesSearchResult[];
};

type ColesSearchResult = {
  _type?: string;
  id?: number | string;
  name?: string;
  brand?: string;
  description?: string;
  size?: string;
  availability?: boolean;
  availabilityType?: string;
  onlineHeirs?: Array<{
    category?: string;
    subCategory?: string;
    aisle?: string;
  }>;
  pricing?: {
    now?: number;
    was?: number;
    comparable?: string;
    promotionType?: string;
    onlineSpecial?: boolean;
  };
};

type ColesPageData = {
  searchResults: unknown;
  storeText?: string;
  linkMap: Record<string, string>;
};

type ColesDomCard = {
  href: string;
  name: string;
  priceText?: string | null;
  unitPriceText?: string | null;
  promotionText?: string | null;
};

export class ColesAdapter extends BaseRetailerAdapter {
  constructor() {
    super("coles");
  }

  protected async searchLive(intent: SearchIntent, options: SearchOptions): Promise<NormalizedProduct[]> {
    const retailerConfig = await getRetailerConfig(this.retailer);

    return withBrowserPage({ retailer: this.retailer, location: options.location }, async (page) => {
      await navigateLikeUser(page, "https://www.coles.com.au/");
      await clearAndType(page, "#search-text-input", intent.rawQuery);
      await humanDelay();
      await Promise.allSettled([
        page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 30_000 }),
        page.keyboard.press("Enter")
      ]);
      await page.waitForSelector("h1, [data-testid='product-list']", { timeout: 30_000 }).catch(() => undefined);
      await humanDelay();

      const pageData = await page.evaluate(() => {
        const nextData = (window as Window & { __NEXT_DATA__?: { props?: { pageProps?: { searchResults?: unknown } } } }).__NEXT_DATA__;
        const linkMap = Array.from(document.querySelectorAll('a[href^="/product/"]')).reduce<Record<string, string>>((acc, link) => {
          const href = link.getAttribute("href");
          const productId = href?.match(/-(\d+)(?:$|[/?#])/i)?.[1];
          if (href && productId && !acc[productId]) {
            acc[productId] = href;
          }
          return acc;
        }, {});

        const storeButton = Array.from(document.querySelectorAll("button")).find((button) =>
          /set your location|you.re seeing items/i.test(button.textContent ?? "")
        );

        return {
          searchResults: nextData?.props?.pageProps?.searchResults ?? null,
          storeText: storeButton?.textContent?.trim(),
          linkMap
        };
      });

      const stateResults = extractColesResults(pageData.searchResults);
      if (stateResults.length) {
        return stateResults
          .map((result) => mapColesStateProduct(result, pageData, options))
          .filter((product): product is NormalizedProduct => Boolean(product))
          .slice(0, options.maxResults ?? retailerConfig.maxResults);
      }

      const rawCards = await page.evaluate(() => {
        const productLinks = Array.from(document.querySelectorAll('a[href^="/product/"]'));
        const cards: Array<{
          href: string;
          name: string;
          priceText?: string | null;
          unitPriceText?: string | null;
          promotionText?: string | null;
        }> = [];
        const seen = new Set<string>();

        for (const link of productLinks) {
          const href = link.getAttribute("href");
          const name = link.textContent?.trim();
          if (!href || !name || seen.has(href)) {
            continue;
          }

          seen.add(href);
          const container = link.closest("section, article, li, div");
          const text = container?.textContent ?? "";
          const priceText = text.match(/\$\d+(?:\.\d{1,2})?/)?.[0] ?? null;
          const unitPriceText = text.match(/\$\d+(?:\.\d{1,2})?\s*\/\s*(?:1kg|1l|100g|100ml)/i)?.[0] ?? null;
          const promotionText = text.includes("SPECIAL") || text.includes("DOWN DOWN") || text.includes("EVERY DAY") ? text : null;
          cards.push({ href, name, priceText, unitPriceText, promotionText });
        }

        return cards;
      });

      return rawCards
        .map((card) => mapColesDomCard(card, pageData.storeText, options))
        .filter((product): product is NormalizedProduct => Boolean(product))
        .slice(0, options.maxResults ?? retailerConfig.maxResults);
    });
  }
}

export function extractColesResults(searchResults: unknown): ColesSearchResult[] {
  if (!searchResults || typeof searchResults !== "object") {
    return [];
  }

  const state = searchResults as ColesSearchState;
  return (state.results ?? []).filter((result) => result?._type === "PRODUCT" && Boolean(result.name));
}

function mapColesStateProduct(
  result: ColesSearchResult,
  pageData: ColesPageData,
  options: SearchOptions
): NormalizedProduct | null {
  const productId = String(result.id ?? "");
  const href = pageData.linkMap[productId] ?? buildColesFallbackHref(result, productId);
  const promotionText = deriveColesPromotionText(result);
  const categoryPath = deriveColesCategoryPath(result);

  return buildProductFromScrape({
    retailer: "coles",
    productId,
    sourceUrl: `https://www.coles.com.au${href}`,
    sourceType: "network",
    rawName: buildColesDisplayName(result),
    brand: result.brand,
    shelfPrice: result.pricing?.now,
    unitPriceText: normalizeColesUnitPrice(result.pricing?.comparable),
    promotionText,
    categoryPath,
    availabilityState: result.availability ? "in-stock" : "out-of-stock",
    structuredAttributes: [result.size].filter((value): value is string => Boolean(value)),
    diagnostics: {
      live: true,
      storeText: pageData.storeText,
      availabilityType: result.availabilityType,
      onlineSpecial: result.pricing?.onlineSpecial
    },
    storeContext: options.location
  });
}

function mapColesDomCard(card: ColesDomCard, storeText: string | undefined, options: SearchOptions): NormalizedProduct | null {
  return buildProductFromScrape({
    retailer: "coles",
    productId: card.href.split("-").pop(),
    sourceUrl: `https://www.coles.com.au${card.href}`,
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
      storeText
    },
    storeContext: options.location
  });
}

function buildColesDisplayName(result: ColesSearchResult): string {
  const normalizedName = result.name?.trim() ?? "";
  const size = result.size?.trim();
  if (!normalizedName) {
    return result.description?.trim() ?? "";
  }

  return size && !normalizedName.toLowerCase().includes(size.toLowerCase()) ? `${normalizedName} | ${size}` : normalizedName;
}

function buildColesFallbackHref(result: ColesSearchResult, productId: string): string {
  const slugSource = buildColesDisplayName(result) || result.description || result.brand || productId;
  const slug = normalizeText(slugSource).replace(/\s+/g, "-");
  return `/product/${slug}-${productId}`;
}

function deriveColesPromotionText(result: ColesSearchResult): string | undefined {
  const promotionTokens = [result.pricing?.promotionType]
    .filter((value): value is string => Boolean(value) && value !== "EVERYDAY")
    .map((value) => value.replace(/_/g, " "));

  const now = result.pricing?.now;
  const was = result.pricing?.was;
  if (typeof now === "number" && typeof was === "number" && was > now) {
    promotionTokens.push(`Was $${was.toFixed(2)}`);
  }

  return promotionTokens.length ? promotionTokens.join(" ") : undefined;
}

function deriveColesCategoryPath(result: ColesSearchResult): string[] {
  const onlineHeir = result.onlineHeirs?.[0];
  return [onlineHeir?.subCategory, onlineHeir?.category, onlineHeir?.aisle].filter((value): value is string => Boolean(value));
}

function normalizeColesUnitPrice(value?: string): string | undefined {
  if (!value) {
    return undefined;
  }

  return value.replace(/\s+/g, " ").replace("/ ", "/ ").trim();
}
