import { resolve } from "aurelia";

export type CompareMode = "exact" | "equivalent" | "best-value";

export interface CompareItemInput {
  query: string;
  mode: CompareMode;
  postcode?: string;
  suburb?: string;
  allowLiveScrape?: boolean;
}

export interface BasketLineInput {
  id: string;
  query: string;
  quantity?: number;
}

export interface BasketCompareInput {
  mode: CompareMode;
  postcode?: string;
  suburb?: string;
  items: BasketLineInput[];
  allowLiveScrape?: boolean;
}

export interface LocationContext {
  postcode?: string;
  suburb?: string;
  storeName?: string;
}

export interface HealthSummary {
  ok: boolean;
  time?: string;
  defaultLocation?: {
    postcode?: string;
    suburb?: string;
  };
  adapters?: AdapterHealthSummary[];
}

export interface AdapterHealthSummary {
  retailer: string;
  status: "healthy" | "degraded" | "offline";
  lastSuccessfulRetrieval?: string;
  extractionConfidence: number;
  browserMode: "live" | "historical" | "hybrid";
  recentFailure?: string;
  consecutiveFailures?: number;
  circuitState?: "closed" | "open" | "half-open";
  circuitOpenUntil?: string;
  cooldownUntil?: string;
}

export interface ComparisonNote {
  kind: "warning" | "assumption" | "info";
  message: string;
}

export interface PriceIntelligenceSummary {
  seenCount: number;
  lowestSeenPrice: number;
  highestSeenPrice: number;
  averageSeenPrice: number;
  medianSeenPrice: number;
  isNewLow: boolean;
  isLikelyOnSpecial: boolean;
  dropVsMedianPct?: number;
  dropVsPreviousPct?: number;
  lastSeenAt?: string;
}

export interface RetailerHealth {
  retailer: string;
  status: "healthy" | "degraded" | "offline";
  lastSuccessAt?: string;
  detail?: string;
}

export interface RecommendationCard {
  productId: string;
  retailer: string;
  productName: string;
  imageUrl?: string;
  sourceUrl?: string;
  sourceType?: "search" | "detail" | "network" | "historical";
  brand?: string;
  packSize?: string;
  shelfPrice: number;
  promotionalPrice?: number;
  effectivePrice: number;
  unitPrice?: string;
  savingsVsNext?: number;
  savingsVsHighest?: number;
  confidenceLabel: string;
  confidenceScore: number;
  freshnessLabel: string;
  availability: string;
  promotionText?: string;
  inferredUnitPrice?: boolean;
  locationContext?: LocationContext;
  notes: string[];
  priceIntelligence?: PriceIntelligenceSummary;
  rankingReasons: string[];
  matchOutcome: string;
}

export interface SingleCompareResponse {
  query: string;
  mode: CompareMode;
  location?: LocationContext;
  recommended?: RecommendationCard;
  alternatives: RecommendationCard[];
  notes: ComparisonNote[];
  retailerHealth: RetailerHealth[];
  comparedAt?: string;
}

export interface BasketLineResult {
  id: string;
  query: string;
  quantity: number;
  recommended?: RecommendationCard;
  alternatives: RecommendationCard[];
  notes: string[];
}

export interface BasketPlan {
  name: string;
  total: number;
  itemCount: number;
  savingsVsSplit?: number;
  retailers?: Array<{ retailer: string; total: number; missingItems: number }>;
  allocations?: Array<{
    lineId: string;
    item: string;
    quantity: number;
    retailer: string;
    cost: number;
    productName?: string;
    productId?: string;
  }>;
  missingItems?: string[];
  notes: string[];
}

export interface BasketCompareResponse {
  mode: CompareMode;
  comparedAt?: string;
  location?: LocationContext;
  lines: BasketLineResult[];
  strategies: BasketPlan[];
  retailerHealth: RetailerHealth[];
  notes: ComparisonNote[];
}

export interface SavedListSummary {
  id: string;
  name: string;
  description?: string;
  mode: CompareMode;
  items: BasketLineInput[];
  updatedAt?: string;
}

