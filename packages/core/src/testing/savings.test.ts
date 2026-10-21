import { describe, expect, it } from "vitest";
import { applySavings, PricePatrolService } from "../comparison/service.js";
import type { RetailerAdapter } from "../adapters/base.js";
import type { NormalizedProduct, RankedProduct } from "../types/domain.js";

const now = new Date().toISOString();

function product(input: Partial<NormalizedProduct> & Pick<NormalizedProduct, "id" | "retailer" | "canonicalDisplayName" | "shelfPrice">): NormalizedProduct {
  return {
    rawName: input.canonicalDisplayName,
    effectiveComparisonPrice: input.shelfPrice,
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
    warnings: [],
    sourceUrl: "https://example.test/product",
    sourceType: "historical",
    categoryPath: [],
    structuredAttributes: [],
    ...input
  };
}

function ranked(id: string, price: number): RankedProduct {
  return {
    product: product({ id, retailer: "coles", canonicalDisplayName: id, shelfPrice: price }),
    outcome: "high-confidence-equivalent",
    confidence: 0.9,
    rankingScore: 1,
    reasons: []
  };
}

function adapter(retailer: "coles" | "woolworths" | "aldi", products: NormalizedProduct[]): RetailerAdapter {
  const health = { retailer, status: "healthy" as const, extractionConfidence: 0.8, browserMode: "historical" as const };
  return {
    retailer,
    async search() {
      return { retailer, products, warnings: [], diagnostics: [], health };
    },
    getHealth: () => health
  };
}

describe("applySavings", () => {
  it("measures savings against the next cheapest price rather than the next ranked item", () => {
    // Ranked order deliberately differs from price order.
    const candidates = [ranked("mid", 3), ranked("cheap", 2), ranked("dear", 5)];
    applySavings(candidates, "equivalent");

    expect(candidates[0]?.savingsVsNextCheapest).toBe(2);
    expect(candidates[0]?.savingsVsMostExpensive).toBe(2);
    expect(candidates[1]?.savingsVsNextCheapest).toBe(1);
    expect(candidates[1]?.savingsVsMostExpensive).toBe(3);
    expect(candidates[2]?.savingsVsNextCheapest).toBeUndefined();
    expect(candidates[2]?.savingsVsMostExpensive).toBe(0);
  });

  it("leaves a single candidate untouched", () => {
    const candidates = [ranked("only", 3)];
    applySavings(candidates, "equivalent");
    expect(candidates[0]?.savingsVsNextCheapest).toBeUndefined();
  });
});

describe("basket quantities", () => {
  it("multiplies single-store and split totals by the requested quantity", async () => {
    const service = new PricePatrolService([
      adapter("coles", [
        product({ id: "coles:milk", retailer: "coles", canonicalDisplayName: "Coles Full Cream Milk 2L", shelfPrice: 3 }),
        product({ id: "coles:flour", retailer: "coles", canonicalDisplayName: "Coles Plain Flour 1kg", shelfPrice: 1.5 })
      ]),
      adapter("aldi", [
        product({ id: "aldi:milk", retailer: "aldi", canonicalDisplayName: "Farmdale Full Cream Milk 2L", shelfPrice: 2.5 })
      ])
    ]);

    const basket = await service.compareBasket(
      [
        { name: "full cream milk 2l", quantity: 3 },
        { name: "plain flour 1kg", quantity: 2 }
      ],
      "equivalent",
      { allowLiveScrape: false }
    );

    const coles = basket.singleRetailerTotals.find((summary) => summary.retailer === "coles");
    const aldi = basket.singleRetailerTotals.find((summary) => summary.retailer === "aldi");

    expect(coles?.total).toBe(3 * 3 + 1.5 * 2);
    expect(coles?.missingItems).toEqual([]);
    expect(aldi?.missingItems).toEqual(["plain flour 1kg"]);
    expect(basket.splitBasket.total).toBe(2.5 * 3 + 1.5 * 2);
    expect(basket.splitBasket.savingsVsBestSingleRetailer).toBe(12 - 10.5);
  });

  it("survives an adapter that throws outside its own scrape guard", async () => {
    const broken: RetailerAdapter = {
      retailer: "woolworths",
      async search() {
        throw new Error("browserType.launch: Executable doesn't exist");
      },
      getHealth: () => ({ retailer: "woolworths", status: "healthy", extractionConfidence: 0.8, browserMode: "hybrid" })
    };
    const service = new PricePatrolService([
      broken,
      adapter("coles", [product({ id: "coles:milk", retailer: "coles", canonicalDisplayName: "Coles Full Cream Milk 2L", shelfPrice: 3 })])
    ]);

    const result = await service.compareItem("full cream milk 2l", "equivalent", { allowLiveScrape: false });
    expect(result.recommended?.product.id).toBe("coles:milk");
    const woolworths = result.retailerStatus.find((status) => status.retailer === "woolworths");
    expect(woolworths?.health.status).toBe("degraded");
    expect(woolworths?.warnings[0]).toContain("Executable doesn't exist");
  });
});
