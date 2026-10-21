import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BaseRetailerAdapter } from "../adapters/base.js";
import { resetRetailerResilienceState } from "../adapters/shared/resilience.js";
import { parseSearchIntent } from "../parsing/query.js";
import type { NormalizedProduct, SearchIntent, SearchOptions } from "../types/domain.js";

const cacheStore = new Map<string, unknown>();

vi.mock("../cache/sqlite-cache.js", () => ({
  SqliteCache: class {
    async get<T>(key: string): Promise<T | null> {
      return (cacheStore.get(key) as T | undefined) ?? null;
    }
    async set<T>(key: string, value: T): Promise<void> {
      cacheStore.set(key, value);
    }
  }
}));

vi.mock("../adapters/shared/historical-catalog.js", () => ({
  getHistoricalFallbackProducts: () => []
}));

const now = new Date().toISOString();

function product(id: string, name: string): NormalizedProduct {
  return {
    id,
    retailer: "aldi",
    sourceUrl: "https://example.test/p",
    sourceType: "network",
    canonicalDisplayName: name,
    rawName: name,
    categoryPath: [],
    structuredAttributes: [],
    shelfPrice: 2,
    effectiveComparisonPrice: 2,
    currency: "AUD",
    priceScope: "store",
    priceConfidence: 0.8,
    availabilityState: "in-stock",
    availabilityConfidence: 0.8,
    lowStock: false,
    lastFetchedAt: now,
    lastParsedAt: now,
    sourceSnapshotAt: now,
    freshness: "fresh",
    notes: [],
    warnings: []
  };
}

class CountingAdapter extends BaseRetailerAdapter {
  liveCalls = 0;
  private release: (() => void) | undefined;
  private readonly gate = new Promise<void>((resolve) => {
    this.release = resolve;
  });
  private signalEntered: (() => void) | undefined;
  readonly entered = new Promise<void>((resolve) => {
    this.signalEntered = resolve;
  });

  constructor() {
    super("aldi");
  }

  /** Lets the in-progress live search finish. Safe to call before the search has started. */
  finishLiveSearch(): void {
    this.release?.();
  }

  protected async searchLive(_intent: SearchIntent, _options: SearchOptions): Promise<NormalizedProduct[]> {
    this.liveCalls += 1;
    this.signalEntered?.();
    await this.gate;
    return [product("aldi:milk", "Farmdale Full Cream Milk 2L")];
  }
}

describe("BaseRetailerAdapter", () => {
  beforeEach(() => {
    cacheStore.clear();
    resetRetailerResilienceState();
  });

  afterEach(() => {
    resetRetailerResilienceState();
  });

  it("coalesces identical concurrent searches into a single live scrape", async () => {
    const adapter = new CountingAdapter();
    const intent = parseSearchIntent("full cream milk 2l", "equivalent");

    const first = adapter.search(intent, { allowLiveScrape: true, location: { postcode: "4350" } });
    const second = adapter.search(intent, { allowLiveScrape: true, location: { postcode: "4350" } });
    await adapter.entered;
    adapter.finishLiveSearch();

    const [a, b] = await Promise.all([first, second]);
    expect(adapter.liveCalls).toBe(1);
    expect(a.products).toHaveLength(1);
    expect(b).toBe(a);
  });

  it("serves the cached result once a healthy live search completes", async () => {
    const adapter = new CountingAdapter();
    const intent = parseSearchIntent("full cream milk 2l", "equivalent");

    const pending = adapter.search(intent, { allowLiveScrape: true });
    await adapter.entered;
    adapter.finishLiveSearch();
    await pending;

    const cached = await adapter.search(intent, { allowLiveScrape: true });
    expect(adapter.liveCalls).toBe(1);
    expect(cached.products[0]?.id).toBe("aldi:milk");
  });

  it("reports circuit and cooldown state through getHealth", () => {
    const adapter = new CountingAdapter();
    expect(adapter.getHealth()).toMatchObject({ retailer: "aldi", circuitState: "closed", consecutiveFailures: 0 });
  });
});