export interface FavoriteProductSummary {
  productId: string;
  retailer: string;
  canonicalName: string;
  imageUrl?: string;
  brand?: string;
  packLabel?: string;
  lastPrice: number;
  unitPriceLabel?: string;
  updatedAt?: string;
}

export interface WatchlistSummary {
  id: string;
  query: string;
  productId?: string;
  retailer?: string;
  targetPrice?: number;
  note?: string;
  latestSeenPrice?: number;
  latestSeenAt?: string;
  matchedProductId?: string;
  matchedProductName?: string;
  triggerState: "watching" | "target-hit" | "special";
}

export interface ProductHistoryPoint {
  observedAt: string;
  effectivePrice: number;
  shelfPrice: number;
  promotionalPrice?: number;
  retailer: string;
  promotionText?: string;
  availabilityState: string;
}

export interface DealSummary {
  productId: string;
  retailer: string;
  productName: string;
  brand?: string;
  queryText?: string;
  observedAt: string;
  shelfPrice: number;
  promotionalPrice?: number;
  effectivePrice: number;
  promotionText?: string;
  packLabel?: string;
  unitPriceLabel?: string;
  availabilityState: string;
  imageUrl?: string;
  sourceUrl?: string;
  seenCount: number;
  medianSeenPrice?: number;
  dropVsMedianPct?: number;
  isNewLow: boolean;
  reason: "promotion" | "new-low" | "price-drop";
}

export interface MatchPreferenceSummary {
  id: string;
  query: string;
  normalizedQuery: string;
  productId: string;
  retailer: string;
  productName: string;
  note?: string;
  updatedAt?: string;
}

export interface ItemExplanation {
  summary: string;
  reasons: string[];
  exclusions: string[];
  rankingFactors: string[];
}

interface HttpOptions {
  method?: string;
  body?: unknown;
}

interface RawRankedProduct {
  product: {
    id: string;
    retailer: string;
    sourceUrl: string;
    imageUrl?: string;
    canonicalDisplayName: string;
    sourceType: "search" | "detail" | "network" | "historical";
    brand?: string;
    packSize?: { value: number; unit: string; multipackQuantity?: number };
    shelfPrice: number;
    promotionalPrice?: number;
    effectiveComparisonPrice: number;
    promotionText?: string;
    unitPrice?: { value: number; unit: string; inferred: boolean };
    freshness: string;
    availabilityState: string;
    storeContext?: LocationContext;
    notes: string[];
    warnings: string[];
    priceIntelligence?: PriceIntelligenceSummary;
  };
  confidence: number;
  outcome: string;
  reasons: string[];
  savingsVsNextCheapest?: number;
  savingsVsMostExpensive?: number;
}

interface RawItemComparisonResult {
  query: string;
  comparisonMode: CompareMode;
  location?: LocationContext;
  generatedAt: string;
  recommended?: RawRankedProduct;
  alternatives: RawRankedProduct[];
  retailerStatus: Array<{
    retailer: string;
    health: {
      retailer: string;
      status: "healthy" | "degraded" | "offline";
      lastSuccessfulRetrieval?: string;
      recentFailure?: string;
    };
    warnings: string[];
  }>;
  warnings: string[];
}

interface RawBasketComparisonResult {
  comparisonMode: CompareMode;
  generatedAt: string;
  lines: Array<{
    requestedItem: { name: string; quantity?: number };
    comparison: RawItemComparisonResult;
  }>;
  singleRetailerTotals: Array<{
    retailer: string;
    total: number;
    missingItems: string[];
  }>;
  splitBasket: {
    total: number;
    allocations: Array<{
      requestedItem: { name: string; quantity?: number };
      chosen: RawRankedProduct | null;
    }>;
    savingsVsBestSingleRetailer: number;
  };
  warnings: string[];
}

export class ApiClient {
  readonly baseUrl = "/api";

