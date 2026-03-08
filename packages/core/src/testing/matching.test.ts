import { describe, expect, it } from "vitest";
import { rankProducts } from "../comparison/matching.js";
import { parseSearchIntent } from "../parsing/query.js";
import { NormalizedProduct } from "../types/domain.js";

const now = new Date().toISOString();

function product(input: Partial<NormalizedProduct> & Pick<NormalizedProduct, "id" | "canonicalDisplayName" | "rawName" | "shelfPrice" | "effectiveComparisonPrice">): NormalizedProduct {
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
    retailer: "coles",
    sourceUrl: "https://example.test/product",
    sourceType: "historical",
    categoryPath: ["Pantry"],
    structuredAttributes: [],
    ...input
  };
}

describe("rankProducts", () => {
  it("uses normalized unit economics when pack sizes differ", () => {
    const intent = parseSearchIntent("plain flour 1kg", "equivalent");
    const ranked = rankProducts(
      [
        product({
          id: "cheap-half",
          canonicalDisplayName: "Store Plain Flour 500g",
          rawName: "Store Plain Flour 500g",
          structuredAttributes: ["plain"],
          shelfPrice: 0.95,
          effectiveComparisonPrice: 0.95,
          packSize: { value: 500, unit: "g", totalQuantity: 500, comparableUnitType: "mass" },
          unitPrice: { value: 1.9, unit: "1kg", inferred: false }
        }),
        product({
          id: "better-kilo",
          retailer: "woolworths",
          canonicalDisplayName: "Store Plain Flour 1kg",
          rawName: "Store Plain Flour 1kg",
          structuredAttributes: ["plain"],
          shelfPrice: 1.5,
          effectiveComparisonPrice: 1.5,
          packSize: { value: 1, unit: "kg", totalQuantity: 1000, comparableUnitType: "mass" },
          unitPrice: { value: 1.5, unit: "1kg", inferred: false }
        })
      ],
      intent
    );

    expect(ranked[0]?.product.id).toBe("better-kilo");
  });

  it("rejects non-comparable units for sized requests", () => {
    const intent = parseSearchIntent("full cream milk 1l", "equivalent");
    const ranked = rankProducts(
      [
        product({
          id: "eggs-pack",
          canonicalDisplayName: "Free Range Eggs 12 pack",
          rawName: "Free Range Eggs 12 pack",
          structuredAttributes: ["free range"],
          shelfPrice: 5.5,
          effectiveComparisonPrice: 5.5,
          packSize: { value: 12, unit: "each", totalQuantity: 12, comparableUnitType: "count" }
        })
      ],
      intent
    );

    expect(ranked).toHaveLength(0);
  });

  it("uses multipack count compatibility for can-pack requests", () => {
    const intent = parseSearchIntent("Pepsi Max 30 pack", "equivalent");
    const ranked = rankProducts(
      [
        product({
          id: "pepsi-24",
          canonicalDisplayName: "Pepsi Max No Sugar Cola Soft Drink Cans Multipack 375ml x 24 Pack",
          rawName: "Pepsi Max No Sugar Cola Soft Drink Cans Multipack 375ml x 24 Pack",
          brand: "Pepsi Max",
          shelfPrice: 20,
          effectiveComparisonPrice: 20,
          packSize: { value: 375, unit: "ml", totalQuantity: 9000, comparableUnitType: "volume", multipackQuantity: 24 },
          unitPrice: { value: 2.22, unit: "1l", inferred: false }
        }),
        product({
          id: "pepsi-30",
          canonicalDisplayName: "Pepsi Max No Sugar Cola Soft Drink Cans Multipack 375ml x 30 Pack",
          rawName: "Pepsi Max No Sugar Cola Soft Drink Cans Multipack 375ml x 30 Pack",
          brand: "Pepsi Max",
          shelfPrice: 25,
          effectiveComparisonPrice: 25,
          packSize: { value: 375, unit: "ml", totalQuantity: 11250, comparableUnitType: "volume", multipackQuantity: 30 },
          unitPrice: { value: 2.22, unit: "1l", inferred: false }
        })
      ],
      intent
    );

    expect(ranked[0]?.product.id).toBe("pepsi-30");
  });

  it("boosts a user-approved substitute for the same query", () => {
    const intent = parseSearchIntent("organic greek yoghurt 1kg", "equivalent");
    const ranked = rankProducts(
      [
        product({
          id: "regular-greek",
          canonicalDisplayName: "Store Greek Style Yoghurt 1kg",
          rawName: "Store Greek Style Yoghurt 1kg",
          shelfPrice: 4.2,
          effectiveComparisonPrice: 4.2,
          packSize: { value: 1, unit: "kg", totalQuantity: 1000, comparableUnitType: "mass" }
        }),
        product({
          id: "approved-substitute",
          canonicalDisplayName: "Organic Pot Set Greek Style Yoghurt 1kg",
          rawName: "Organic Pot Set Greek Style Yoghurt 1kg",
          shelfPrice: 4.8,
          effectiveComparisonPrice: 4.8,
          packSize: { value: 1, unit: "kg", totalQuantity: 1000, comparableUnitType: "mass" }
        })
      ],
      intent,
      { preferredProductIds: ["approved-substitute"] }
    );

    expect(ranked[0]?.product.id).toBe("approved-substitute");
    expect(ranked[0]?.reasons).toContain("User-approved substitute for this query.");
  });
});
