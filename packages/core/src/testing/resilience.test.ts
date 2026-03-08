import { describe, expect, it } from "vitest";
import { asScrapeFailure, createRateLimitFailure, parseRetryAfter } from "../adapters/shared/resilience.js";

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
});