  async getHealth(): Promise<HealthSummary> {
    const response = await this.request<{
      status: string;
      generatedAt: string;
      config?: {
        defaultLocation?: {
          postcode?: string;
          suburb?: string;
        };
      };
      adapters?: AdapterHealthSummary[];
    }>("/health");
    return {
      ok: response.status === "ok",
      time: response.generatedAt,
      defaultLocation: response.config?.defaultLocation,
      adapters: response.adapters
    };
  }

  async getAdapterHealth(): Promise<AdapterHealthSummary[]> {
    const response = await this.request<{ adapters: AdapterHealthSummary[] }>("/adapters/health");
    return response.adapters;
  }

  async getDeals(options: { days?: number; limit?: number } = {}): Promise<DealSummary[]> {
    const params = new URLSearchParams();
    if (options.days != null) {
      params.set("days", `${options.days}`);
    }
    if (options.limit != null) {
      params.set("limit", `${options.limit}`);
    }
    const suffix = params.size ? `?${params.toString()}` : "";
    const response = await this.request<{ deals: DealSummary[] }>(`/deals${suffix}`);
    return response.deals;
  }

  async compareItem(input: CompareItemInput): Promise<SingleCompareResponse> {
    const response = await this.request<RawItemComparisonResult>("/compare/item", {
      method: "POST",
      body: {
        query: input.query,
        comparisonMode: input.mode,
        allowLiveScrape: input.allowLiveScrape,
        location: {
          postcode: input.postcode,
          suburb: input.suburb
        }
      }
    });
    return this.toSingleCompareResponse(response);
  }

  async explainItem(payload: {
    query: string;
    productId: string;
    mode: CompareMode;
    allowLiveScrape?: boolean;
  }): Promise<ItemExplanation> {
    const response = await this.request<{
      explanation: string[];
      productId: string;
      outcome?: string;
      confidence?: number;
    }>("/explain/item", {
      method: "POST",
      body: {
        query: payload.query,
        productId: payload.productId,
        comparisonMode: payload.mode,
        allowLiveScrape: payload.allowLiveScrape
      }
    });
    return {
      summary: response.explanation[0] ?? "No explanation available.",
      reasons: response.explanation.slice(1, 3),
      rankingFactors: response.explanation.slice(3),
      exclusions: []
    };
  }

  async compareBasket(input: BasketCompareInput): Promise<BasketCompareResponse> {
    const response = await this.request<RawBasketComparisonResult>("/compare/basket", {
      method: "POST",
      body: {
        comparisonMode: input.mode,
        allowLiveScrape: input.allowLiveScrape,
        location: {
          postcode: input.postcode,
          suburb: input.suburb
        },
        items: input.items.map((item) => ({
          name: item.query,
          quantity: item.quantity
        }))
      }
    });
    return this.toBasketCompareResponse(response);
  }

  async getSavedLists(): Promise<SavedListSummary[]> {
    const response = await this.request<{ lists: Array<{
      id: string;
      name: string;
      description?: string;
      comparisonMode: CompareMode;
      items: Array<{ name: string; quantity?: number }>;
      updatedAt?: string;
    }> }>("/saved-lists");
    return response.lists.map((list) => ({
      id: list.id,
      name: list.name,
      description: list.description,
      mode: list.comparisonMode,
      updatedAt: list.updatedAt,
      items: list.items.map((item, index) => ({
        id: `${index + 1}`,
        query: item.name,
        quantity: item.quantity
      }))
    }));
  }

  async saveList(input: Omit<SavedListSummary, "id" | "updatedAt"> & { id?: string }): Promise<SavedListSummary> {
    const response = await this.request<{
      id: string;
      name: string;
      description?: string;
      comparisonMode: CompareMode;
      items: Array<{ name: string; quantity?: number }>;
      updatedAt?: string;
    }>("/saved-lists", {
      method: "POST",
      body: {
        id: input.id,
        name: input.name,
        description: input.description,
        comparisonMode: input.mode,
        items: input.items.map((item) => ({
          name: item.query,
          quantity: item.quantity
        }))
      }
    });
    return {
      id: response.id,
      name: response.name,
      description: response.description,
      mode: response.comparisonMode,
      updatedAt: response.updatedAt,
      items: response.items.map((item, index) => ({
        id: `${index + 1}`,
        query: item.name,
        quantity: item.quantity
      }))
    };
  }

