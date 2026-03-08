import {
  BasketComparisonResult,
  ItemComparisonResult,
  LocationContext,
  NormalizedProduct,
  PriceIntelligence,
  RankedProduct
} from "@price-patrol/core";
import { getDatabase } from "./database.js";
import { WatchlistItem, getWatchlist } from "./storage.js";

export interface ProductPriceHistoryPoint {
  observedAt: string;
  effectivePrice: number;
  shelfPrice: number;
  promotionalPrice?: number;
  retailer: string;
  promotionText?: string;
  availabilityState: string;
}

export interface WatchlistView extends WatchlistItem {
  latestSeenPrice?: number;
  latestSeenAt?: string;
  matchedProductId?: string;
  matchedProductName?: string;
  triggerState: "watching" | "target-hit" | "special";
}

export async function recordItemComparison(result: ItemComparisonResult): Promise<void> {
  const products = [result.recommended, ...result.alternatives].filter(Boolean) as RankedProduct[];
  recordRankedProducts(products, result.query, result.comparisonMode, result.location);
}

export async function recordBasketComparison(result: BasketComparisonResult): Promise<void> {
  for (const line of result.lines) {
    const products = [line.comparison.recommended, ...line.comparison.alternatives].filter(Boolean) as RankedProduct[];
    recordRankedProducts(products, line.requestedItem.name, result.comparisonMode, line.comparison.location);
  }
}

export async function enrichItemComparison(result: ItemComparisonResult): Promise<ItemComparisonResult> {
  if (result.recommended) {
    result.recommended = enrichRankedProduct(result.recommended);
  }
  result.alternatives = result.alternatives.map((candidate) => enrichRankedProduct(candidate));
  return result;
}

export async function enrichBasketComparison(result: BasketComparisonResult): Promise<BasketComparisonResult> {
  for (const line of result.lines) {
    await enrichItemComparison(line.comparison);
  }
  return result;
}

export async function explainPriceIntelligence(productId: string): Promise<string[]> {
  const insight = getPriceIntelligence(productId);
  if (!insight || insight.seenCount < 2) {
    return [];
  }

  const messages: string[] = [
    `Seen ${insight.seenCount} times with a recent median price of $${insight.medianSeenPrice.toFixed(2)}.`
  ];

  if (insight.isNewLow) {
    messages.push(`Current price matches the lowest observed price of $${insight.lowestSeenPrice.toFixed(2)}.`);
  } else if (insight.dropVsMedianPct != null && insight.dropVsMedianPct >= 0.08) {
    messages.push(`Current price is ${Math.round(insight.dropVsMedianPct * 100)}% below its recent median.`);
  }

  if (insight.dropVsPreviousPct != null && insight.dropVsPreviousPct >= 0.05) {
    messages.push(`Current price is ${Math.round(insight.dropVsPreviousPct * 100)}% below the previous observation.`);
  }

  return messages;
}

export async function getProductHistory(productId: string, days = 60): Promise<ProductPriceHistoryPoint[]> {
  const db = getDatabase();
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const rows = db.prepare(`
    SELECT observed_at, effective_price, shelf_price, promotional_price, retailer, promotion_text, availability_state
    FROM product_observations
    WHERE product_id = :productId AND observed_at >= :cutoff
    ORDER BY observed_at DESC
  `).all({ productId, cutoff }) as Array<{
    observed_at: string;
    effective_price: number;
    shelf_price: number;
    promotional_price?: number | null;
    retailer: string;
    promotion_text?: string | null;
    availability_state: string;
  }>;

  return rows.map((row) => ({
    observedAt: row.observed_at,
    effectivePrice: row.effective_price,
    shelfPrice: row.shelf_price,
    promotionalPrice: row.promotional_price ?? undefined,
    retailer: row.retailer,
    promotionText: row.promotion_text ?? undefined,
    availabilityState: row.availability_state
  }));
}

