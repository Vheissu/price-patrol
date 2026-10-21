import { getProjectConfig } from "../../config/project-config.js";
import { CircuitState, RetailerId } from "../../types/domain.js";

type ScrapeFailureKind = "rate-limit" | "challenge" | "navigation" | "cooldown" | "circuit-open" | "timeout" | "unknown";

type ScrapeFailureOptions = {
  kind: ScrapeFailureKind;
  retryable?: boolean;
  retryAfterMs?: number;
  diagnostics?: string[];
};

type RunWithResilienceOptions = {
  retailer: RetailerId;
  task: () => Promise<unknown>;
};

type SemaphoreState = {
  active: number;
  queue: Array<() => void>;
};

type CircuitRecord = {
  consecutiveFailures: number;
  openUntil?: number;
  halfOpen: boolean;
};

export type RetailerResilienceState = {
  consecutiveFailures: number;
  circuitState: CircuitState;
  circuitOpenUntil?: string;
  cooldownUntil?: string;
};

const cooldowns = new Map<RetailerId, number>();
const semaphores = new Map<RetailerId, SemaphoreState>();
const circuits = new Map<RetailerId, CircuitRecord>();

export class ScrapeFailure extends Error {
  readonly kind: ScrapeFailureKind;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
  readonly diagnostics: string[];

  constructor(message: string, options: ScrapeFailureOptions) {
    super(message);
    this.name = "ScrapeFailure";
    this.kind = options.kind;
    this.retryable = options.retryable ?? false;
    this.retryAfterMs = options.retryAfterMs;
    this.diagnostics = options.diagnostics ?? [];
  }
}

export async function runWithResilience<T>({ retailer, task }: RunWithResilienceOptions): Promise<T> {
  const config = await getProjectConfig();
  const policy = config.resilience;

  return withRetailerPermit(retailer, policy.maxConcurrentRetailerTasks, async () => {
    assertCircuitAllowsAttempt(retailer);

    let lastFailure: ScrapeFailure | undefined;

    for (let attempt = 1; attempt <= policy.maxAttempts; attempt += 1) {
      await waitForCooldown(retailer);

      try {
        const result = (await withAttemptTimeout(task(), policy.attemptTimeoutMs, attempt)) as T;
        recordCircuitSuccess(retailer);
        return result;
      } catch (error) {
        lastFailure = asScrapeFailure(error);
        const backoffMs = computeBackoffMs(
          attempt,
          lastFailure.retryAfterMs,
          policy.baseBackoffMs,
          policy.maxBackoffMs,
          policy.jitterMs
        );

        if (lastFailure.kind === "rate-limit" || lastFailure.kind === "challenge") {
          cooldowns.set(retailer, Date.now() + Math.max(policy.cooldownMs, backoffMs));
          break;
        }

        if (!lastFailure.retryable || attempt >= policy.maxAttempts) {
          break;
        }

        await sleep(backoffMs);
      }
    }

    const failure = lastFailure ?? new ScrapeFailure("Unknown scraping failure.", { kind: "unknown" });
    if (failure.kind !== "cooldown" && failure.kind !== "circuit-open") {
      recordCircuitFailure(retailer, policy.circuitBreakerFailureThreshold, policy.circuitBreakerOpenMs);
    }
    throw failure;
  });
}

export function createRateLimitFailure(message: string, retryAfterMs?: number, diagnostics?: string[]): ScrapeFailure {
  return new ScrapeFailure(message, {
    kind: "rate-limit",
    retryable: true,
    retryAfterMs,
    diagnostics
  });
}

export function createChallengeFailure(message: string, diagnostics?: string[]): ScrapeFailure {
  return new ScrapeFailure(message, {
    kind: "challenge",
    retryable: true,
    diagnostics
  });
}

export function createNavigationFailure(message: string, diagnostics?: string[]): ScrapeFailure {
  return new ScrapeFailure(message, {
    kind: "navigation",
    retryable: true,
    diagnostics
  });
}

export function createTimeoutFailure(message: string, diagnostics?: string[]): ScrapeFailure {
  return new ScrapeFailure(message, {
    kind: "timeout",
    retryable: true,
    diagnostics
  });
}

export function createCooldownFailure(message: string, retryAfterMs?: number, diagnostics?: string[]): ScrapeFailure {
  return new ScrapeFailure(message, {
    kind: "cooldown",
    retryable: false,
    retryAfterMs,
    diagnostics
  });
}

export function createCircuitOpenFailure(message: string, retryAfterMs?: number, diagnostics?: string[]): ScrapeFailure {
  return new ScrapeFailure(message, {
    kind: "circuit-open",
    retryable: false,
    retryAfterMs,
    diagnostics
  });
}

export function asScrapeFailure(error: unknown): ScrapeFailure {
  if (error instanceof ScrapeFailure) {
    return error;
  }

  if (error instanceof Error) {
    const message = error.message;
    // Playwright surfaces its own timeouts and protocol-level disconnects as plain errors.
    // Treat those as transient so the retry policy gets a chance to recover.
    if (/timeout \d+ms exceeded|Target page, context or browser has been closed|net::ERR_|browser has been closed|Protocol error/i.test(message)) {
      return new ScrapeFailure(message, {
        kind: "navigation",
        retryable: true
      });
    }

    return new ScrapeFailure(message, {
      kind: "unknown",
      retryable: false
    });
  }

  return new ScrapeFailure("Unknown scraping failure.", {
    kind: "unknown",
    retryable: false
  });
}