  async deleteList(id: string): Promise<void> {
    await this.request(`/saved-lists/${id}`, { method: "DELETE" });
  }

  async getFavorites(): Promise<FavoriteProductSummary[]> {
    const response = await this.request<{ favorites: FavoriteProductSummary[] }>("/favorites");
    return response.favorites;
  }

  async saveFavorite(card: RecommendationCard): Promise<FavoriteProductSummary> {
    return this.request<FavoriteProductSummary>("/favorites", {
      method: "POST",
      body: {
        product: {
          id: card.productId,
          retailer: card.retailer,
          sourceUrl: card.sourceUrl ?? "",
          sourceType: card.sourceType ?? "historical",
          imageUrl: card.imageUrl,
          canonicalDisplayName: card.productName,
          rawName: card.productName,
          brand: card.brand,
          categoryPath: [],
          structuredAttributes: [],
          shelfPrice: card.shelfPrice,
          effectiveComparisonPrice: card.shelfPrice,
          currency: "AUD",
          priceScope: "store",
          priceConfidence: 0.8,
          availabilityState: card.availability as "in-stock" | "low-stock" | "out-of-stock" | "unknown",
          availabilityConfidence: 0.8,
          lowStock: card.availability === "low-stock",
          lastFetchedAt: new Date().toISOString(),
          lastParsedAt: new Date().toISOString(),
          sourceSnapshotAt: new Date().toISOString(),
          freshness: "fresh",
          notes: card.notes,
          warnings: [],
          packSize: parsePackSizeLabel(card.packSize),
          unitPrice: parseUnitPriceLabel(card.unitPrice)
        }
      }
    });
  }

  async deleteFavorite(productId: string): Promise<void> {
    await this.request(`/favorites/${productId}`, { method: "DELETE" });
  }

  async getWatchlist(): Promise<WatchlistSummary[]> {
    const response = await this.request<{ watchlist: WatchlistSummary[] }>("/watchlist");
    return response.watchlist;
  }

  async saveWatchlist(input: {
    id?: string;
    query: string;
    productId?: string;
    retailer?: string;
    targetPrice?: number;
    note?: string;
  }): Promise<WatchlistSummary> {
    return this.request<WatchlistSummary>("/watchlist", {
      method: "POST",
      body: input
    });
  }

  async deleteWatchlist(id: string): Promise<void> {
    await this.request(`/watchlist/${id}`, { method: "DELETE" });
  }

  async getProductHistory(productId: string, days = 90): Promise<ProductHistoryPoint[]> {
    const response = await this.request<{ history: ProductHistoryPoint[] }>(
      `/products/${productId}/history?days=${days}`
    );
    return response.history;
  }

  async saveMatchPreference(input: {
    id?: string;
    query: string;
    productId: string;
    retailer: string;
    productName: string;
    note?: string;
  }): Promise<MatchPreferenceSummary> {
    return this.request<MatchPreferenceSummary>("/match-preferences", {
      method: "POST",
      body: input
    });
  }

