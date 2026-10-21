import { existsSync } from "node:fs";
import { chromium } from "playwright";

export type BrowserRuntimeStatus = {
  ok: boolean;
  bundledChromiumPath?: string;
  bundledChromiumAvailable: boolean;
  googleChromeAvailable: boolean;
  problems: string[];
};

const CHROME_CANDIDATES: Record<string, string[]> = {
  darwin: ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"],
  linux: ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/opt/google/chrome/chrome"],
  win32: [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe"
  ]
};

/**
 * Coles and Woolworths are launched through the installed Google Chrome channel, ALDI through the
 * Playwright-managed Chromium build. A fresh clone is missing at least one of these more often than
 * not, so surface it up front instead of as a cryptic launch failure on the first comparison.
 */
export function checkBrowserRuntime(): BrowserRuntimeStatus {
  const problems: string[] = [];

  let bundledChromiumPath: string | undefined;
  try {
    bundledChromiumPath = chromium.executablePath();
  } catch {
    bundledChromiumPath = undefined;
  }
  const bundledChromiumAvailable = Boolean(bundledChromiumPath && existsSync(bundledChromiumPath));
  if (!bundledChromiumAvailable) {
    problems.push("Playwright Chromium is not installed; ALDI live scraping will fail. Run: npx playwright install chromium");
  }

  const candidates = CHROME_CANDIDATES[process.platform] ?? [];
  const googleChromeAvailable = candidates.some((candidate) => existsSync(candidate));
  if (!googleChromeAvailable) {
    problems.push("Google Chrome was not found in its default location; Coles and Woolworths live scraping use the Chrome channel and will fail.");
  }

  return {
    ok: problems.length === 0,
    bundledChromiumPath,
    bundledChromiumAvailable,
    googleChromeAvailable,
    problems
  };
}