export function parseRetryAfter(value: string | null | undefined): number | undefined {
  if (!value) {
    return undefined;
  }

  const asSeconds = Number(value);
  if (Number.isFinite(asSeconds) && asSeconds > 0) {
    return asSeconds * 1000;
  }

  const asDate = Date.parse(value);
  if (!Number.isNaN(asDate)) {
    return Math.max(0, asDate - Date.now());
  }

  return undefined;
}

export function getRetailerResilienceState(retailer: RetailerId, now = Date.now()): RetailerResilienceState {
  const circuit = circuits.get(retailer);
  const cooldownUntil = cooldowns.get(retailer);
  const circuitOpen = circuit?.openUntil != null && circuit.openUntil > now;
  const circuitProbing = Boolean(circuit?.halfOpen) || (circuit?.openUntil != null && !circuitOpen);
  const circuitState: CircuitState = circuitOpen ? "open" : circuitProbing ? "half-open" : "closed";

  return {
    consecutiveFailures: circuit?.consecutiveFailures ?? 0,
    circuitState,
    circuitOpenUntil: circuitOpen ? new Date(circuit.openUntil as number).toISOString() : undefined,
    cooldownUntil: cooldownUntil != null && cooldownUntil > now ? new Date(cooldownUntil).toISOString() : undefined
  };
}

export function resetRetailerResilienceState(retailer?: RetailerId): void {
  if (retailer) {
    cooldowns.delete(retailer);
    circuits.delete(retailer);
    return;
  }

  cooldowns.clear();
  circuits.clear();
}

function assertCircuitAllowsAttempt(retailer: RetailerId): void {
  const circuit = circuits.get(retailer);
  if (!circuit?.openUntil) {
    return;
  }

  const remainingMs = circuit.openUntil - Date.now();
  if (remainingMs > 0) {
    throw createCircuitOpenFailure(
      `Retailer live scraping is paused after ${circuit.consecutiveFailures} consecutive failures. Retry after ${Math.ceil(remainingMs / 1000)}s.`,
      remainingMs,
      ["Skipped live scrape because the retailer circuit breaker is open."]
    );
  }

  // The open window has elapsed: allow a single probe attempt through.
  circuit.openUntil = undefined;
  circuit.halfOpen = true;
}

function recordCircuitSuccess(retailer: RetailerId): void {
  circuits.delete(retailer);
}

function recordCircuitFailure(retailer: RetailerId, threshold: number, openMs: number): void {
  const circuit = circuits.get(retailer) ?? { consecutiveFailures: 0, halfOpen: false };
  circuit.consecutiveFailures += 1;

  if (circuit.halfOpen || circuit.consecutiveFailures >= threshold) {
    circuit.openUntil = Date.now() + openMs;
    circuit.halfOpen = false;
  }

  circuits.set(retailer, circuit);
}

async function waitForCooldown(retailer: RetailerId): Promise<void> {
  const cooldownUntil = cooldowns.get(retailer);
  if (!cooldownUntil) {
    return;
  }

  const remainingMs = cooldownUntil - Date.now();
  if (remainingMs <= 0) {
    cooldowns.delete(retailer);
    return;
  }

  throw createCooldownFailure(
    `Retailer is cooling down after a recent anti-bot or rate-limit response. Retry after ${Math.ceil(remainingMs / 1000)}s.`,
    remainingMs,
    ["Skipped live scrape because the retailer is in a configured cooldown window."]
  );
}

async function withRetailerPermit<T>(retailer: RetailerId, limit: number, task: () => Promise<T>): Promise<T> {
  const state = semaphores.get(retailer) ?? { active: 0, queue: [] };
  semaphores.set(retailer, state);

  if (state.active >= limit) {
    await new Promise<void>((resolve) => state.queue.push(resolve));
  }

  state.active += 1;
  try {
    return await task();
  } finally {
    state.active -= 1;
    const next = state.queue.shift();
    if (next) {
      next();
    }
  }
}

async function withAttemptTimeout<T>(promise: Promise<T>, timeoutMs: number, attempt: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(
        createTimeoutFailure(`Live scrape attempt ${attempt} exceeded the ${Math.round(timeoutMs / 1000)}s attempt deadline.`, [
          "Abandoned the attempt because it exceeded resilience.attemptTimeoutMs."
        ])
      );
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
    // Prevent an unhandled rejection if the original task fails after the deadline fired.
    promise.catch(() => undefined);
  }
}

function computeBackoffMs(attempt: number, retryAfterMs: number | undefined, baseBackoffMs: number, maxBackoffMs: number, jitterMs: number): number {
  const exponential = Math.min(maxBackoffMs, baseBackoffMs * 2 ** Math.max(0, attempt - 1));
  const baseDelay = retryAfterMs != null ? Math.min(maxBackoffMs, Math.max(retryAfterMs, exponential)) : exponential;
  const jitter = jitterMs > 0 ? Math.floor(Math.random() * (jitterMs + 1)) : 0;
  return Math.min(maxBackoffMs, baseDelay + jitter);
}

function sleep(durationMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, durationMs));
}