  private async request<T>(path: string, options: HttpOptions = {}): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: options.method ?? "GET",
      headers: {
        "Content-Type": "application/json"
      },
      body: options.body ? JSON.stringify(options.body) : undefined
    });

    if (!response.ok) {
      let message = `Request failed with ${response.status}`;
      try {
        const errorBody = await response.json() as { message?: string };
        if (errorBody.message) {
          message = errorBody.message;
        }
      } catch {
        // Ignore JSON parse issues and keep the generic message.
      }
      throw new Error(message);
    }

    if (response.status === 204) {
      return undefined as T;
    }

    return response.json() as Promise<T>;
  }

  private toSingleCompareResponse(response: RawItemComparisonResult): SingleCompareResponse {
    const recommended = response.recommended ? this.toRecommendationCard(response.recommended) : undefined;
    const alternatives = response.alternatives.map((candidate) => this.toRecommendationCard(candidate));
    const surfacedRetailers = new Set(
      [recommended, ...alternatives].filter((candidate): candidate is RecommendationCard => Boolean(candidate)).map((candidate) => candidate.retailer)
    );

    return {
      query: response.query,
      mode: response.comparisonMode,
      location: response.location,
      recommended,
      alternatives,
      notes: response.warnings.map((message) => ({ kind: "warning" as const, message })),
      retailerHealth: response.retailerStatus.map((status) => ({
        retailer: status.retailer,
        status: status.health.status,
        lastSuccessAt: status.health.lastSuccessfulRetrieval,
        detail: buildRetailerHealthDetail(status, surfacedRetailers)
      })),
      comparedAt: response.generatedAt
    };
  }

  private toBasketCompareResponse(response: RawBasketComparisonResult): BasketCompareResponse {
    const bestSingleStore = [...response.singleRetailerTotals]
      .filter((summary) => summary.missingItems.length === 0)
      .sort((left, right) => left.total - right.total)[0];
    const lines = response.lines.map((line, index) => ({
      id: `${index + 1}`,
      query: line.requestedItem.name,
      quantity: line.requestedItem.quantity ?? 1,
      recommended: line.comparison.recommended ? this.toRecommendationCard(line.comparison.recommended) : undefined,
      alternatives: line.comparison.alternatives.map((candidate) => this.toRecommendationCard(candidate)),
      notes: line.comparison.warnings
    }));
    const healthByRetailer = new Map<string, RetailerHealth>();
    for (const line of response.lines) {
      for (const status of line.comparison.retailerStatus) {
        const existing = healthByRetailer.get(status.retailer);
        if (!existing || statusRank(status.health.status) > statusRank(existing.status)) {
          healthByRetailer.set(status.retailer, {
            retailer: status.retailer,
            status: status.health.status,
            lastSuccessAt: status.health.lastSuccessfulRetrieval,
            detail: status.health.recentFailure
          });
        }
      }
    }

    return {
      mode: response.comparisonMode,
      comparedAt: response.generatedAt,
      lines,
      strategies: [
        {
          name: "Split basket",
          total: response.splitBasket.total,
          itemCount: response.splitBasket.allocations.filter((allocation) => allocation.chosen).length,
          savingsVsSplit: 0,
          allocations: response.splitBasket.allocations.map((allocation, index) => ({
            lineId: `${index + 1}`,
            item: allocation.requestedItem.name,
            quantity: allocation.requestedItem.quantity ?? 1,
            retailer: allocation.chosen?.product.retailer ?? "unmatched",
            cost: allocation.chosen?.product.effectiveComparisonPrice ?? 0,
            productName: allocation.chosen?.product.canonicalDisplayName,
            productId: allocation.chosen?.product.id
          })),
          notes: response.warnings
        },
        ...response.singleRetailerTotals.map((summary) => ({
          name: `${summary.retailer} only`,
          total: summary.total,
          itemCount: response.lines.length - summary.missingItems.length,
          savingsVsSplit: summary.total - response.splitBasket.total,
          retailers: [
            {
              retailer: summary.retailer,
              total: summary.total,
              missingItems: summary.missingItems.length
            }
          ],
          missingItems: summary.missingItems,
          notes:
            summary.missingItems.length > 0
              ? [`Missing: ${summary.missingItems.join(", ")}`]
              : bestSingleStore?.retailer === summary.retailer
                ? ["Best complete single-store option."]
                : []
        }))
      ],
      retailerHealth: Array.from(healthByRetailer.values()),
      notes: response.warnings.map((message) => ({ kind: "warning" as const, message }))
    };
  }

  private toRecommendationCard(candidate: RawRankedProduct): RecommendationCard {
    const pack = candidate.product.packSize;
    return {
      productId: candidate.product.id,
      retailer: candidate.product.retailer,
      productName: candidate.product.canonicalDisplayName,
      imageUrl: candidate.product.imageUrl,
      sourceUrl: candidate.product.sourceUrl,
      sourceType: candidate.product.sourceType,
      brand: candidate.product.brand,
      packSize: pack ? `${pack.value}${pack.unit}` : undefined,
      shelfPrice: candidate.product.shelfPrice,
      promotionalPrice: candidate.product.promotionalPrice,
      effectivePrice: candidate.product.effectiveComparisonPrice ?? candidate.product.shelfPrice,
      unitPrice: candidate.product.unitPrice
        ? `$${candidate.product.unitPrice.value.toFixed(2)} / ${candidate.product.unitPrice.unit}`
        : undefined,
      savingsVsNext: candidate.savingsVsNextCheapest,
      savingsVsHighest: candidate.savingsVsMostExpensive,
      confidenceLabel: humanizeOutcome(candidate.outcome),
      confidenceScore: candidate.confidence,
      freshnessLabel: humanizeFreshness(candidate.product.freshness),
      availability: candidate.product.availabilityState,
      promotionText: candidate.product.promotionText,
      inferredUnitPrice: candidate.product.unitPrice?.inferred,
      locationContext: candidate.product.storeContext,
      notes: [...candidate.product.notes, ...candidate.product.warnings],
      priceIntelligence: candidate.product.priceIntelligence,
      rankingReasons: candidate.reasons,
      matchOutcome: candidate.outcome
    };
  }
}

