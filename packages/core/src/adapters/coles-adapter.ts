import { BaseRetailerAdapter } from "./base.js";
import { getRetailerConfig } from "../config/project-config.js";
import { normalizeText } from "../parsing/query.js";
import { SearchIntent, SearchOptions, NormalizedProduct } from "../types/domain.js";
import { clearAndType, humanDelay, navigateLikeUser, withBrowserPage } from "./shared/browser.js";
import { buildProductFromScrape } from "./shared/normalize.js";
import { ScrapeFailure, asScrapeFailure, createNavigationFailure } from "./shared/resilience.js";

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

const primedSessions = new Set<string>();
const COLES_SEARCH_INPUT_SELECTORS = [
  "#search-text-input",
  'input[name="search-text-input"]',
  'input[placeholder="Search products & recipes"]',
  'input[placeholder*="Search products"]'
];

export class ColesAdapter extends BaseRetailerAdapter {
  constructor() {
    super("coles");
  }

  protected async searchLive(intent: SearchIntent, options: SearchOptions): Promise<NormalizedProduct[]> {
    const searchUrl = `https://www.coles.com.au/search/products?q=${encodeURIComponent(intent.rawQuery)}`;
    const retailerConfig = await getRetailerConfig(this.retailer);
    const sessionKey = getColesSessionKey(options);

    return withBrowserPage({ retailer: this.retailer, location: options.location }, async (page) => {
      let lastStep = "starting search";
      let ready = false;

      try {
        if (primedSessions.has(sessionKey)) {
          lastStep = "reused in-page search";
          ready = await submitColesSearch(page, intent.rawQuery);
        }

        if (!ready) {
          lastStep = "homepage search";
          await navigateLikeUser(page, "https://www.coles.com.au/");
          ready = await submitColesSearch(page, intent.rawQuery);
        }

        if (!ready) {
          lastStep = "direct search url";
          await navigateLikeUser(page, searchUrl);
          ready = await waitForColesSearchResults(page, 10_000);
        }

        if (!ready) {
          throw createNavigationFailure("Coles search did not reach a results page.");
        }

        primedSessions.add(sessionKey);

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
      } catch (error) {
        const failure = asScrapeFailure(error);
        const diagnostics = [...failure.diagnostics, ...(await captureColesFailureDiagnostics(page, intent.rawQuery, lastStep))];
        throw new ScrapeFailure(failure.message, {
          kind: failure.kind,
          retryable: failure.retryable,
          retryAfterMs: failure.retryAfterMs,
          diagnostics
        });
      }
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

function getColesSessionKey(options: SearchOptions): string {
  return [options.location?.postcode ?? "default", options.location?.suburb ?? "default", options.location?.storeId ?? "default"].join(":");
}

async function submitColesSearch(page: import("puppeteer").Page, query: string): Promise<boolean> {
  const searchSelector = await waitForColesHomepageSearchInput(page, 10_000);
  if (!searchSelector) {
    return false;
  }

  await dismissColesLocationPrompt(page);
  await clearAndType(page, searchSelector, query, 35);
  await humanDelay();
  await page.keyboard.press("Enter");

  if (await waitForColesSearchResults(page, 8_000)) {
    return true;
  }

  const clicked = await clickColesSearchButton(page);
  if (!clicked) {
    return false;
  }

  return waitForColesSearchResults(page, 8_000);
}

async function waitForColesHomepageSearchInput(page: import("puppeteer").Page, timeout: number): Promise<string | undefined> {
  const selector = await page
    .waitForFunction(
      (selectors) => {
        for (const candidate of selectors) {
          const element = document.querySelector(candidate);
          if (!(element instanceof HTMLElement)) {
            continue;
          }

          const style = window.getComputedStyle(element);
          if (style.visibility === "hidden" || style.display === "none") {
            continue;
          }

          const bounds = element.getBoundingClientRect();
          if (bounds.width <= 0 || bounds.height <= 0) {
            continue;
          }

          return candidate;
        }

        return undefined;
      },
      { timeout },
      COLES_SEARCH_INPUT_SELECTORS
    )
    .then((handle) => handle.jsonValue() as Promise<string | undefined>)
    .catch(() => undefined);

  return selector;
}

async function dismissColesLocationPrompt(page: import("puppeteer").Page): Promise<void> {
  const dismissed = await page
    .evaluate(() => {
      const closeButton = Array.from(document.querySelectorAll("button")).find((button) =>
        /close popup/i.test(button.textContent ?? "") || /close popup/i.test(button.getAttribute("aria-label") ?? "")
      );

      if (!(closeButton instanceof HTMLElement)) {
        return false;
      }

      closeButton.click();
      return true;
    })
    .catch(() => false);

  if (dismissed) {
    await humanDelay();
  }
}

async function clickColesSearchButton(page: import("puppeteer").Page): Promise<boolean> {
  return page
    .evaluate(() => {
      const button = Array.from(document.querySelectorAll("button")).find((candidate) => /^search$/i.test(candidate.textContent?.trim() ?? ""));
      if (!(button instanceof HTMLElement)) {
        return false;
      }

      button.click();
      return true;
    })
    .catch(() => false);
}

async function waitForColesSearchResults(page: import("puppeteer").Page, timeout: number): Promise<boolean> {
  return page
    .waitForFunction(
      () => {
        if (!location.pathname.startsWith("/search/products")) {
          return false;
        }

        const nextData = (window as Window & {
          __NEXT_DATA__?: { props?: { pageProps?: { searchResults?: { results?: unknown[] } } } };
        }).__NEXT_DATA__;
        const stateCount = nextData?.props?.pageProps?.searchResults?.results?.length ?? 0;
        const productLinks = document.querySelectorAll('a[href^="/product/"]').length;
        const bodyText = document.body?.innerText ?? "";
        return stateCount > 0 || productLinks > 0 || /0 results found|showing results for/i.test(bodyText);
      },
      { timeout }
    )
    .then(() => true)
    .catch(() => false);
}

async function captureColesFailureDiagnostics(
  page: import("puppeteer").Page,
  query: string,
  step: string
): Promise<string[]> {
  const snapshot = await page
    .evaluate(() => ({
      url: location.href,
      title: document.title,
      hasSearchInput: Boolean(document.querySelector('#search-text-input, input[name="search-text-input"], input[placeholder*="Search products"]')),
      hasResultsHeading: /results for/i.test(document.body?.innerText ?? ""),
      productLinkCount: document.querySelectorAll('a[href^="/product/"]').length,
      bodySnippet: (document.body?.innerText ?? "").replace(/\s+/g, " ").trim().slice(0, 800)
    }))
    .catch(() => ({
      url: "unavailable",
      title: "unavailable",
      hasSearchInput: false,
      hasResultsHeading: false,
      productLinkCount: 0,
      bodySnippet: "Unable to capture Coles failure page content."
    }));

  return [
    `Coles failure query: ${query}`,
    `Coles failure step: ${step}`,
    `Coles failure url: ${snapshot.url || "unavailable"}`,
    `Coles failure title: ${snapshot.title || "unavailable"}`,
    `Coles failure flags: searchInput=${snapshot.hasSearchInput} resultsHeading=${snapshot.hasResultsHeading} productLinks=${snapshot.productLinkCount}`,
    `Coles failure body: ${snapshot.bodySnippet || "empty"}`
  ];
}
