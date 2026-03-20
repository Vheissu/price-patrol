import { BaseRetailerAdapter } from "./base.js";
import { getRetailerConfig } from "../config/project-config.js";
import { normalizeText } from "../parsing/query.js";
import { LocationContext, SearchIntent, SearchOptions, NormalizedProduct } from "../types/domain.js";
import { clearAndType, humanDelay, navigateLikeUser, withBrowserPage } from "./shared/browser.js";
import type { BrowserPage } from "./shared/browser.js";
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
const COLES_LOCATION_BUTTON_PATTERN = /set your location|you.?re seeing items|click\s*&\s*collect|delivery/i;
const COLES_LOCATION_BUTTON_SELECTOR = '[data-testid="delivery-selector-button"]';
const COLES_LOCATION_MODAL_READY_SELECTOR =
  '[data-testid="drawer-close-button"], [data-testid="tab-collection"], #street-address-autocomplete, #suburb-postcode-autocomplete';
const COLES_LOCATION_DRAWER_BODY_SELECTOR = '[data-testid="drawer-body-shopping-method"]';
const COLES_CLICK_AND_COLLECT_TAB_SELECTOR = '[data-testid="tab-collection"]';
const COLES_LOCATION_INPUT_SELECTOR = "#suburb-postcode-autocomplete";
const COLES_LOCATION_OPTION_SELECTOR = '[role="option"]';
const COLES_STORE_CARD_SELECTOR = '[data-testid^="card-radio-group-"]';
const COLES_STORE_RADIO_SELECTOR = `${COLES_STORE_CARD_SELECTOR} input[type="radio"], ${COLES_STORE_CARD_SELECTOR} [role="radio"]`;
const COLES_CONFIRM_LOCATION_SELECTOR = `${COLES_LOCATION_DRAWER_BODY_SELECTOR} [data-testid="cta-secondary"]`;

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
        if (!primedSessions.has(sessionKey)) {
          lastStep = "homepage warm-up";
          await navigateLikeUser(page, "https://www.coles.com.au/");
          await waitForColesHomepageSearchInput(page, 10_000);
          await primeColesSession(page, options.location);
          primedSessions.add(sessionKey);
        }

        lastStep = "direct search url";
        await navigateLikeUser(page, searchUrl);
        ready = await waitForColesSearchResults(page, 10_000);

        if (!ready) {
          lastStep = "re-prime location";
          await navigateLikeUser(page, "https://www.coles.com.au/");
          await primeColesSession(page, options.location);
          await navigateLikeUser(page, searchUrl);
          ready = await waitForColesSearchResults(page, 10_000);
        }

        if (!ready) {
          lastStep = "homepage search";
          await navigateLikeUser(page, "https://www.coles.com.au/");
          ready = await submitColesSearch(page, intent.rawQuery);
        }

        if (!ready) {
          throw createNavigationFailure("Coles search did not reach a results page.");
        }
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
            /set your location|you.re seeing items|click\s*&\s*collect|delivery/i.test(button.textContent ?? "")
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
  const postcode = options.location?.postcode?.trim();
  const suburb = options.location?.suburb?.trim();
  const locationText = options.location?.locationText?.trim();
  const locationKey = postcode || suburb || locationText || "default";

  return [locationKey, options.location?.storeId?.trim() || "default"].join(":");
}

export function buildColesLocationSearchTerms(location?: LocationContext): string[] {
  const suburb = location?.suburb?.trim();
  const postcode = location?.postcode?.trim();
  const locationText = location?.locationText?.trim();
  const terms = [postcode, suburb && postcode ? `${suburb} ${postcode}` : undefined, suburb, locationText].filter(
    (value): value is string => Boolean(value)
  );

  return [...new Set(terms.map((value) => value.replace(/\s+/g, " ").trim()).filter(Boolean))];
}

export function scoreColesLocationOption(optionText: string, location?: LocationContext): number {
  const normalizedOption = normalizeColesText(optionText);
  if (!normalizedOption) {
    return 0;
  }

  const normalizedSuburb = normalizeColesText(location?.suburb);
  const normalizedPostcode = normalizeColesText(location?.postcode);
  const normalizedLocationText = normalizeColesText(location?.locationText);
  let score = 0;

  if (normalizedSuburb && normalizedOption.includes(normalizedSuburb)) {
    score += 5;
  }
  if (normalizedPostcode && normalizedOption.includes(normalizedPostcode)) {
    score += 3;
  }
  if (normalizedLocationText && normalizedOption.includes(normalizedLocationText)) {
    score += 2;
  }
  if (normalizedSuburb && normalizedPostcode && normalizedOption === `${normalizedSuburb}, qld ${normalizedPostcode}`) {
    score += 100;
  }

  return score;
}

