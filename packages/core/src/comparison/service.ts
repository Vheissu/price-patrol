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
      for (const line of lines) {
        const candidate = [line.comparison.recommended, ...line.comparison.alternatives]
          .filter(Boolean)
          .find((ranked) => ranked?.product.retailer === retailer) as RankedProduct | undefined;
        if (!candidate) {
          missingItems.push(line.requestedItem.name);
          continue;
        }
        matchedItems.push(candidate);
      }
      return {
        retailer,
        total: matchedItems.reduce((sum, item) => sum + item.product.effectiveComparisonPrice * (item.product.packSize?.multipackQuantity ? 1 : 1), 0),
        matchedItems,
        missingItems
      };
    });

    const splitAllocations = lines.map((line) => ({
      requestedItem: line.requestedItem,
      chosen: line.comparison.recommended ?? null
    }));
    const splitTotal = splitAllocations.reduce((sum, line) => sum + (line.chosen?.product.effectiveComparisonPrice ?? 0), 0);
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
        savingsVsBestSingleRetailer: bestSingleRetailer ? bestSingleRetailer.total - splitTotal : 0
      },
      warnings: lines.flatMap((line) => line.comparison.warnings)
    };
  }
}

function applySavings(ranked: RankedProduct[], mode: ComparisonMode): void {
  const priceOf = (candidate: RankedProduct) =>
    mode === "best-value" ? candidate.product.unitPrice?.value ?? candidate.product.effectiveComparisonPrice : candidate.product.effectiveComparisonPrice;

  ranked.forEach((candidate, index) => {
    const next = ranked[index + 1];
    const last = ranked[ranked.length - 1];
    if (next) {
      candidate.savingsVsNextCheapest = Number(Math.max(0, priceOf(next) - priceOf(candidate)).toFixed(2));
    }
    if (last) {
      candidate.savingsVsMostExpensive = Number(Math.max(0, priceOf(last) - priceOf(candidate)).toFixed(2));
    }
  });
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
) {
  const config = await getProjectConfig();
  return runWithConcurrency(adapters, config.resilience.maxConcurrentRetailerTasks, (adapter) => adapter.search(intent, options));
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
