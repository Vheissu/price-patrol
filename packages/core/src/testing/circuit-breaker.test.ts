import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDefaultProjectConfig } from "../config/project-config.js";

vi.mock("../config/project-config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/project-config.js")>();
  return {
    ...actual,
    getProjectConfig: vi.fn(async () => currentConfig)
  };
});

let currentConfig = getDefaultProjectConfig();

const {
  asScrapeFailure,
  createNavigationFailure,
  createRateLimitFailure,
  getRetailerResilienceState,
  resetRetailerResilienceState,
  runWithResilience
} = await import("../adapters/shared/resilience.js");

function configure(overrides: Partial<ReturnType<typeof getDefaultProjectConfig>["resilience"]>): void {
  const base = getDefaultProjectConfig();
  currentConfig = {
    ...base,
    resilience: {
      ...base.resilience,
      maxAttempts: 1,
      baseBackoffMs: 1,
      maxBackoffMs: 2,
      jitterMs: 0,
      cooldownMs: 50,
      ...overrides
    }
  };
}

describe("circuit breaker", () => {
  beforeEach(() => {
    resetRetailerResilienceState();
    configure({ circuitBreakerFailureThreshold: 2, circuitBreakerOpenMs: 60_000 });
  });

  afterEach(() => {
    vi.useRealTimers();
    resetRetailerResilienceState();
  });

  it("opens after the configured number of consecutive failures and short-circuits further attempts", async () => {
    const task = vi.fn(async () => {
      throw createNavigationFailure("boom");
    });

    await expect(runWithResilience({ retailer: "aldi", task })).rejects.toMatchObject({ kind: "navigation" });
    await expect(runWithResilience({ retailer: "aldi", task })).rejects.toMatchObject({ kind: "navigation" });
    expect(getRetailerResilienceState("aldi").circuitState).toBe("open");

    await expect(runWithResilience({ retailer: "aldi", task })).rejects.toMatchObject({ kind: "circuit-open" });
    expect(task).toHaveBeenCalledTimes(2);
  });

  it("lets one probe through after the open window and closes again on success", async () => {
    vi.useFakeTimers();
    const failing = vi.fn(async () => {
      throw createNavigationFailure("boom");
    });

    await expect(runWithResilience({ retailer: "coles", task: failing })).rejects.toBeTruthy();
    await expect(runWithResilience({ retailer: "coles", task: failing })).rejects.toBeTruthy();
    expect(getRetailerResilienceState("coles").circuitState).toBe("open");

    vi.advanceTimersByTime(60_001);
    expect(getRetailerResilienceState("coles").circuitState).toBe("half-open");

    const succeeding = vi.fn(async () => "ok");
    await expect(runWithResilience({ retailer: "coles", task: succeeding })).resolves.toBe("ok");
    expect(getRetailerResilienceState("coles")).toMatchObject({ circuitState: "closed", consecutiveFailures: 0 });
  });

  it("re-opens immediately when the half-open probe fails", async () => {
    vi.useFakeTimers();
    const failing = vi.fn(async () => {
      throw createNavigationFailure("boom");
    });

    await expect(runWithResilience({ retailer: "woolworths", task: failing })).rejects.toBeTruthy();
    await expect(runWithResilience({ retailer: "woolworths", task: failing })).rejects.toBeTruthy();
    vi.advanceTimersByTime(60_001);

    await expect(runWithResilience({ retailer: "woolworths", task: failing })).rejects.toMatchObject({ kind: "navigation" });
    expect(getRetailerResilienceState("woolworths").circuitState).toBe("open");
    expect(failing).toHaveBeenCalledTimes(3);
  });

  it("does not count cooldown skips as circuit failures", async () => {
    const rateLimited = vi.fn(async () => {
      throw createRateLimitFailure("429", 50);
    });

    await expect(runWithResilience({ retailer: "aldi", task: rateLimited })).rejects.toMatchObject({ kind: "rate-limit" });
    expect(getRetailerResilienceState("aldi").consecutiveFailures).toBe(1);
    expect(getRetailerResilienceState("aldi").cooldownUntil).toBeDefined();

    await expect(runWithResilience({ retailer: "aldi", task: rateLimited })).rejects.toMatchObject({ kind: "cooldown" });
    expect(getRetailerResilienceState("aldi").consecutiveFailures).toBe(1);
    expect(getRetailerResilienceState("aldi").circuitState).toBe("closed");
  });

  it("abandons an attempt that exceeds the attempt deadline and retries", async () => {
    configure({ maxAttempts: 2, attemptTimeoutMs: 20, circuitBreakerFailureThreshold: 5 });
    let calls = 0;
    const task = vi.fn(async () => {
      calls += 1;
      if (calls === 1) {
        await new Promise((resolve) => setTimeout(resolve, 200));
        return "slow";
      }
      return "fast";
    });

    await expect(runWithResilience({ retailer: "aldi", task })).resolves.toBe("fast");
    expect(task).toHaveBeenCalledTimes(2);
  });

  it("surfaces a timeout failure when every attempt exceeds the deadline", async () => {
    configure({ maxAttempts: 1, attemptTimeoutMs: 10, circuitBreakerFailureThreshold: 5 });
    const task = vi.fn(() => new Promise<string>((resolve) => setTimeout(() => resolve("late"), 100)));

    await expect(runWithResilience({ retailer: "aldi", task })).rejects.toMatchObject({ kind: "timeout", retryable: true });
  });

  it("treats Playwright timeout and disconnect errors as retryable navigation failures", () => {
    expect(asScrapeFailure(new Error("page.goto: Timeout 60000ms exceeded."))).toMatchObject({ kind: "navigation", retryable: true });
    expect(asScrapeFailure(new Error("Target page, context or browser has been closed"))).toMatchObject({ kind: "navigation", retryable: true });
    expect(asScrapeFailure(new Error("Cannot read properties of undefined"))).toMatchObject({ kind: "unknown", retryable: false });
  });
});
