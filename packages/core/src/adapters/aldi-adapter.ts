import { BaseRetailerAdapter } from "./base.js";
import { getRetailerConfig } from "../config/project-config.js";
import { normalizeText } from "../parsing/query.js";
import { SearchIntent, SearchOptions, NormalizedProduct } from "../types/domain.js";
import { clearAndType, humanDelay, navigateLikeUser, withBrowserPage } from "./shared/browser.js";
import { buildProductFromScrape } from "./shared/normalize.js";

type AldiSearchResponse = {
  meta?: {
    pagination?: {
      totalCount?: number;
    };
  };
  data?: AldiSearchProduct[];
};

type AldiSearchProduct = {
  sku?: string;
  name?: string;
  brandName?: string;
  urlSlugText?: string;
  discontinued?: boolean;
  discontinuedNote?: string | null;
  notForSale?: boolean;
  notForSaleReason?: string | null;
  sellingSize?: string | null;
  onSaleDateDisplay?: string | null;
  categories?: Array<{
    name?: string;
  }>;
  badges?: Array<{
    text?: string | null;
    name?: string | null;
    label?: string | null;
  }>;
  price?: {
    amount?: number;
    amountRelevant?: number;
    amountRelevantDisplay?: string | null;
    comparisonDisplay?: string | null;
    perUnitDisplay?: string | null;
    wasPriceDisplay?: string | null;
    additionalInfo?: string | null;
    savingsDisplay?: string | null;
  };
};

type AldiDomCard = {
  href: string;
  brand?: string;
  name: string;
  imageUrl?: string | null;
  size?: string | null;
  unitPriceText?: string | null;
  priceText?: string | null;
  promotionText?: string | null;
};

export class AldiAdapter extends BaseRetailerAdapter {
  constructor() {
    super("aldi");
    this.health = {
      ...this.health,
      extractionConfidence: 0.72
    };
  }

