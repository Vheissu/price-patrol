import { chromium, type Browser, type BrowserContext, type BrowserContextOptions, type Page, type Route } from "playwright";
import { getProjectConfig, type ProjectConfig } from "../../config/project-config.js";
import { type LocationContext, type RetailerId } from "../../types/domain.js";
import { createChallengeFailure, createNavigationFailure, createRateLimitFailure, parseRetryAfter } from "./resilience.js";

type BrowserPageOptions = {
  retailer: RetailerId;
  location?: LocationContext;
};

type BrowserConfig = ProjectConfig["browser"];
type BrowserIdentityTarget = Pick<BrowserContext, "setExtraHTTPHeaders" | "addInitScript">;

export type BrowserPage = Page;
export type BrowserLaunchProfile = {
  headless: boolean;
  channel?: "chrome";
};

const browserPromises = new Map<string, Promise<Browser>>();
const contextPromises = new Map<string, Promise<BrowserContext>>();
const pagePromises = new Map<string, Promise<Page>>();
const identityConfiguredContexts = new WeakSet<BrowserIdentityTarget>();
let cleanupRegistered = false;

export async function withBrowserPage<T>(options: BrowserPageOptions, callback: (page: Page) => Promise<T>): Promise<T> {
  const config = await getProjectConfig();
  const browser = await getBrowser(options, config.browser);
  const shouldReuseContext = config.browser.reuseSessions;
  const shouldReusePage = shouldReuseContext && options.retailer === "coles";
  const context = shouldReuseContext
    ? await getRetailerContext(browser, options, config.browser)
    : await createBrowserContext(browser, options, config.browser);
  const page = shouldReusePage ? await getRetailerPage(context, options) : await context.newPage();

  applyBrowserDefaults(page, config.browser);

  try {
    return await callback(page);
  } finally {
    if (!shouldReusePage) {
      await page.close().catch(() => undefined);
    }
    if (!shouldReuseContext) {
      await context.close().catch(() => undefined);
    }
  }
}

export function buildBrowserContextOptions(browserConfig: BrowserConfig): BrowserContextOptions {
  return {
    locale: browserConfig.locale,
    timezoneId: browserConfig.timezone,
    userAgent: browserConfig.userAgent,
    viewport: {
      width: browserConfig.viewportWidth,
      height: browserConfig.viewportHeight
    }
  };
}

export async function applyBrowserIdentity(context: BrowserIdentityTarget, browserConfig: BrowserConfig): Promise<void> {
  await context.setExtraHTTPHeaders({
    "accept-language": browserConfig.acceptLanguage
  });

  if (!browserConfig.maskAutomation) {
    return;
  }

  await context.addInitScript(
    ({ locale, platform }) => {
      Object.defineProperty(navigator, "webdriver", { get: () => false });
      Object.defineProperty(navigator, "platform", { get: () => platform });
      Object.defineProperty(navigator, "language", { get: () => locale });
      Object.defineProperty(navigator, "languages", { get: () => [locale, "en"] });
    },
    {
      locale: browserConfig.locale,
      platform: browserConfig.platform
    }
  );
}

export async function applyBrowserIdentityOnce(context: BrowserIdentityTarget, browserConfig: BrowserConfig): Promise<void> {
  if (identityConfiguredContexts.has(context)) {
    return;
  }

  await applyBrowserIdentity(context, browserConfig);
  identityConfiguredContexts.add(context);
}

function applyBrowserDefaults(page: Page, browserConfig: BrowserConfig): void {
  page.setDefaultNavigationTimeout(browserConfig.navigationTimeoutMs);
  page.setDefaultTimeout(browserConfig.navigationTimeoutMs);
}

export function buildLaunchArgs(browserConfig: BrowserConfig): string[] {
  const args = [...browserConfig.launchArgs];

  if (!args.some((value) => value.startsWith("--lang="))) {
    args.push(`--lang=${browserConfig.locale}`);
  }

  if (!args.some((value) => value.startsWith("--window-size="))) {
    args.push(`--window-size=${browserConfig.viewportWidth},${browserConfig.viewportHeight}`);
  }

  if (browserConfig.maskAutomation && !args.includes("--disable-blink-features=AutomationControlled")) {
    args.push("--disable-blink-features=AutomationControlled");
  }

  if (!args.includes("--deny-permission-prompts")) {
    args.push("--deny-permission-prompts");
  }

  return args;
}