export async function getWatchlistView(): Promise<WatchlistView[]> {
  const entries = await getWatchlist();
  return entries.map((entry) => {
    const latest = getLatestObservation(entry.productId, entry.query);
    const triggerState = deriveWatchlistTrigger(entry, latest?.effective_price, latest?.promotion_text ?? undefined);
    return {
      ...entry,
      latestSeenPrice: latest?.effective_price,
      latestSeenAt: latest?.observed_at,
      matchedProductId: latest?.product_id,
      matchedProductName: latest?.canonical_name,
      triggerState
    };
  });
}

function recordRankedProducts(
  products: RankedProduct[],
  query: string,
  comparisonMode: string,
  location?: LocationContext
): void {
  if (!products.length) {
    return;
  }

  const db = getDatabase();
  const insert = db.prepare(`
    INSERT INTO product_observations (
      product_id, retailer, canonical_name, brand, query_text, comparison_mode,
      postcode, suburb, pack_quantity, pack_unit, comparable_unit_type,
      shelf_price, promotional_price, effective_price, unit_price, unit_price_unit,
      promotion_text, availability_state, observed_at, source_url, source_type
    ) VALUES (
      :productId, :retailer, :canonicalName, :brand, :queryText, :comparisonMode,
      :postcode, :suburb, :packQuantity, :packUnit, :comparableUnitType,
      :shelfPrice, :promotionalPrice, :effectivePrice, :unitPrice, :unitPriceUnit,
      :promotionText, :availabilityState, :observedAt, :sourceUrl, :sourceType
    )
  `);

  const seenThisRun = new Set<string>();
  for (const candidate of products) {
    const product = candidate.product;
    const key = `${product.id}:${product.effectiveComparisonPrice}`;
    if (seenThisRun.has(key)) {
      continue;
    }
    seenThisRun.add(key);
    insert.run({
      productId: product.id,
      retailer: product.retailer,
      canonicalName: product.canonicalDisplayName,
      brand: product.brand ?? null,
      queryText: query,
      comparisonMode,
      postcode: location?.postcode ?? null,
      suburb: location?.suburb ?? null,
      packQuantity: product.packSize?.value ?? null,
      packUnit: product.packSize?.unit ?? null,
      comparableUnitType: product.packSize?.comparableUnitType ?? null,
      shelfPrice: product.shelfPrice,
      promotionalPrice: product.promotionalPrice ?? null,
      effectivePrice: product.effectiveComparisonPrice,
      unitPrice: product.unitPrice?.value ?? null,
      unitPriceUnit: product.unitPrice?.unit ?? null,
      promotionText: product.promotionText ?? null,
      availabilityState: product.availabilityState,
      observedAt: new Date().toISOString(),
      sourceUrl: product.sourceUrl,
      sourceType: product.sourceType
    });
  }
}

function enrichRankedProduct(candidate: RankedProduct): RankedProduct {
  const insight = getPriceIntelligence(candidate.product.id);
  if (!insight) {
    return candidate;
  }

  candidate.product.priceIntelligence = insight;
  candidate.product.notes = Array.from(
    new Set([...candidate.product.notes, ...buildPriceNotes(insight, candidate.product)])
  );
  return candidate;
}