  protected async searchLive(intent: SearchIntent, options: SearchOptions): Promise<NormalizedProduct[]> {
    const searchUrl = `https://www.aldi.com.au/results?q=${encodeURIComponent(intent.rawQuery)}`;
    const retailerConfig = await getRetailerConfig(this.retailer);

    return withBrowserPage({ retailer: this.retailer, location: options.location }, async (page) => {
      const responsePromise = page
        .waitForResponse(
          (response) => response.url().includes("/v3/product-search?") && response.request().method() === "GET",
          { timeout: 30_000 }
        )
        .catch(() => null);

      await navigateLikeUser(page, "https://www.aldi.com.au/");
      await clearAndType(page, "#search-bar-input", intent.rawQuery);
      await humanDelay();
      await page.keyboard.press("Enter");
      const reachedSearchPage = await waitForAldiSearchPage(page);
      if (!reachedSearchPage) {
        await navigateLikeUser(page, searchUrl);
      }

      await page.waitForSelector("main h1, [aria-label='Results']", { timeout: 30_000 }).catch(() => undefined);
      await humanDelay();

      const imageMap = await page.evaluate(() => {
        return Array.from(document.querySelectorAll('a[href^="/product/"]')).reduce<Record<string, string>>((acc, link) => {
          const href = link.getAttribute("href") ?? "";
          const productId = href.match(/-(\d+)(?:$|[/?#])/i)?.[1];
          const container = link.closest("section, article, li, div");
          const image = container?.querySelector("img");
          const imageUrl = image?.getAttribute("src") ?? image?.getAttribute("data-src");
          if (productId && imageUrl && !acc[productId]) {
            acc[productId] = imageUrl;
          }
          return acc;
        }, {});
      });

      const apiResponse = await responsePromise;
      const storeText = await page
        .evaluate(() => {
          const button = Array.from(document.querySelectorAll("button")).find((element) =>
            /current store:/i.test(element.textContent ?? "")
          );
          return button?.textContent?.trim();
        })
        .catch(() => undefined);

      if (apiResponse) {
        const payload = parseAldiSearchPayload(await apiResponse.text());
        const stateResults = extractAldiSearchResults(payload);
        if (stateResults.length) {
          return stateResults
            .map((result) => mapAldiStateProduct(result, storeText, imageMap[result.sku ?? ""], options))
            .filter((product): product is NormalizedProduct => Boolean(product))
            .slice(0, options.maxResults ?? retailerConfig.maxResults);
        }
      }

      const rawCards = await page.evaluate(() => {
        const cards = Array.from(document.querySelectorAll('a[href^="/product/"]')).map<AldiDomCard | null>((link) => {
          const href = link.getAttribute("href");
          const container = link.closest("section, article, li, div");
          const image = container?.querySelector("img");
          const imageUrl = image?.getAttribute("src") ?? image?.getAttribute("data-src") ?? null;
          const brand = container?.querySelector("p")?.textContent?.trim();
          const paragraphs = Array.from(container?.querySelectorAll("p") ?? []);
          const name = paragraphs[1]?.textContent?.trim() ?? link.textContent?.trim() ?? "";
          const size = paragraphs.find((paragraph) => /\b(?:kg|g|l|ml|pack|each)\b/i.test(paragraph.textContent ?? ""))?.textContent?.trim();
          const text = container?.textContent ?? "";
          const priceText = text.match(/\$\d+(?:\.\d{1,2})?/)?.[0] ?? null;
          const unitPriceText = text.match(/\(\$\d+(?:\.\d{1,2})?\s+per\s+\d+\s*(?:kg|g|l|ml|each)\)/i)?.[0] ?? null;
          const promotionText = text.match(/On Sale [A-Za-z]{3} \d{1,2} [A-Za-z]{3}|While Stocks Last/i)?.[0] ?? null;
          if (!href || !name) {
            return null;
          }

          return { href, brand, name, imageUrl, size, unitPriceText, priceText, promotionText };
        });

        return cards.filter((card): card is AldiDomCard => Boolean(card));
      });

      return rawCards
        .map((card) => mapAldiDomCard(card, storeText, options))
        .filter((product): product is NormalizedProduct => Boolean(product))
        .slice(0, options.maxResults ?? retailerConfig.maxResults);
    });
  }
}

export function extractAldiSearchResults(searchResults: unknown): AldiSearchProduct[] {
  if (!searchResults || typeof searchResults !== "object") {
    return [];
  }

  const payload = searchResults as AldiSearchResponse;
  return (payload.data ?? []).filter((product) => Boolean(product.sku && product.name));
}

function parseAldiSearchPayload(raw: string): AldiSearchResponse | null {
  try {
    return JSON.parse(raw) as AldiSearchResponse;
  } catch {
    return null;
  }
}

function mapAldiStateProduct(
  result: AldiSearchProduct,
  storeText: string | undefined,
  imageUrl: string | undefined,
  options: SearchOptions
): NormalizedProduct | null {
  const promotionText = [
    result.onSaleDateDisplay,
    result.price?.savingsDisplay,
    result.price?.wasPriceDisplay,
    result.price?.additionalInfo,
    ...(result.badges ?? []).flatMap((badge) => [badge.text, badge.name, badge.label])
  ]
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value))
    .join(" ")
    .trim();

  const unitPriceText = normalizeAldiUnitPrice(result.price?.comparisonDisplay ?? result.price?.perUnitDisplay);
  const shelfPrice = normalizeAldiPrice(
    result.price?.amountRelevant ?? result.price?.amount,
    result.price?.amountRelevantDisplay
  );

  return buildProductFromScrape({
    retailer: "aldi",
    productId: result.sku,
    sourceUrl: buildAldiProductUrl(result),
    sourceType: "network",
    imageUrl: normalizeAldiImageUrl(imageUrl),
    rawName: buildAldiDisplayName(result),
    brand: result.brandName,
    shelfPrice,
    unitPriceText,
    promotionText: promotionText || undefined,
    categoryPath: (result.categories ?? []).map((category) => category.name).filter((value): value is string => Boolean(value)),
    availabilityState: result.discontinued ? "out-of-stock" : "in-stock",
    structuredAttributes: [result.sellingSize].filter((value): value is string => Boolean(value)),
    diagnostics: {
      live: true,
      storeText,
      notForSale: result.notForSale,
      notForSaleReason: result.notForSaleReason ?? undefined,
      discontinuedNote: result.discontinuedNote ?? undefined
    },
    storeContext: options.location
  });
}

function mapAldiDomCard(card: AldiDomCard, storeText: string | undefined, options: SearchOptions): NormalizedProduct | null {
  return buildProductFromScrape({
    retailer: "aldi",
    productId: card.href.split("-").pop(),
    sourceUrl: `https://www.aldi.com.au${card.href}`,
    sourceType: "search",
    imageUrl: normalizeAldiImageUrl(card.imageUrl),
    rawName: appendSizeIfMissing(card.name, card.size),
    brand: card.brand,
    shelfPriceText: card.priceText,
    unitPriceText: normalizeAldiUnitPrice(card.unitPriceText),
    promotionText: card.promotionText,
    categoryPath: ["Pantry"],
    availabilityState: "in-stock",
    structuredAttributes: [card.size].filter((value): value is string => Boolean(value)),
    diagnostics: {
      live: true,
      storeText
    },
    storeContext: options.location
  });
}

function buildAldiDisplayName(result: AldiSearchProduct): string {
  return appendSizeIfMissing(result.name?.trim() ?? "", result.sellingSize?.trim());
}

function buildAldiProductUrl(result: AldiSearchProduct): string {
  const slug = result.urlSlugText ?? normalizeText(result.name ?? result.sku ?? "product").replace(/\s+/g, "-");
  return `https://www.aldi.com.au/product/${slug}-${result.sku ?? ""}`;
}

function normalizeAldiUnitPrice(value?: string | null): string | undefined {
  if (!value) {
    return undefined;
  }

  return value
    .replace(/[()]/g, "")
    .replace(/\s+per\s+/i, " / ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeAldiPrice(value?: number | null, displayValue?: string | null): number | undefined {
  if (displayValue) {
    const match = displayValue.match(/(\d+(?:\.\d{1,2})?)/);
    if (match) {
      return Number(match[1]);
    }
  }

  if (typeof value !== "number") {
    return undefined;
  }

  if (!Number.isInteger(value)) {
    return Number(value.toFixed(2));
  }

  return Number((value / 100).toFixed(2));
}

function appendSizeIfMissing(name: string, size?: string | null): string {
  if (!size) {
    return name;
  }

  const compact = (value: string) => normalizeText(value).replace(/\s+/g, "");
  return compact(name).includes(compact(size)) ? name : `${name} ${size}`.trim();
}

async function waitForAldiSearchPage(page: import("puppeteer").Page): Promise<boolean> {
  return page
    .waitForFunction(() => location.pathname === "/results", { timeout: 10_000 })
    .then(() => true)
    .catch(() => false);
}

function normalizeAldiImageUrl(value?: string | null): string | undefined {
  if (!value) {
    return undefined;
  }

  if (value.startsWith("http://") || value.startsWith("https://")) {
    return value;
  }

  if (value.startsWith("//")) {
    return `https:${value}`;
  }

  return value.startsWith("/") ? `https://www.aldi.com.au${value}` : `https://www.aldi.com.au/${value}`;
}
