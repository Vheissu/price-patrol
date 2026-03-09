import { deriveFreshness, parseMoney, parsePackSize, parseUnitPrice } from "../../parsing/query.js";
import { NormalizedProduct, RetailerId, SourceType } from "../../types/domain.js";

export function buildProductFromScrape(input: {
  retailer: RetailerId;
  productId?: string;
  sourceUrl: string;
  sourceType: SourceType;
  imageUrl?: string;
  rawName: string;
  brand?: string;
  unitPriceText?: string | null;
  shelfPriceText?: string | null;
  shelfPrice?: number;
  promotionText?: string | null;
  categoryPath?: string[];
  availabilityState?: NormalizedProduct["availabilityState"];
  structuredAttributes?: string[];
  diagnostics?: Record<string, unknown>;
  storeContext?: NormalizedProduct["storeContext"];
}): NormalizedProduct | null {
  const timestamp = new Date().toISOString();
  const shelfPrice = input.shelfPrice ?? parseMoney(input.shelfPriceText);
  if (shelfPrice == null) {
    return null;
  }

  const parsedUnitPrice = parseUnitPrice(input.unitPriceText ?? null);
  const packSize = parsePackSize(input.rawName);

  return {
    id: `${input.retailer}:${input.productId ?? input.sourceUrl}`,
    retailer: input.retailer,
    retailerProductId: input.productId,
    sourceUrl: input.sourceUrl,
    sourceType: input.sourceType,
    imageUrl: input.imageUrl,
    storeContext: input.storeContext,
    canonicalDisplayName: input.rawName.replace(/\s+/g, " ").trim(),
    rawName: input.rawName,
    brand: input.brand,
    productLine: undefined,
    variantDescriptor: undefined,
    categoryPath: input.categoryPath ?? [],
    structuredAttributes: input.structuredAttributes ?? [],
    packSize,
    unitPrice: parsedUnitPrice
      ? {
          value: parsedUnitPrice.value,
          unit: parsedUnitPrice.unit,
          inferred: false
        }
      : packSize
        ? {
            value: Number((shelfPrice / (packSize.totalQuantity / 1000)).toFixed(2)),
            unit: packSize.comparableUnitType === "volume" ? "1l" : packSize.comparableUnitType === "mass" ? "1kg" : "1each",
            inferred: true
          }
        : undefined,
    shelfPrice,
    promotionalPrice: undefined,
    promotionText: input.promotionText ?? undefined,
    effectiveComparisonPrice: shelfPrice,
    currency: "AUD",
    priceScope: "store",
    priceConfidence: 0.82,
    availabilityState: input.availabilityState ?? "unknown",
    availabilityConfidence: 0.65,
    lowStock: input.availabilityState === "low-stock",
    lastFetchedAt: timestamp,
    lastParsedAt: timestamp,
    sourceSnapshotAt: timestamp,
    freshness: deriveFreshness(timestamp),
    notes: [],
    warnings: [],
    diagnostics: input.diagnostics
  };
}
