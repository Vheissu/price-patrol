import { randomUUID } from "node:crypto";
import {
  BasketComparisonResult,
  BasketItemRequest,
  ComparisonMode,
  ExplanationResult,
  ItemComparisonResult,
  RankedProduct,
  RetailerStatus,
  SearchOptions
} from "../types/domain.js";
import { getProjectConfig } from "../config/project-config.js";
import { parseSearchIntent } from "../parsing/query.js";
import { rankProducts } from "./matching.js";
import { RetailerAdapter } from "../adapters/base.js";
import { AdapterSearchResult } from "../types/domain.js";

export class PricePatrolService {
  constructor(private readonly adapters: RetailerAdapter[]) {}

  async compareItem(query: string, comparisonMode: ComparisonMode, options: SearchOptions = {}): Promise<ItemComparisonResult> {
    const intent = parseSearchIntent(query, comparisonMode);
    const responses = await searchRetailers(this.adapters, intent, options);
    const retailerStatus: RetailerStatus[] = responses.map((response) => ({
      retailer: response.retailer,
      health: response.health,
      warnings: response.warnings
    }));

    const ranked = rankProducts(
      responses.flatMap((response) => response.products),
      intent,
      { preferredProductIds: options.preferredProductIds }
    );

    applySavings(ranked, comparisonMode);

    const recommended = ranked[0];
    const warnings = [
      ...responses.flatMap((response) => response.warnings),
      ...deriveGlobalWarnings(recommended, ranked, intent)
    ];

    return {
      requestId: randomUUID(),
      query,
      comparisonMode,
      location: options.location,
      generatedAt: new Date().toISOString(),
      recommended,
      alternatives: ranked.slice(1, 10),
      retailerStatus,
      warnings: [...new Set(warnings)],
      diagnostics: responses.flatMap((response) => response.diagnostics)
    };
  }

  async explainItem(query: string, productId: string, comparisonMode: ComparisonMode, options: SearchOptions = {}): Promise<ExplanationResult> {
    const comparison = await this.compareItem(query, comparisonMode, options);
    const candidates = [comparison.recommended, ...comparison.alternatives].filter(Boolean) as RankedProduct[];
    const target = candidates.find((candidate) => candidate.product.id === productId);
    if (!target) {
      return {
        productId,
        explanation: ["The requested product is not present in the current comparison set."]
      };
    }

    const explanation = [
      `Compared in ${comparisonMode} mode for "${query}".`,
      ...target.reasons,
      target.product.unitPrice
        ? `Unit price used: $${target.product.unitPrice.value.toFixed(2)} per ${target.product.unitPrice.unit}.`
        : `Shelf price used: $${target.product.shelfPrice.toFixed(2)}.`,
      `Freshness is ${target.product.freshness} and availability is ${target.product.availabilityState}.`
    ];

    if (target.savingsVsNextCheapest != null) {
      explanation.push(`It saves $${target.savingsVsNextCheapest.toFixed(2)} versus the next cheapest comparable result.`);
    }

    return {
      productId,
      explanation,
      outcome: target.outcome,
      confidence: target.confidence
    };
  }

  async compareBasket(
    items: BasketItemRequest[],
    comparisonMode: ComparisonMode,
    options: SearchOptions = {}
  ): Promise<BasketComparisonResult> {
    const lines = await Promise.all(
      items.map(async (item) => ({
        requestedItem: item,
        comparison: await this.compareItem(item.name, comparisonMode, options)
      }))
    );

    const retailerIds = this.adapters.map((adapter) => adapter.retailer);
    const singleRetailerTotals = retailerIds.map((retailer) => {
      const matchedItems: RankedProduct[] = [];
      const missingItems: string[] = [];
      const lineCandidates: Array<RankedProduct | undefined> = [];
      for (const line of lines) {
        const candidate = [line.comparison.recommended, ...line.comparison.alternatives]
          .filter(Boolean)
          .find((ranked) => ranked?.product.retailer === retailer) as RankedProduct | undefined;
        lineCandidates.push(candidate);
        if (!candidate) {
          missingItems.push(line.requestedItem.name);
          continue;
        }
        matchedItems.push(candidate);
      }
      return {
        retailer,
        total: roundMoney(
          lines.reduce((sum, line, index) => {
            const candidate = lineCandidates[index];
            return candidate ? sum + candidate.product.effectiveComparisonPrice * requestedQuantity(line.requestedItem) : sum;
          }, 0)
        ),
        matchedItems,
        missingItems
      };
    });

    const splitAllocations = lines.map((line) => ({
      requestedItem: line.requestedItem,
      chosen: line.comparison.recommended ?? null
    }));
    const splitTotal = roundMoney(
      splitAllocations.reduce(
        (sum, line) => sum + (line.chosen?.product.effectiveComparisonPrice ?? 0) * requestedQuantity(line.requestedItem),
        0
      )
    );
    const bestSingleRetailer = singleRetailerTotals
      .filter((summary) => summary.missingItems.length === 0)
      .sort((left, right) => left.total - right.total)[0];

    return {
      requestId: randomUUID(),
      comparisonMode,
      generatedAt: new Date().toISOString(),
      lines,
      singleRetailerTotals,
      splitBasket: {
        total: splitTotal,
        allocations: splitAllocations,
        savingsVsBestSingleRetailer: bestSingleRetailer ? roundMoney(bestSingleRetailer.total - splitTotal) : 0
      },
      warnings: lines.flatMap((line) => line.comparison.warnings)
    };
  }
}