export async function navigateLikeUser(page: Page, url: string): Promise<void> {
  const config = await getProjectConfig();
  const quietWindowTimeoutMs = Math.min(Math.max(config.browser.stabilityDelayMs + 500, 2_000), 5_000);
  await humanDelay();
  const response = await page
    .goto(url, {
      waitUntil: "domcontentloaded",
      timeout: config.browser.navigationTimeoutMs
    })
    .catch((error) => {
      const message = error instanceof Error ? error.message : "Navigation failed.";
      throw createNavigationFailure(message);
    });
  const headers = (await response?.allHeaders().catch(() => undefined)) ?? {};

  await assertHealthyNavigation(page, response?.status(), headers["retry-after"]);
  await page.waitForLoadState("networkidle", { timeout: quietWindowTimeoutMs }).catch(() => undefined);
  await assertHealthyNavigation(page, response?.status(), headers["retry-after"]);
  await humanDelay();
}

export async function humanDelay(): Promise<void> {
  const config = await getProjectConfig();
  const min = config.browser.minHumanDelayMs;
  const max = Math.max(min, config.browser.maxHumanDelayMs);
  const duration = min + Math.floor(Math.random() * (max - min + 1));
  await new Promise((resolve) => setTimeout(resolve, duration));
}

export async function clearAndType(page: Page, selector: string, value: string, typeDelayMs = 15): Promise<void> {
  const locator = page.locator(selector);
  await locator.waitFor({ timeout: 30_000 });
  await locator.click({ clickCount: 3 });
  await locator.fill("");
  await humanDelay();
  await locator.type(value, { delay: typeDelayMs });
}

async function getBrowser(options: BrowserPageOptions, browserConfig: BrowserConfig): Promise<Browser> {
  const key = browserKey(options);
  const existing = browserPromises.get(key);
  if (existing) {
    return existing;
  }

  const created = launchBrowser(options, browserConfig, key).catch((error) => {
    browserPromises.delete(key);
    throw error;
  });

  browserPromises.set(key, created);
  return created;
}

async function launchBrowser(options: BrowserPageOptions, browserConfig: BrowserConfig, key: string): Promise<Browser> {
  const launchArgs = buildLaunchArgs(browserConfig);
  const ignoreDefaultArgs = browserConfig.maskAutomation ? ["--enable-automation"] : undefined;
  const launchProfile = resolveLaunchProfile(options, browserConfig);
  const browser = await chromium.launch({
    args: launchArgs,
    channel: launchProfile.channel,
    headless: launchProfile.headless,
    ignoreDefaultArgs,
    timeout: browserConfig.protocolTimeoutMs
  });

  attachBrowserLifecycle(browser, key);
  return browser;
}

export function resolveLaunchProfile(options: BrowserPageOptions, browserConfig: BrowserConfig): BrowserLaunchProfile {
  if (options.retailer === "coles" || options.retailer === "woolworths") {
    return {
      headless: false,
      channel: "chrome"
    };
  }

  return {
    headless: browserConfig.headless
  };
}

async function getRetailerContext(browser: Browser, options: BrowserPageOptions, browserConfig: BrowserConfig): Promise<BrowserContext> {
  const key = contextKey(options.retailer, options.location);
  const existing = contextPromises.get(key);
  if (existing) {
    return existing;
  }

  const created = createBrowserContext(browser, options, browserConfig).catch((error) => {
    contextPromises.delete(key);
    throw error;
  });

  contextPromises.set(key, created);
  return created;
}

async function createBrowserContext(browser: Browser, options: BrowserPageOptions, browserConfig: BrowserConfig): Promise<BrowserContext> {
  const context = await browser.newContext(buildBrowserContextOptions(browserConfig));
  await configureBrowserContext(context, options, browserConfig);
  return context;
}

async function configureBrowserContext(context: BrowserContext, options: BrowserPageOptions, browserConfig: BrowserConfig): Promise<void> {
  await applyBrowserIdentityOnce(context, browserConfig);

  if (!browserConfig.blockResourceTypes.length || options.retailer === "coles") {
    return;
  }

  await context.route("**/*", (route) => handleRoute(route, browserConfig.blockResourceTypes));
}