async function submitColesSearch(page: BrowserPage, query: string): Promise<boolean> {
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

async function waitForColesHomepageSearchInput(page: BrowserPage, timeout: number): Promise<string | undefined> {
  const selector = await page
    .waitForFunction(
      (selectors: string[]) => {
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
      COLES_SEARCH_INPUT_SELECTORS,
      { timeout }
    )
    .then((handle) => handle.jsonValue() as Promise<string | undefined>)
    .catch(() => undefined);

  return selector;
}

async function dismissColesLocationPrompt(page: BrowserPage): Promise<void> {
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

async function primeColesSession(page: BrowserPage, location?: LocationContext): Promise<void> {
  const locationTerms = buildColesLocationSearchTerms(location);
  if (!locationTerms.length) {
    await dismissColesLocationPrompt(page);
    return;
  }

  const modalOpened = await openColesLocationModal(page);
  if (!modalOpened) {
    throw createNavigationFailure("Coles location modal did not open.");
  }

  await page.waitForSelector(COLES_CLICK_AND_COLLECT_TAB_SELECTOR, { timeout: 10_000 });
  await clickColesClickAndCollect(page);
  await page.waitForSelector(COLES_LOCATION_INPUT_SELECTOR, { timeout: 15_000 });

  const optionSelected = await selectColesLocationOption(page, locationTerms, location);
  if (!optionSelected) {
    throw createNavigationFailure("Coles location selection did not return a matching suburb.");
  }

  const storeSelected = await selectColesPickupStore(page, location);
  if (!storeSelected) {
    throw createNavigationFailure("Coles location selection did not return any pickup stores.");
  }

  const confirmed = await confirmColesLocation(page);
  if (!confirmed) {
    throw createNavigationFailure("Coles location could not be confirmed.");
  }
}

async function openColesLocationModal(page: BrowserPage): Promise<boolean> {
  const alreadyOpen = await page.$(COLES_LOCATION_MODAL_READY_SELECTOR);
  if (alreadyOpen) {
    return true;
  }

  const preferredButton = page.getByRole("button", { name: /set your location|you.?re seeing items/i }).first();
  const button = (await preferredButton.count()) ? preferredButton : page.locator(COLES_LOCATION_BUTTON_SELECTOR).first();
  const strategies: Array<() => Promise<unknown>> = [
    () => button.click({ timeout: 10_000, force: true }),
    () => button.press("Enter", { timeout: 5_000 }),
    () => button.evaluate((element) => {
      (element as HTMLElement).click();
    })
  ];

  for (const strategy of strategies) {
    await strategy().catch(() => undefined);
    const ready = await waitForColesLocationModalReady(page, 4_000);
    if (ready) {
      await page.waitForTimeout(1_000);
      await humanDelay();
      return true;
    }
  }

  return false;
}

async function clickColesClickAndCollect(page: BrowserPage): Promise<void> {
  await page.locator(COLES_CLICK_AND_COLLECT_TAB_SELECTOR).click({ timeout: 10_000, force: true }).catch(() => undefined);
  await page.waitForTimeout(1_500);
  await humanDelay();
}

async function selectColesLocationOption(
  page: BrowserPage,
  locationTerms: string[],
  location?: LocationContext
): Promise<boolean> {
  for (const term of locationTerms) {
    await clearAndType(page, COLES_LOCATION_INPUT_SELECTOR, term, 35);

    const optionsLocator = page.locator(COLES_LOCATION_OPTION_SELECTOR);
    const optionsReady = await optionsLocator.first().waitFor({ timeout: 8_000 }).then(() => true).catch(() => false);
    if (!optionsReady) {
      continue;
    }

    const optionTexts = (await optionsLocator.allTextContents()).map((value) => value.replace(/\s+/g, " ").trim());
    const ranked = optionTexts
      .map((optionText, index) => ({
        index,
        score: scoreColesLocationOption(optionText, location)
      }))
      .sort((left, right) => right.score - left.score);
    const looksLikePostcodeOnly = /^\d{4}$/.test(term.trim());
    const targetIndex = ranked[0]?.score > 0 ? ranked[0].index : looksLikePostcodeOnly ? 0 : -1;
    const clicked =
      targetIndex >= 0
        ? await optionsLocator
            .nth(targetIndex)
            .click({ timeout: 10_000, force: true })
            .then(() => true)
            .catch(() => false)
        : false;

    if (!clicked) {
      continue;
    }

    await page.waitForTimeout(2_500);
    await page.waitForSelector(COLES_STORE_CARD_SELECTOR, { timeout: 10_000 }).catch(() => undefined);
    await humanDelay();
    return true;
  }

  return false;
}

async function selectColesPickupStore(page: BrowserPage, location?: LocationContext): Promise<boolean> {
  const storeCards = page.locator(COLES_STORE_CARD_SELECTOR);
  const cardsReady = await storeCards.first().waitFor({ timeout: 12_000 }).then(() => true).catch(() => false);
  if (!cardsReady) {
    return false;
  }

  const preferredStoreId = location?.storeId?.trim();
  const preferredStoreName = normalizeColesText(location?.storeDisplayName);
  const cardTexts = (await storeCards.allTextContents().catch(() => [])).map((value) => value.replace(/\s+/g, " ").trim());
  const matchingIndex = cardTexts.findIndex((text) => {
    const normalizedText = normalizeColesText(text);
    return (
      (Boolean(preferredStoreId) && normalizedText.includes(normalizeColesText(preferredStoreId))) ||
      (Boolean(preferredStoreName) && normalizedText.includes(preferredStoreName))
    );
  });
  const targetIndex = matchingIndex >= 0 ? matchingIndex : 0;
  const targetCard = storeCards.nth(targetIndex);

  const selected =
    (await targetCard
      .click({ timeout: 10_000, force: true })
      .then(() => true)
      .catch(() => false)) ||
    (await targetCard
      .locator('input[type="radio"]')
      .first()
      .check({ timeout: 10_000, force: true })
      .then(() => true)
      .catch(() => false));

  if (selected) {
    await page
      .waitForFunction(
        ({ selector, index }) => {
          const cards = Array.from(document.querySelectorAll<HTMLElement>(selector));
          const target = cards[index];
          if (!target) {
            return false;
          }

          if (target.getAttribute("aria-checked") === "true" || target.getAttribute("data-checked") === "true") {
            return true;
          }

          const radio = target.querySelector<HTMLInputElement>('input[type="radio"]');
          return radio?.checked === true;
        },
        { selector: COLES_STORE_CARD_SELECTOR, index: targetIndex },
        { timeout: 5_000 }
      )
      .catch(() => undefined);
    await page.waitForTimeout(500);
    await humanDelay();
  }

  return selected;
}

async function confirmColesLocation(page: BrowserPage): Promise<boolean> {
  const clicked = await page
    .locator(`${COLES_CONFIRM_LOCATION_SELECTOR}, [data-testid="cta-secondary"]`)
    .last()
    .click({ timeout: 10_000, force: true })
    .then(() => true)
    .catch(() => false);

  if (!clicked) {
    return false;
  }

  await page
    .waitForFunction(() => document.cookie.includes("fulfillmentStoreId="), { timeout: 15_000 })
    .catch(() => undefined);
  await page.waitForTimeout(5_000);
  await page.waitForSelector(COLES_LOCATION_MODAL_READY_SELECTOR, { state: "hidden", timeout: 15_000 }).catch(() => undefined);
  await humanDelay();
  return true;
}

async function waitForColesLocationModalReady(page: BrowserPage, timeout: number): Promise<boolean> {
  return page
    .waitForSelector(COLES_LOCATION_MODAL_READY_SELECTOR, { timeout, state: "visible" })
    .then(() => true)
    .catch(() => false);
}

async function clickColesSearchButton(page: BrowserPage): Promise<boolean> {
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

async function waitForColesSearchResults(page: BrowserPage, timeout: number): Promise<boolean> {
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
  page: BrowserPage,
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
    `Coles failure cookies: ${(await page.context().cookies().catch(() => [])).filter((cookie) => /fulfillment|store|postcode|location/i.test(cookie.name)).map((cookie) => `${cookie.name}=${cookie.value}`).join("; ") || "none"}`,
    `Coles failure flags: searchInput=${snapshot.hasSearchInput} resultsHeading=${snapshot.hasResultsHeading} productLinks=${snapshot.productLinkCount}`,
    `Coles failure body: ${snapshot.bodySnippet || "empty"}`
  ];
}

function normalizeColesText(value?: string): string {
  return value?.toLowerCase().replace(/\s+/g, " ").trim() ?? "";
}
