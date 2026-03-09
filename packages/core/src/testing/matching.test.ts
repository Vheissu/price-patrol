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

  it("parses can-count queries and ranks cola-family substitutes", () => {
    const intent = parseSearchIntent("Pepsi Max 30 cans", "equivalent");
    const ranked = rankProducts(
      [
        product({
          id: "aldi:cola-zero-30",
          retailer: "aldi",
          canonicalDisplayName: "Cola Zero Cans 30 Pack",
          rawName: "Cola Zero Cans 30 Pack",
          brand: "Cola Zero",
          shelfPrice: 18,
          effectiveComparisonPrice: 18,
          packSize: { value: 30, unit: "each", totalQuantity: 30, comparableUnitType: "count" }
        }),
        product({
          id: "aldi:lemonade-30",
          retailer: "aldi",
          canonicalDisplayName: "Diet Lemonade Cans 30 Pack",
          rawName: "Diet Lemonade Cans 30 Pack",
          brand: "Lemonade",
          shelfPrice: 17,
          effectiveComparisonPrice: 17,
          packSize: { value: 30, unit: "each", totalQuantity: 30, comparableUnitType: "count" }
        })
      ],
      intent
    );

    expect(intent.desiredPackSize?.totalQuantity).toBe(30);
    expect(intent.coreType).toBe("zero sugar cola");
    expect(ranked[0]?.product.id).toBe("aldi:cola-zero-30");
    expect(
      ranked[0]?.reasons.some((reason) => reason.includes("product family") || reason.includes("store-brand substitute"))
    ).toBe(true);
  });

  it("recognizes known substitute brands within a family", () => {
    const intent = parseSearchIntent("Red Bull 4 pack", "equivalent");
    const ranked = rankProducts(
      [
        product({
          id: "aldi:flying-power",
          retailer: "aldi",
          canonicalDisplayName: "Flying Power Energy Drink 4 Pack",
          rawName: "Flying Power Energy Drink 4 Pack",
          brand: "Flying Power",
          shelfPrice: 8,
          effectiveComparisonPrice: 8,
          packSize: { value: 4, unit: "each", totalQuantity: 4, comparableUnitType: "count" }
        })
      ],
      intent
    );

    expect(ranked[0]?.product.id).toBe("aldi:flying-power");
    expect(ranked[0]?.reasons).toContain("Known store-brand substitute for the requested branded product.");
  });

  it("maps cereal brand searches into family terms for substitutes", () => {
    const intent = parseSearchIntent("Weet-Bix 24 pack", "equivalent");
    const ranked = rankProducts(
      [
        product({
          id: "aldi:wheat-biscuits",
          retailer: "aldi",
          canonicalDisplayName: "Wheat Biscuits Cereal 24 Pack",
          rawName: "Wheat Biscuits Cereal 24 Pack",
          brand: "Harvest Morn",
          shelfPrice: 4.5,
          effectiveComparisonPrice: 4.5,
          packSize: { value: 24, unit: "each", totalQuantity: 24, comparableUnitType: "count" }
        }),
        product({
          id: "aldi:corn-flakes",
          retailer: "aldi",
          canonicalDisplayName: "Corn Flakes Cereal 650g",
          rawName: "Corn Flakes Cereal 650g",
          brand: "Harvest Morn",
          shelfPrice: 3.2,
          effectiveComparisonPrice: 3.2,
          packSize: { value: 650, unit: "g", totalQuantity: 650, comparableUnitType: "mass" }
        })
      ],
      intent
    );

    expect(intent.coreType).toBe("wheat biscuits cereal");
    expect(ranked[0]?.product.id).toBe("aldi:wheat-biscuits");
  });

  it("maps toothpaste brand searches into toothpaste families", () => {
    const intent = parseSearchIntent("Colgate Toothpaste", "equivalent");
    const ranked = rankProducts(
      [
        product({
          id: "aldi:toothpaste",
          retailer: "aldi",
          canonicalDisplayName: "Dental Care Toothpaste 110g",
          rawName: "Dental Care Toothpaste 110g",
          brand: "Dental Care",
          shelfPrice: 2.5,
          effectiveComparisonPrice: 2.5,
          packSize: { value: 110, unit: "g", totalQuantity: 110, comparableUnitType: "mass" }
        })
      ],
      intent
    );

    expect(intent.coreType).toBe("toothpaste");
    expect(ranked[0]?.product.id).toBe("aldi:toothpaste");
  });

  it("maps pain relief brands into the active ingredient family", () => {
    const intent = parseSearchIntent("Panadol 20 tablets", "equivalent");
    const ranked = rankProducts(
      [
        product({
          id: "aldi:paracetamol",
          retailer: "aldi",
          canonicalDisplayName: "Paracetamol Tablets 20 Pack",
          rawName: "Paracetamol Tablets 20 Pack",
          brand: "Pharmacy Care",
          shelfPrice: 1.9,
          effectiveComparisonPrice: 1.9,
          packSize: { value: 20, unit: "each", totalQuantity: 20, comparableUnitType: "count" }
        })
      ],
      intent
    );

    expect(intent.coreType).toBe("paracetamol tablets");
    expect(ranked[0]?.product.id).toBe("aldi:paracetamol");
  });

  it("maps mouthwash and wipes into their own substitute families", () => {
    const mouthwashIntent = parseSearchIntent("Listerine Mouthwash", "equivalent");
    const mouthwashRanked = rankProducts(
      [
        product({
          id: "aldi:mouthwash",
          retailer: "aldi",
          canonicalDisplayName: "Fresh Mint Mouthwash 1L",
          rawName: "Fresh Mint Mouthwash 1L",
          brand: "Dental Care",
          shelfPrice: 4.2,
          effectiveComparisonPrice: 4.2,
          packSize: { value: 1, unit: "l", totalQuantity: 1000, comparableUnitType: "volume" }
        })
      ],
      mouthwashIntent
    );

    const wipesIntent = parseSearchIntent("Disinfectant cleaning wipes", "equivalent");
    const wipesRanked = rankProducts(
      [
        product({
          id: "aldi:wipes",
          retailer: "aldi",
          canonicalDisplayName: "Surface Cleaning Wipes 120 Pack",
          rawName: "Surface Cleaning Wipes 120 Pack",
          brand: "Power Force",
          shelfPrice: 4.5,
          effectiveComparisonPrice: 4.5,
          packSize: { value: 120, unit: "each", totalQuantity: 120, comparableUnitType: "count" }
        })
      ],
      wipesIntent
    );

    expect(mouthwashIntent.coreType).toBe("mouthwash");
    expect(mouthwashRanked[0]?.product.id).toBe("aldi:mouthwash");
    expect(wipesIntent.coreType).toBe("disinfectant wipes");
    expect(wipesRanked[0]?.product.id).toBe("aldi:wipes");
  });

  it("maps cleaning brand searches into cleaner families", () => {
    const intent = parseSearchIntent("Glen 20", "equivalent");
    const ranked = rankProducts(
      [
        product({
          id: "aldi:disinfectant-spray",
          retailer: "aldi",
          canonicalDisplayName: "Disinfectant Spray 300g",
          rawName: "Disinfectant Spray 300g",
          brand: "Power Force",
          shelfPrice: 3.6,
          effectiveComparisonPrice: 3.6,
          packSize: { value: 300, unit: "g", totalQuantity: 300, comparableUnitType: "mass" }
        }),
        product({
          id: "aldi:multipurpose-cleaner",
          retailer: "aldi",
          canonicalDisplayName: "Multipurpose Cleaner Spray 500mL",
          rawName: "Multipurpose Cleaner Spray 500mL",
          brand: "Power Force",
          shelfPrice: 2.8,
          effectiveComparisonPrice: 2.8,
          packSize: { value: 500, unit: "ml", totalQuantity: 500, comparableUnitType: "volume" }
        })
      ],
      intent
    );

    expect(intent.coreType).toBe("disinfectant spray");
    expect(ranked[0]?.product.id).toBe("aldi:disinfectant-spray");
  });

  it("rejects disinfectant liquids for a wipes query", () => {
    const intent = parseSearchIntent("Disinfectant cleaning wipes", "equivalent");
    const ranked = rankProducts(
      [
        product({
          id: "aldi:liquid-disinfectant",
          retailer: "aldi",
          canonicalDisplayName: "Assorted Disinfectant 1.25L",
          rawName: "Assorted Disinfectant 1.25L",
          brand: "Power Force",
          shelfPrice: 2.8,
          effectiveComparisonPrice: 2.8,
          packSize: { value: 1.25, unit: "l", totalQuantity: 1250, comparableUnitType: "volume" }
        })
      ],
      intent
    );

    expect(ranked).toHaveLength(0);
  });

  it("rejects unrelated tablet products for aspirin queries", () => {
    const intent = parseSearchIntent("Aspirin", "equivalent");
    const ranked = rankProducts(
      [
        product({
          id: "aldi:denture-tabs",
          retailer: "aldi",
          canonicalDisplayName: "Whitening Denture Cleaning Tablets 48 Pack",
          rawName: "Whitening Denture Cleaning Tablets 48 Pack",
          brand: "Dental Care",
          shelfPrice: 2.99,
          effectiveComparisonPrice: 2.99,
          packSize: { value: 48, unit: "each", totalQuantity: 48, comparableUnitType: "count" }
        })
      ],
      intent
    );

    expect(ranked).toHaveLength(0);
  });

  it("maps snack brand searches into chip families", () => {
    const intent = parseSearchIntent("Doritos 170g", "equivalent");
    const ranked = rankProducts(
      [
        product({
          id: "aldi:corn-chips",
          retailer: "aldi",
          canonicalDisplayName: "Corn Chips Nacho Cheese 170g",
          rawName: "Corn Chips Nacho Cheese 170g",
          brand: "Snack Rite",
          shelfPrice: 2.9,
          effectiveComparisonPrice: 2.9,
          packSize: { value: 170, unit: "g", totalQuantity: 170, comparableUnitType: "mass" }
        }),
        product({
          id: "aldi:potato-chips",
          retailer: "aldi",
          canonicalDisplayName: "Sea Salt Potato Chips 175g",
          rawName: "Sea Salt Potato Chips 175g",
          brand: "Snack Rite",
          shelfPrice: 2.7,
          effectiveComparisonPrice: 2.7,
          packSize: { value: 175, unit: "g", totalQuantity: 175, comparableUnitType: "mass" }
        })
      ],
      intent
    );

    expect(intent.coreType).toBe("corn chips");
    expect(ranked[0]?.product.id).toBe("aldi:corn-chips");
  });

  it("maps generic biscuits queries into biscuit-family substitutes", () => {
    const intent = parseSearchIntent("Biscuits", "equivalent");
    const ranked = rankProducts(
      [
        product({
          id: "aldi:sweet-biscuits",
          retailer: "aldi",
          canonicalDisplayName: "Chocolate Biscuits 200g",
          rawName: "Chocolate Biscuits 200g",
          brand: "Biscuit Co",
          shelfPrice: 2.8,
          effectiveComparisonPrice: 2.8,
          packSize: { value: 200, unit: "g", totalQuantity: 200, comparableUnitType: "mass" }
        })
      ],
      intent
    );

    expect(intent.coreType).toBe("sweet biscuits");
    expect(ranked[0]?.product.id).toBe("aldi:sweet-biscuits");
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

  it("requires a generic anchor term for uncategorized searches", () => {
    const intent = parseSearchIntent("brown rice", "equivalent");
    const ranked = rankProducts(
      [
        product({
          id: "aldi:brown-onions",
          retailer: "aldi",
          canonicalDisplayName: "Brown Onions Loose approx. 0.18 kg per piece",
          rawName: "Brown Onions Loose approx. 0.18 kg per piece",
          shelfPrice: 0.63,
          effectiveComparisonPrice: 0.63,
          packSize: { value: 0.18, unit: "kg", totalQuantity: 180, comparableUnitType: "mass" }
        }),
        product({
          id: "woolworths:brown-rice",
          retailer: "woolworths",
          canonicalDisplayName: "Long Grain Brown Rice 1kg",
          rawName: "Long Grain Brown Rice 1kg",
          shelfPrice: 3.2,
          effectiveComparisonPrice: 3.2,
          packSize: { value: 1, unit: "kg", totalQuantity: 1000, comparableUnitType: "mass" }
        })
      ],
      intent
    );

    expect(intent.requiredMatchTerms).toContain("rice");
    expect(ranked[0]?.product.id).toBe("woolworths:brown-rice");
    expect(ranked.some((candidate) => candidate.product.id === "aldi:brown-onions")).toBe(false);
  });

  it("prefers plain brown rice over crackers and microwave variants", () => {
    const intent = parseSearchIntent("brown rice", "equivalent");
    const ranked = rankProducts(
      [
        product({
          id: "coles:brown-rice-crackers",
          retailer: "coles",
          canonicalDisplayName: "Coles Brown Rice Crackers 100g",
          rawName: "Coles Brown Rice Crackers 100g",
          shelfPrice: 0.9,
          effectiveComparisonPrice: 0.9,
          packSize: { value: 100, unit: "g", totalQuantity: 100, comparableUnitType: "mass" }
        }),
        product({
          id: "coles:microwave-brown-rice",
          retailer: "coles",
          canonicalDisplayName: "Coles Microwave Rice Brown 250g",
          rawName: "Coles Microwave Rice Brown 250g",
          shelfPrice: 1.8,
          effectiveComparisonPrice: 1.8,
          packSize: { value: 250, unit: "g", totalQuantity: 250, comparableUnitType: "mass" }
        }),
        product({
          id: "coles:brown-rice-1kg",
          retailer: "coles",
          canonicalDisplayName: "Coles Brown Rice 1kg",
          rawName: "Coles Brown Rice 1kg",
          shelfPrice: 2.5,
          effectiveComparisonPrice: 2.5,
          packSize: { value: 1, unit: "kg", totalQuantity: 1000, comparableUnitType: "mass" }
        })
      ],
      intent
    );

    expect(intent.coreType).toBe("brown rice");
    expect(intent.excludedMatchTerms).toContain("crackers");
    expect(ranked[0]?.product.id).toBe("coles:brown-rice-1kg");
    expect(ranked.some((candidate) => candidate.product.id === "coles:brown-rice-crackers")).toBe(false);
    expect(ranked.some((candidate) => candidate.product.id === "coles:microwave-brown-rice")).toBe(false);
  });
});