export function applySavings(ranked: RankedProduct[], mode: ComparisonMode): void {
  if (ranked.length < 2) {
    return;
  }

  const priceOf = (candidate: RankedProduct) =>
    mode === "best-value" ? candidate.product.unitPrice?.value ?? candidate.product.effectiveComparisonPrice : candidate.product.effectiveComparisonPrice;
  const prices = ranked.map(priceOf);
  const mostExpensive = Math.max(...prices);

  ranked.forEach((candidate, index) => {
    const ownPrice = prices[index];
    // "Next cheapest" means the cheapest other candidate that costs at least as much as this one,
    // regardless of where it landed in the ranking order.
    const nextCheapest = prices
      .filter((price, otherIndex) => otherIndex !== index && price >= ownPrice)
      .sort((left, right) => left - right)[0];

    candidate.savingsVsNextCheapest = nextCheapest != null ? roundMoney(nextCheapest - ownPrice) : undefined;
    candidate.savingsVsMostExpensive = roundMoney(Math.max(0, mostExpensive - ownPrice));
  });
}

function requestedQuantity(item: BasketItemRequest): number {
  const quantity = item.quantity;
  return typeof quantity === "number" && Number.isFinite(quantity) && quantity > 0 ? quantity : 1;
}

function roundMoney(value: number): number {
  return Number(value.toFixed(2));
}

function deriveGlobalWarnings(recommended: RankedProduct | undefined, ranked: RankedProduct[], intent: ReturnType<typeof parseSearchIntent>): string[] {
  const warnings: string[] = [];
  if (!recommended) {
    return ["No comparable products were found for the requested query."];
  }
  if (recommended.confidence < 0.65) {
    warnings.push("Only lower-confidence substitutes were available for this query.");
  }
  if (intent.brandPreference && !ranked.some((candidate) => normalizeBrand(candidate.product.brand) === intent.brandPreference)) {
    warnings.push(`No direct ${intent.brandPreference} match was found, so substitutes are being ranked instead.`);
  }
  if (recommended.product.unitPrice?.inferred) {
    warnings.push("At least one unit price was inferred from the pack size rather than provided by the retailer.");
  }
  if (ranked.some((candidate) => candidate.product.freshness === "aging" || candidate.product.freshness === "stale")) {
    warnings.push("Some results are older than the preferred freshness window.");
  }
  return warnings;
}

function normalizeBrand(brand?: string): string | undefined {
  return brand?.trim().toLowerCase();
}

async function searchRetailers(
  adapters: RetailerAdapter[],
  intent: ReturnType<typeof parseSearchIntent>,
  options: SearchOptions
): Promise<AdapterSearchResult[]> {
  const config = await getProjectConfig();
  return runWithConcurrency(adapters, config.resilience.maxConcurrentRetailerTasks, async (adapter) => {
    try {
      return await adapter.search(intent, options);
    } catch (error) {
      // One adapter blowing up (browser launch failure, locked database) must not sink the whole comparison.
      const message = error instanceof Error ? error.message : "Unknown adapter failure.";
      return {
        retailer: adapter.retailer,
        products: [],
        warnings: [`${adapter.retailer} could not be searched: ${message}`],
        diagnostics: [`Adapter threw outside its scrape guard: ${message}`],
        health: {
          ...adapter.getHealth(),
          status: "degraded",
          recentFailure: message
        }
      };
    }
  });
}

async function runWithConcurrency<T, TResult>(
  items: T[],
  maxConcurrency: number,
  worker: (item: T, index: number) => Promise<TResult>
): Promise<TResult[]> {
  const results = new Array<TResult>(items.length);
  let nextIndex = 0;

  const runners = Array.from({ length: Math.min(Math.max(maxConcurrency, 1), items.length) }, async () => {
    while (true) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      if (currentIndex >= items.length) {
        return;
      }

      results[currentIndex] = await worker(items[currentIndex], currentIndex);
    }
  });

  await Promise.all(runners);
  return results;
}
