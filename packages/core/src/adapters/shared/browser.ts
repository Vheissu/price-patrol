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
const contextPromises = new Map<string, Promise<BrowserContext>>();
let cleanupRegistered = false;

export async function withBrowserPage<T>(options: BrowserPageOptions, callback: (page: Page) => Promise<T>): Promise<T> {
  const config = await getProjectConfig();
  const browser = await getBrowser();
  const context = config.browser.reuseSessions ? await getRetailerContext(browser, options) : await browser.createBrowserContext();
  const page = await context.newPage();

  await page.setUserAgent(config.browser.userAgent);
  await page.setViewport({ width: config.browser.viewportWidth, height: config.browser.viewportHeight });
  await page.emulateTimezone(config.browser.timezone).catch(() => undefined);
  page.setDefaultNavigationTimeout(config.browser.navigationTimeoutMs);
  page.setDefaultTimeout(config.browser.navigationTimeoutMs);
  await page.setExtraHTTPHeaders({
    "accept-language": config.browser.acceptLanguage
  });

  if (config.browser.blockResourceTypes.length) {
    await page.setRequestInterception(true);
    page.on("request", (request) => {
      if (config.browser.blockResourceTypes.includes(request.resourceType())) {
        void request.abort();
        return;
      }
      void request.continue();
    });
  }

  if (config.browser.maskAutomation) {
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
    await page.close();
    if (!config.browser.reuseSessions) {
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

async function getBrowser(): Promise<Browser> {
  if (!browserPromise) {
    browserPromise = launchBrowser().catch((error) => {
      browserPromise = undefined;
      throw error;
    });
  }
  return browserPromise;
}

async function launchBrowser(): Promise<Browser> {
  const config = await getProjectConfig();
  const preferredUserDataDir = resolveBrowserUserDataDir(config.browser.userDataDir);
  const initialUserDataDir = hasProfileLockArtifacts(preferredUserDataDir)
    ? `${preferredUserDataDir}-run-${process.pid}`
    : preferredUserDataDir;

  try {
    const browser = await puppeteer.launch({
      headless: config.browser.headless,
      args: config.browser.launchArgs,
      userDataDir: initialUserDataDir
    });
    attachBrowserLifecycle(browser);
    return browser;
  } catch (error) {
    if (!isProfileLockError(error) || initialUserDataDir !== preferredUserDataDir) {
      throw error;
    }

    const fallbackUserDataDir = `${preferredUserDataDir}-run-${process.pid}`;
    const browser = await puppeteer.launch({
      headless: config.browser.headless,
      args: config.browser.launchArgs,
      userDataDir: fallbackUserDataDir
    });
    attachBrowserLifecycle(browser);
    return browser;
  }
}

async function getRetailerContext(browser: Browser, options: BrowserPageOptions): Promise<BrowserContext> {
  const key = contextKey(options.retailer, options.location);
  const existing = contextPromises.get(key);
  if (existing) {
    return existing;
  }

  const created = browser.createBrowserContext();
  contextPromises.set(key, created);
  return created;
}

function contextKey(retailer: RetailerId, location?: LocationContext): string {
  return [retailer, location?.postcode ?? "default", location?.suburb ?? "default", location?.storeId ?? "default"].join(":");
}

function resolveBrowserUserDataDir(configuredPath: string): string {
  const basePath = resolveProjectPath(configuredPath);
  const profile = process.env.PRICE_PATROL_BROWSER_PROFILE?.trim();
  return profile ? join(basePath, `${profile}-${process.pid}`) : basePath;
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

function attachBrowserLifecycle(browser: Browser): void {
  browser.on("disconnected", () => {
    browserPromise = undefined;
    contextPromises.clear();
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
  const activeBrowser = await browserPromise?.catch(() => undefined);
  browserPromise = undefined;
  contextPromises.clear();
  await activeBrowser?.close().catch(() => undefined);
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
  const normalized = pageText.toLowerCase();

  if (
    normalized.includes("too many requests") ||
    normalized.includes("rate limit") ||
    normalized.includes("unusual traffic")
  ) {
    throw createRateLimitFailure("Retailer page indicates rate limiting or unusual traffic.", parseRetryAfter(retryAfterHeader));
  }

  if (
    normalized.includes("captcha") ||
    normalized.includes("verify you are human") ||
    normalized.includes("access denied") ||
    normalized.includes("bot detection") ||
    normalized.includes("security check")
  ) {
    throw createChallengeFailure("Retailer page indicates a bot challenge or access block.");
  }
}