async function handleRoute(route: Route, blockedResourceTypes: string[]): Promise<void> {
  if (blockedResourceTypes.includes(route.request().resourceType())) {
    await route.abort();
    return;
  }

  await route.continue();
}

async function getRetailerPage(context: BrowserContext, options: BrowserPageOptions): Promise<Page> {
  const key = contextKey(options.retailer, options.location);
  const existing = pagePromises.get(key);
  if (existing) {
    return existing;
  }

  const created = (async () => {
    const pages = context.pages();
    const page = pages.find((candidate) => !candidate.isClosed()) ?? (await context.newPage());
    page.on("close", () => {
      pagePromises.delete(key);
    });
    return page;
  })().catch((error) => {
    pagePromises.delete(key);
    throw error;
  });

  pagePromises.set(key, created);
  return created;
}

function contextKey(retailer: RetailerId, location?: LocationContext): string {
  return [retailer, location?.postcode ?? "default", location?.suburb ?? "default", location?.storeId ?? "default"].join(":");
}

function browserKey(options: BrowserPageOptions): string {
  return options.retailer;
}

function attachBrowserLifecycle(browser: Browser, key: string): void {
  browser.on("disconnected", () => {
    browserPromises.delete(key);
    contextPromises.clear();
    pagePromises.clear();
  });

  if (cleanupRegistered) {
    return;
  }

  cleanupRegistered = true;
  const dispose = () => {
    void closeBrowsers();
  };

  process.once("beforeExit", dispose);
  process.once("SIGINT", dispose);
  process.once("SIGTERM", dispose);
}

async function closeBrowsers(): Promise<void> {
  const activeBrowsers = await Promise.all(Array.from(browserPromises.values()).map((promise) => promise.catch(() => undefined)));
  browserPromises.clear();
  contextPromises.clear();
  pagePromises.clear();
  await Promise.all(activeBrowsers.map((browser) => browser?.close().catch(() => undefined)));
}

async function assertHealthyNavigation(page: Page, statusCode?: number, retryAfterHeader?: string): Promise<void> {
  if (statusCode === 429) {
    throw createRateLimitFailure("Retailer responded with HTTP 429 Too Many Requests.", parseRetryAfter(retryAfterHeader));
  }

  if (statusCode != null && [403, 503].includes(statusCode)) {
    throw createChallengeFailure(`Retailer responded with HTTP ${statusCode}, likely indicating throttling or a bot challenge.`);
  }

  const pageText = await page
    .evaluate(() => document.body?.innerText?.slice(0, 5000) ?? "")
    .catch(() => "");
  const interruption = classifyNavigationInterruption(pageText);

  if (interruption?.kind === "rate-limit") {
    throw createRateLimitFailure(interruption.message, parseRetryAfter(retryAfterHeader), interruption.diagnostics);
  }

  if (interruption?.kind === "challenge") {
    throw createChallengeFailure(interruption.message, interruption.diagnostics);
  }
}

type NavigationInterruption = {
  kind: "rate-limit" | "challenge";
  message: string;
  diagnostics: string[];
};

export function classifyNavigationInterruption(pageText: string): NavigationInterruption | undefined {
  const normalized = pageText.toLowerCase();

  if (
    normalized.includes("too many requests") ||
    normalized.includes("rate limit") ||
    normalized.includes("unusual traffic") ||
    normalized.includes("automated queries")
  ) {
    return {
      kind: "rate-limit",
      message: "Retailer page indicates rate limiting or unusual traffic.",
      diagnostics: ["Detected retailer copy associated with rate limiting or automated-traffic throttling."]
    };
  }

  if (
    normalized.includes("captcha") ||
    normalized.includes("verify you are human") ||
    normalized.includes("access denied") ||
    normalized.includes("bot detection") ||
    normalized.includes("security check") ||
    normalized.includes("pardon our interruption") ||
    normalized.includes("made us think you were a bot") ||
    normalized.includes("please stand by") ||
    normalized.includes("make sure that cookies and javascript are enabled before reloading")
  ) {
    return {
      kind: "challenge",
      message: "Retailer page indicates an anti-bot challenge or access block.",
      diagnostics: ["Detected retailer anti-bot interstitial copy in the loaded page."]
    };
  }

  return undefined;
}
