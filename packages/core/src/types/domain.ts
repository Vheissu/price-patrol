export type RetailerId = "coles" | "woolworths" | "aldi";
export type SourceType = "search" | "detail" | "network" | "historical";
export type ComparisonMode = "exact" | "equivalent" | "best-value";
export type AvailabilityState = "in-stock" | "low-stock" | "out-of-stock" | "unknown";
export type FreshnessLevel = "fresh" | "recent" | "aging" | "stale";
export type MatchOutcome =
  | "exact-match"
  | "high-confidence-equivalent"
  | "moderate-confidence-equivalent"
  | "low-confidence-substitute"
  | "rejected";
export type ComparableUnitType = "mass" | "volume" | "count" | "unknown";

export interface LocationContext {
  postcode?: string;
  suburb?: string;
  storeId?: string;
  storeDisplayName?: string;
  locationText?: string;
}

export interface ParsedSize {
  value: number;
  unit: string;
  totalQuantity: number;
  comparableUnitType: ComparableUnitType;
  multipackQuantity?: number;
}

export interface UnitPrice {
  value: number;
  unit: string;
  inferred: boolean;
}

export interface PriceIntelligence {
  seenCount: number;
  lowestSeenPrice: number;
  highestSeenPrice: number;
  averageSeenPrice: number;
  medianSeenPrice: number;
  lastSeenAt?: string;
  previousSeenPrice?: number;
  dropVsMedianPct?: number;
  dropVsPreviousPct?: number;
  isNewLow: boolean;
  isLikelyOnSpecial: boolean;
}

export interface NormalizedProduct {
  id: string;
  retailer: RetailerId;
  retailerProductId?: string;
  sourceUrl: string;
  sourceType: SourceType;
  imageUrl?: string;
  storeContext?: LocationContext;
  canonicalDisplayName: string;
  rawName: string;
  brand?: string;
  productLine?: string;
  variantDescriptor?: string;
  categoryPath: string[];
  structuredAttributes: string[];
  packSize?: ParsedSize;
  unitPrice?: UnitPrice;
  shelfPrice: number;
  promotionalPrice?: number;
  promotionText?: string;
  effectiveComparisonPrice: number;
  currency: string;
  priceScope: "estimated" | "store" | "national";
  priceConfidence: number;
  availabilityState: AvailabilityState;
  availabilityConfidence: number;
  lowStock: boolean;
  lastFetchedAt: string;
  lastParsedAt: string;
  sourceSnapshotAt: string;
  freshness: FreshnessLevel;
  matchGroupId?: string;
  priceIntelligence?: PriceIntelligence;
  notes: string[];
  warnings: string[];
  diagnostics?: Record<string, unknown>;
}

export interface SearchIntent {
  rawQuery: string;
  normalizedQuery: string;
  comparisonMode: ComparisonMode;
  coreType: string;
  familyTerms: string[];
  substituteTerms: string[];
  fallbackQueries: string[];
  requiredMatchTerms: string[];
  excludedMatchTerms: string[];
  variantTerms: string[];
  attributeTerms: string[];
  excludedTerms: string[];
  brandPreference?: string;
  desiredPackSize?: ParsedSize;
}

export interface SearchOptions {
  location?: LocationContext;
  maxResults?: number;
  preferFresh?: boolean;
  allowLiveScrape?: boolean;
  preferredProductIds?: string[];
}

export type CircuitState = "closed" | "open" | "half-open";

export interface AdapterHealth {
  retailer: RetailerId;
  status: "healthy" | "degraded" | "offline";
  lastSuccessfulRetrieval?: string;
  extractionConfidence: number;
  browserMode: "live" | "historical" | "hybrid";
  recentFailure?: string;
  consecutiveFailures?: number;
  circuitState?: CircuitState;
  circuitOpenUntil?: string;
  cooldownUntil?: string;
}

export interface AdapterSearchResult {
  retailer: RetailerId;
  products: NormalizedProduct[];
  warnings: string[];
  diagnostics: string[];
  health: AdapterHealth;
}

export interface RankedProduct {
  product: NormalizedProduct;
  outcome: MatchOutcome;
  confidence: number;
  rankingScore: number;
  reasons: string[];
  savingsVsNextCheapest?: number;
  savingsVsMostExpensive?: number;
}

export interface RetailerStatus {
  retailer: RetailerId;
  health: AdapterHealth;
  warnings: string[];
}

export interface ItemComparisonResult {
  requestId: string;
  query: string;
  comparisonMode: ComparisonMode;
  location?: LocationContext;
  generatedAt: string;
  recommended?: RankedProduct;
  alternatives: RankedProduct[];
  retailerStatus: RetailerStatus[];
  warnings: string[];
  diagnostics: string[];
}

export interface BasketItemRequest {
  name: string;
  quantity?: number;
}

export interface BasketLineResult {
  requestedItem: BasketItemRequest;
  comparison: ItemComparisonResult;
}

export interface RetailerBasketSummary {
  retailer: RetailerId;
  total: number;
  matchedItems: RankedProduct[];
  missingItems: string[];
}

export interface SplitBasketAllocation {
  requestedItem: BasketItemRequest;
  chosen: RankedProduct | null;
}

export interface BasketComparisonResult {
  requestId: string;
  comparisonMode: ComparisonMode;
  generatedAt: string;
  lines: BasketLineResult[];
  singleRetailerTotals: RetailerBasketSummary[];
  splitBasket: {
    total: number;
    allocations: SplitBasketAllocation[];
    savingsVsBestSingleRetailer: number;
  };
  warnings: string[];
}

export interface SavedList {
  id: string;
  name: string;
  description?: string;
  items: BasketItemRequest[];
  comparisonMode: ComparisonMode;
  createdAt: string;
  updatedAt: string;
}

export interface ExplanationResult {
  productId: string;
  explanation: string[];
  outcome?: MatchOutcome;
  confidence?: number;
}
