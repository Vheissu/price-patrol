import { existsSync } from "node:fs";
import { join } from "node:path";
import puppeteer, { Browser, BrowserContext, Page } from "puppeteer";
import { getProjectConfig, resolveProjectPath } from "../../config/project-config.js";
import { LocationContext, RetailerId } from "../../types/domain.js";
import { createChallengeFailure, createNavigationFailure, createRateLimitFailure, parseRetryAfter } from "./resilience.js";

type BrowserPageOptions = {
  retailer: RetailerId;
  location?: LocationContext;
};

let browserPromise: Promise<Browser> | undefined;
const browserPromises = new Map<string, Promise<Browser>>();
const contextPromises = new Map<string, Promise<BrowserContext>>();
const pagePromises = new Map<string, Promise<Page>>();
let cleanupRegistered = false;
let launchSequence = 0;

export async function withBrowserPage<T>(options: BrowserPageOptions, callback: (page: Page) => Promise<T>): Promise<T> {
  const config = await getProjectConfig();
  const browser = await getBrowser(options);
  const context = config.browser.reuseSessions ? await getRetailerContext(browser, options) : await browser.createBrowserContext();
  const shouldReusePage = config.browser.reuseSessions && options.retailer === "coles";
  const page = shouldReusePage ? await getRetailerPage(context, options) : await context.newPage();

  if (options.retailer !== "coles") {
    await page.setUserAgent(config.browser.userAgent);
    await page.setExtraHTTPHeaders({
      "accept-language": config.browser.acceptLanguage
    });
    await page.emulateTimezone(config.browser.timezone).catch(() => undefined);
  }

  await page.setViewport({ width: config.browser.viewportWidth, height: config.browser.viewportHeight });
  page.setDefaultNavigationTimeout(config.browser.navigationTimeoutMs);
  page.setDefaultTimeout(config.browser.navigationTimeoutMs);

  if (config.browser.blockResourceTypes.length && options.retailer !== "coles") {
    await page.setRequestInterception(true);
    page.on("request", (request) => {
      if (config.browser.blockResourceTypes.includes(request.resourceType())) {
        void request.abort();
        return;
      }
      void request.continue();
    });
  }

  if (config.browser.maskAutomation && options.retailer !== "coles") {
    await page.evaluateOnNewDocument(
      ({ locale, platform }) => {
        Object.defineProperty(navigator, "webdriver", { get: () => false });
        Object.defineProperty(navigator, "platform", { get: () => platform });
        Object.defineProperty(navigator, "language", { get: () => locale });
        Object.defineProperty(navigator, "languages", { get: () => [locale, "en"] });
      },
      {
        locale: config.browser.locale,
        platform: config.browser.platform
      }
    );
  }

  try {
    return await callback(page);
  } finally {
    page.removeAllListeners("request");
    if (!shouldReusePage) {
      await page.close();
    }
    if (!config.browser.reuseSessions && options.retailer !== "coles") {
      await context.close();
    }
  }
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

  await assertHealthyNavigation(page, response?.status(), response?.headers()["retry-after"]);
  await page.waitForNetworkIdle({
    idleTime: config.browser.stabilityDelayMs,
    timeout: quietWindowTimeoutMs
  }).catch(() => undefined);
  await assertHealthyNavigation(page, response?.status(), response?.headers()["retry-after"]);
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
  await page.waitForSelector(selector, { timeout: 30_000 });
  await page.click(selector, { clickCount: 3 });
  await page.$eval(selector, (element) => {
    const input = element as HTMLInputElement | HTMLTextAreaElement;
    input.value = "";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await humanDelay();
  await page.type(selector, value, { delay: typeDelayMs });
}

async function getBrowser(options: BrowserPageOptions): Promise<Browser> {
  const key = browserKey(options);
  const existing = browserPromises.get(key);
  if (existing) {
    return existing;
  }

  const created = launchBrowser(options, key).catch((error) => {
    browserPromises.delete(key);
    if (key === "shared") {
      browserPromise = undefined;
    }
    throw error;
  });

  browserPromises.set(key, created);
  if (key === "shared") {
    browserPromise = created;
  }
  return created;
}

async function launchBrowser(options: BrowserPageOptions, key: string): Promise<Browser> {
  const config = await getProjectConfig();
  const preferredUserDataDir = resolveBrowserUserDataDir(config.browser.userDataDir, options);
  const initialUserDataDir = hasProfileLockArtifacts(preferredUserDataDir)
    ? createRunUserDataDir(preferredUserDataDir)
    : preferredUserDataDir;

  try {
    const browser = await puppeteer.launch({
      headless: config.browser.headless,
      args: config.browser.launchArgs,
      userDataDir: initialUserDataDir
    });
    attachBrowserLifecycle(browser, key);
    return browser;
  } catch (error) {
    if (!isProfileLockError(error) || initialUserDataDir !== preferredUserDataDir) {
      throw error;
    }

    const fallbackUserDataDir = createRunUserDataDir(preferredUserDataDir);
    const browser = await puppeteer.launch({
      headless: config.browser.headless,
      args: config.browser.launchArgs,
      userDataDir: fallbackUserDataDir
    });
    attachBrowserLifecycle(browser, key);
    return browser;
  }
}

async function getRetailerContext(browser: Browser, options: BrowserPageOptions): Promise<BrowserContext> {
  if (options.retailer === "coles") {
    return browser.defaultBrowserContext();
  }

  const key = contextKey(options.retailer, options.location);
  const existing = contextPromises.get(key);
  if (existing) {
    return existing;
  }

  const created = browser.createBrowserContext();
  contextPromises.set(key, created);
  return created;
}

async function getRetailerPage(context: BrowserContext, options: BrowserPageOptions): Promise<Page> {
  const key = contextKey(options.retailer, options.location);
  const existing = pagePromises.get(key);
  if (existing) {
    return existing;
  }

  const created = (async () => {
    const pages = await context.pages();
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
  return options.retailer === "coles" ? "coles" : "shared";
}

function resolveBrowserUserDataDir(configuredPath: string, options: BrowserPageOptions): string {
  const basePath = resolveProjectPath(configuredPath);
  if (options.retailer === "coles") {
    return `${basePath}-coles`;
  }
  const profile = process.env.PRICE_PATROL_BROWSER_PROFILE?.trim();
  return profile ? join(basePath, `${profile}-${process.pid}`) : basePath;
}

function createRunUserDataDir(preferredUserDataDir: string): string {
  launchSequence += 1;
  return `${preferredUserDataDir}-run-${process.pid}-${Date.now()}-${launchSequence}`;
}

function hasProfileLockArtifacts(userDataDir: string): boolean {
  return ["SingletonLock", "SingletonSocket", "SingletonCookie", "DevToolsActivePort"].some((name) =>
    existsSync(join(userDataDir, name))
  );
}

function isProfileLockError(error: unknown): error is Error {
  if (!(error instanceof Error)) {
    return false;
  }

  const message = error.message.toLowerCase();
  return message.includes("browser is already running for") || message.includes("userdatadir") || message.includes("singletonlock");
}

function attachBrowserLifecycle(browser: Browser, key: string): void {
  browser.on("disconnected", () => {
    browserPromises.delete(key);
    if (key === "shared") {
      browserPromise = undefined;
    }
    contextPromises.clear();
    pagePromises.clear();
  });

  if (cleanupRegistered) {
    return;
  }

  cleanupRegistered = true;
  const dispose = () => {
    void closeBrowser();
  };

  process.once("beforeExit", dispose);
  process.once("SIGINT", dispose);
  process.once("SIGTERM", dispose);
}

async function closeBrowser(): Promise<void> {
  const activeBrowsers = await Promise.all(Array.from(browserPromises.values()).map((promise) => promise.catch(() => undefined)));
  browserPromise = undefined;
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
