import { describe, expect, it } from "vitest";
import { classifyNavigationInterruption } from "../adapters/shared/browser.js";
import { asScrapeFailure, createCooldownFailure, createRateLimitFailure, parseRetryAfter } from "../adapters/shared/resilience.js";

describe("resilience helpers", () => {
  it("parses retry-after seconds", () => {
    expect(parseRetryAfter("12")).toBe(12_000);
  });

  it("preserves scrape failure metadata", () => {
    const failure = createRateLimitFailure("Too many requests", 5_000);
    const wrapped = asScrapeFailure(failure);

    expect(wrapped.kind).toBe("rate-limit");
    expect(wrapped.retryable).toBe(true);
    expect(wrapped.retryAfterMs).toBe(5_000);
  });

  it("classifies anti-bot interstitial copy as a challenge", () => {
    const interruption = classifyNavigationInterruption(
      "Pardon Our Interruption. Something about your browser made us think you were a bot. Please stand by."
    );

    expect(interruption?.kind).toBe("challenge");
  });

  it("marks cooldown failures as non-retryable", () => {
    const failure = createCooldownFailure("Cooling down", 30_000);
    const wrapped = asScrapeFailure(failure);

    expect(wrapped.kind).toBe("cooldown");
    expect(wrapped.retryable).toBe(false);
    expect(wrapped.retryAfterMs).toBe(30_000);
  });
});
