import { describe, expect, it } from "vitest";
import { PricePatrolService } from "../comparison/service.js";
import type { RetailerAdapter } from "../adapters/base.js";
import type { NormalizedProduct } from "../types/domain.js";

const now = new Date().toISOString();

function product(input: Partial<NormalizedProduct> & Pick<NormalizedProduct, "id" | "retailer" | "canonicalDisplayName" | "rawName" | "shelfPrice" | "effectiveComparisonPrice">): NormalizedProduct {
  return {
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
    categoryPath: ["Pantry"],
    structuredAttributes: [],
    ...input
  };
}

function adapter(retailer: "coles" | "woolworths" | "aldi", products: NormalizedProduct[]): RetailerAdapter {
  return {
    retailer,
    async search() {
      return {
        retailer,
        products,
        warnings: [],
        diagnostics: [],
        health: {
          retailer,
          status: "healthy",
          extractionConfidence: 0.8,
          browserMode: "historical"
        }
      };
    },
    getHealth() {
      return {
        retailer,
        status: "healthy",
        extractionConfidence: 0.8,
        browserMode: "historical"
      };
    }
  };
}

describe("PricePatrolService", () => {
  it("returns a cheapest equivalent flour option", async () => {
    const service = new PricePatrolService([
      adapter("coles", [
        product({
          id: "coles:plain-flour",
          retailer: "coles",
          canonicalDisplayName: "Coles White Plain Flour 1kg",
          rawName: "Coles White Plain Flour 1kg",
          brand: "Coles",
          shelfPrice: 1.3,
          effectiveComparisonPrice: 1.3,
          packSize: { value: 1, unit: "kg", totalQuantity: 1000, comparableUnitType: "mass" },
          unitPrice: { value: 1.3, unit: "1kg", inferred: false }
        })
      ]),
      adapter("woolworths", [
        product({
          id: "woolworths:plain-flour",
          retailer: "woolworths",
          canonicalDisplayName: "Essentials Plain Flour 1kg",
          rawName: "Essentials Plain Flour 1kg",
          brand: "Essentials",
          shelfPrice: 1.25,
          effectiveComparisonPrice: 1.25,
          packSize: { value: 1, unit: "kg", totalQuantity: 1000, comparableUnitType: "mass" },
          unitPrice: { value: 1.25, unit: "1kg", inferred: false }
        })
      ])
    ]);

    const result = await service.compareItem("plain flour 1kg", "equivalent", { allowLiveScrape: false });
    expect(result.recommended).toBeDefined();
    expect(result.recommended?.product.canonicalDisplayName.toLowerCase()).toContain("plain flour");
    expect(result.alternatives.length).toBeGreaterThan(0);
  });

  it("builds a split basket cheaper than zero", async () => {
    const service = new PricePatrolService([
      adapter("coles", [
        product({
          id: "coles:plain-flour",
          retailer: "coles",
          canonicalDisplayName: "Coles White Plain Flour 1kg",
          rawName: "Coles White Plain Flour 1kg",
          shelfPrice: 1.3,
          effectiveComparisonPrice: 1.3
        }),
        product({
          id: "coles:milk",
          retailer: "coles",
          canonicalDisplayName: "Coles Full Cream Milk 2L",
          rawName: "Coles Full Cream Milk 2L",
          shelfPrice: 3.1,
          effectiveComparisonPrice: 3.1
        })
      ]),
      adapter("aldi", [
        product({
          id: "aldi:eggs",
          retailer: "aldi",
          canonicalDisplayName: "Golden Eggs Free Range Eggs 12 Pack",
          rawName: "Golden Eggs Free Range Eggs 12 Pack",
          shelfPrice: 5.2,
          effectiveComparisonPrice: 5.2
        })
      ])
    ]);

    const basket = await service.compareBasket(
      [{ name: "plain flour 1kg" }, { name: "full cream milk 2l" }, { name: "free range eggs 12 pack" }],
      "equivalent",
      { allowLiveScrape: false }
    );

    expect(basket.splitBasket.total).toBeGreaterThan(0);
    expect(basket.lines).toHaveLength(3);
  });

  it("prefers a user-approved substitute when provided", async () => {
    const service = new PricePatrolService([
      adapter("coles", [
        product({
          id: "coles:store-cola-24",
          retailer: "coles",
          canonicalDisplayName: "Cola Zero Soft Drink Cans 24 Pack",
          rawName: "Cola Zero Soft Drink Cans 24 Pack",
          brand: "Cola Zero",
          shelfPrice: 19,
          effectiveComparisonPrice: 19,
          packSize: { value: 24, unit: "each", totalQuantity: 24, comparableUnitType: "count" }
        }),
        product({
          id: "coles:approved-substitute",
          retailer: "coles",
          canonicalDisplayName: "Pepsi Max No Sugar Cola Soft Drink Cans 24 Pack",
          rawName: "Pepsi Max No Sugar Cola Soft Drink Cans 24 Pack",
          brand: "Pepsi Max",
          shelfPrice: 20,
          effectiveComparisonPrice: 20,
          packSize: { value: 24, unit: "each", totalQuantity: 24, comparableUnitType: "count" }
        })
      ])
    ]);

    const result = await service.compareItem("pepsi max 24 pack", "equivalent", {
      allowLiveScrape: false,
      preferredProductIds: ["coles:approved-substitute"]
    });

    expect(result.recommended?.product.id).toBe("coles:approved-substitute");
  });

  it("warns when only substitute brands are available", async () => {
    const service = new PricePatrolService([
      adapter("coles", [
        product({
          id: "coles:cola-24",
          retailer: "coles",
          canonicalDisplayName: "Cola Zero Soft Drink Cans 24 Pack",
          rawName: "Cola Zero Soft Drink Cans 24 Pack",
          brand: "Cola Zero",
          shelfPrice: 19,
          effectiveComparisonPrice: 19,
          packSize: { value: 24, unit: "each", totalQuantity: 24, comparableUnitType: "count" }
        })
      ])
    ]);

    const result = await service.compareItem("Pepsi Max 24 pack", "equivalent", { allowLiveScrape: false });
    expect(result.recommended).toBeDefined();
    expect(result.warnings.some((warning) => warning.includes("No direct pepsi max match"))).toBe(true);
  });
});