export const apiClient = () => resolve(ApiClient);

function statusRank(status: RetailerHealth["status"]): number {
  switch (status) {
    case "offline":
      return 2;
    case "degraded":
      return 1;
    default:
      return 0;
  }
}

function humanizeOutcome(outcome: string): string {
  switch (outcome) {
    case "exact-match":
      return "Exact";
    case "high-confidence-equivalent":
      return "High confidence";
    case "moderate-confidence-equivalent":
      return "Comparable";
    case "low-confidence-substitute":
      return "Substitute";
    default:
      return "Unknown";
  }
}

function humanizeFreshness(freshness: string): string {
  return freshness.charAt(0).toUpperCase() + freshness.slice(1);
}

function parsePackSizeLabel(packSize: string | undefined) {
  if (!packSize) {
    return undefined;
  }

  const match = packSize.match(/(\d+(?:\.\d+)?)([a-zA-Z]+)/);
  if (!match) {
    return undefined;
  }

  const unit = match[2].toLowerCase();
  const normalizedUnit = unit === "ct" ? "each" : unit;
  const totalQuantity = normalizedUnit === "kg" || normalizedUnit === "l" ? Number(match[1]) * 1000 : Number(match[1]);
  const comparableUnitType =
    normalizedUnit === "kg" || normalizedUnit === "g"
      ? "mass"
      : normalizedUnit === "l" || normalizedUnit === "ml"
        ? "volume"
        : normalizedUnit === "each"
          ? "count"
          : "unknown";

  return {
    value: Number(match[1]),
    unit: normalizedUnit,
    totalQuantity,
    comparableUnitType
  };
}

function parseUnitPriceLabel(unitPrice: string | undefined) {
  if (!unitPrice) {
    return undefined;
  }

  const match = unitPrice.match(/\$?(\d+(?:\.\d+)?)\s*\/\s*(.+)$/);
  if (!match) {
    return undefined;
  }

  return {
    value: Number(match[1]),
    unit: match[2].trim(),
    inferred: false
  };
}

function buildRetailerHealthDetail(
  status: RawItemComparisonResult["retailerStatus"][number],
  surfacedRetailers: Set<string>
): string | undefined {
  const details = [...status.warnings, status.health.recentFailure].filter((value): value is string => Boolean(value));

  if (status.health.status === "healthy" && !surfacedRetailers.has(status.retailer)) {
    details.push("No comparable result surfaced for this query.");
  }

  return details.join(" | ") || undefined;
}
