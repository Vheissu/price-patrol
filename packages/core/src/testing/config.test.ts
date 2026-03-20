import { describe, expect, it } from "vitest";
import { parseProjectConfig } from "../config/project-config.js";

describe("config schema defaults", () => {
  it("fills missing values with safe defaults", () => {
    const config = parseProjectConfig({});
    expect(config.browser.headless).toBe(true);
    expect(config.browser.protocolTimeoutMs).toBe(120_000);
    expect(config.browser.minHumanDelayMs).toBe(150);
    expect(config.cache.liveScrapeEnabled).toBe(true);
    expect(config.cache.useHistoricalFallbackOnFailure).toBe(true);
    expect(config.resilience.maxAttempts).toBe(3);
    expect(config.retailers.coles.maxResults).toBe(24);
    expect(config.retailers.aldi.liveScrape).toBe(true);
  });

  it("accepts the legacy fallback key and maps it to the historical fallback setting", () => {
    const config = parseProjectConfig({
      cache: {
        useFixturesOnFailure: false
      }
    });

    expect(config.cache.useHistoricalFallbackOnFailure).toBe(false);
  });
});
