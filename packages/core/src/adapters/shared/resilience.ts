import { getProjectConfig } from "../../config/project-config.js";
import { RetailerId } from "../../types/domain.js";

type ScrapeFailureKind = "rate-limit" | "challenge" | "navigation" | "cooldown" | "unknown";

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

const cooldowns = new Map<RetailerId, number>();
const semaphores = new Map<RetailerId, SemaphoreState>();

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
    let lastFailure: ScrapeFailure | undefined;

    for (let attempt = 1; attempt <= policy.maxAttempts; attempt += 1) {
      await waitForCooldown(retailer);

      try {
        return (await task()) as T;
      } catch (error) {
        lastFailure = asScrapeFailure(error);
        if (!lastFailure.retryable || attempt >= policy.maxAttempts) {
          throw lastFailure;
        }

        const backoffMs = computeBackoffMs(
          attempt,
          lastFailure.retryAfterMs,
          policy.baseBackoffMs,
          policy.maxBackoffMs,
          policy.jitterMs
        );
        if (lastFailure.kind === "rate-limit" || lastFailure.kind === "challenge") {
          cooldowns.set(retailer, Date.now() + Math.max(policy.cooldownMs, backoffMs));
        }

        await sleep(backoffMs);
      }
    }

    throw lastFailure ?? new ScrapeFailure("Unknown scraping failure.", { kind: "unknown" });
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

export function asScrapeFailure(error: unknown): ScrapeFailure {
  if (error instanceof ScrapeFailure) {
    return error;
  }

  if (error instanceof Error) {
    return new ScrapeFailure(error.message, {
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

  await sleep(remainingMs);
  cooldowns.delete(retailer);
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

function computeBackoffMs(attempt: number, retryAfterMs: number | undefined, baseBackoffMs: number, maxBackoffMs: number, jitterMs: number): number {
  const exponential = Math.min(maxBackoffMs, baseBackoffMs * 2 ** Math.max(0, attempt - 1));
  const baseDelay = retryAfterMs != null ? Math.min(maxBackoffMs, Math.max(retryAfterMs, exponential)) : exponential;
  const jitter = jitterMs > 0 ? Math.floor(Math.random() * (jitterMs + 1)) : 0;
  return Math.min(maxBackoffMs, baseDelay + jitter);
}

function sleep(durationMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, durationMs));
}