function getPriceIntelligence(productId: string): PriceIntelligence | undefined {
  const db = getDatabase();
  const rows = db.prepare(`
    SELECT effective_price, observed_at
    FROM product_observations
    WHERE product_id = :productId
    ORDER BY observed_at DESC
    LIMIT 30
  `).all({ productId }) as Array<{ effective_price: number; observed_at: string }>;

  if (!rows.length) {
    return undefined;
  }

  const prices = rows.map((row) => row.effective_price);
  const currentPrice = prices[0];
  const sorted = [...prices].sort((left, right) => left - right);
  const lowestSeenPrice = sorted[0];
  const highestSeenPrice = sorted[sorted.length - 1];
  const averageSeenPrice = prices.reduce((sum, value) => sum + value, 0) / prices.length;
  const medianSeenPrice = median(sorted);
  const previousSeenPrice = prices[1];
  const dropVsMedianPct = medianSeenPrice > 0 ? (medianSeenPrice - currentPrice) / medianSeenPrice : undefined;
  const dropVsPreviousPct =
    previousSeenPrice && previousSeenPrice > 0 ? (previousSeenPrice - currentPrice) / previousSeenPrice : undefined;

  return {
    seenCount: prices.length,
    lowestSeenPrice,
    highestSeenPrice,
    averageSeenPrice: Number(averageSeenPrice.toFixed(2)),
    medianSeenPrice,
    lastSeenAt: rows[0]?.observed_at,
    previousSeenPrice,
    dropVsMedianPct: dropVsMedianPct != null ? Number(dropVsMedianPct.toFixed(4)) : undefined,
    dropVsPreviousPct: dropVsPreviousPct != null ? Number(dropVsPreviousPct.toFixed(4)) : undefined,
    isNewLow: currentPrice <= lowestSeenPrice,
    isLikelyOnSpecial: Boolean((dropVsMedianPct ?? 0) >= 0.08 || (dropVsPreviousPct ?? 0) >= 0.08)
  };
}

function buildPriceNotes(insight: PriceIntelligence, product: NormalizedProduct): string[] {
  if (insight.seenCount < 2) {
    return [];
  }

  const notes: string[] = [`Seen ${insight.seenCount} times. Recent median is $${insight.medianSeenPrice.toFixed(2)}.`];

  if (insight.isNewLow) {
    notes.push(`Trading at its observed low of $${insight.lowestSeenPrice.toFixed(2)}.`);
  } else if (insight.dropVsMedianPct != null && insight.dropVsMedianPct >= 0.08) {
    notes.push(`About ${Math.round(insight.dropVsMedianPct * 100)}% below its recent median price.`);
  }

  if (product.promotionText && insight.seenCount >= 2) {
    notes.push(`Promotion is active: ${product.promotionText}.`);
  }

  return notes;
}

function getLatestObservation(productId: string | undefined, query: string): {
  product_id: string;
  canonical_name: string;
  effective_price: number;
  observed_at: string;
  promotion_text?: string | null;
} | undefined {
  const db = getDatabase();

  if (productId) {
    return db.prepare(`
      SELECT product_id, canonical_name, effective_price, observed_at, promotion_text
      FROM product_observations
      WHERE product_id = :productId
      ORDER BY observed_at DESC
      LIMIT 1
    `).get({ productId }) as {
      product_id: string;
      canonical_name: string;
      effective_price: number;
      observed_at: string;
      promotion_text?: string | null;
    } | undefined;
  }

  return db.prepare(`
    SELECT product_id, canonical_name, effective_price, observed_at, promotion_text
    FROM product_observations
    WHERE query_text = :query
    ORDER BY observed_at DESC
    LIMIT 1
  `).get({ query }) as {
    product_id: string;
    canonical_name: string;
    effective_price: number;
    observed_at: string;
    promotion_text?: string | null;
  } | undefined;
}

function deriveWatchlistTrigger(
  entry: WatchlistItem,
  latestSeenPrice: number | undefined,
  promotionText: string | undefined
): WatchlistView["triggerState"] {
  if (entry.targetPrice != null && latestSeenPrice != null && latestSeenPrice <= entry.targetPrice) {
    return "target-hit";
  }
  if (promotionText) {
    return "special";
  }
  return "watching";
}

function median(sortedValues: number[]): number {
  if (!sortedValues.length) {
    return 0;
  }

  const midpoint = Math.floor(sortedValues.length / 2);
  if (sortedValues.length % 2 === 0) {
    return Number(((sortedValues[midpoint - 1] + sortedValues[midpoint]) / 2).toFixed(2));
  }

  return sortedValues[midpoint];
}
