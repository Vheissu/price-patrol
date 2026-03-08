import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { resolveProjectPath } from "../../config/project-config.js";
import { deriveFreshness, normalizeText } from "../../parsing/query.js";
import { ComparableUnitType, NormalizedProduct, RetailerId, SearchIntent } from "../../types/domain.js";

type HistoricalRow = {
  product_id: string;
  retailer: RetailerId;
  canonical_name: string;
  brand?: string | null;
  query_text?: string | null;
  pack_quantity?: number | null;
  pack_unit?: string | null;
  comparable_unit_type?: ComparableUnitType | null;
  shelf_price: number;
  promotional_price?: number | null;
  effective_price: number;
  unit_price?: number | null;
  unit_price_unit?: string | null;
  promotion_text?: string | null;
  availability_state: NormalizedProduct["availabilityState"];
  observed_at: string;
  source_url?: string | null;
  source_type?: NormalizedProduct["sourceType"] | null;
};

export function getHistoricalFallbackProducts(
  retailer: RetailerId,
  intent: SearchIntent,
  maxResults: number
): NormalizedProduct[] {
  const databasePath = resolveProjectPath(".price-patrol-data/price-patrol.db");
  if (!existsSync(databasePath)) {
    return [];
  }

  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(databasePath, { timeout: 1_000 });
    const rows = db.prepare(`
      SELECT product_id, retailer, canonical_name, brand, query_text, pack_quantity, pack_unit,
             comparable_unit_type, shelf_price, promotional_price, effective_price, unit_price,
             unit_price_unit, promotion_text, availability_state, observed_at, source_url, source_type
      FROM product_observations
      WHERE retailer = :retailer AND source_url IS NOT NULL AND source_url != ''
      ORDER BY observed_at DESC
      LIMIT 300
    `).all({ retailer }) as HistoricalRow[];

    const deduped = new Map<string, HistoricalRow>();
    for (const row of rows) {
      if (!deduped.has(row.product_id)) {
        deduped.set(row.product_id, row);
      }
    }

    return Array.from(deduped.values())
      .filter((row) => matchesIntent(row, intent))
      .slice(0, maxResults)
      .map((row) => toHistoricalProduct(row));
  } catch {
    return [];
  } finally {
    db?.close();
  }
}

function matchesIntent(row: HistoricalRow, intent: SearchIntent): boolean {
  const haystack = normalizeText([row.canonical_name, row.brand, row.query_text].filter(Boolean).join(" "));
  const coreMatch = haystack.includes(intent.coreType) || intent.coreType.split(" ").every((term) => haystack.includes(term));
  const attributeMatch = intent.attributeTerms.every((term) => haystack.includes(term));
  const brandMatch = intent.brandPreference ? haystack.includes(intent.brandPreference) : true;
  return coreMatch || (attributeMatch && brandMatch);
}

function toHistoricalProduct(row: HistoricalRow): NormalizedProduct {
  const timestamp = row.observed_at;
  const packSize =
    row.pack_quantity != null && row.pack_unit && row.comparable_unit_type
      ? {
          value: row.pack_quantity,
          unit: row.pack_unit,
          totalQuantity: row.pack_unit === "kg" || row.pack_unit === "l" ? row.pack_quantity * 1000 : row.pack_quantity,
          comparableUnitType: row.comparable_unit_type
        }
      : undefined;

  return {
    id: row.product_id,
    retailer: row.retailer,
    retailerProductId: row.product_id.includes(":") ? row.product_id.split(":").slice(1).join(":") : row.product_id,
    sourceUrl: row.source_url ?? "",
    sourceType: row.source_type === "search" || row.source_type === "detail" || row.source_type === "network" ? row.source_type : "historical",
    canonicalDisplayName: row.canonical_name,
    rawName: row.canonical_name,
    brand: row.brand ?? undefined,
    productLine: undefined,
    variantDescriptor: undefined,
    categoryPath: [],
    structuredAttributes: [],
    packSize,
    unitPrice:
      row.unit_price != null && row.unit_price_unit
        ? {
            value: row.unit_price,
            unit: row.unit_price_unit,
            inferred: false
          }
        : undefined,
    shelfPrice: row.shelf_price,
    promotionalPrice: row.promotional_price ?? undefined,
    promotionText: row.promotion_text ?? undefined,
    effectiveComparisonPrice: row.effective_price,
    currency: "AUD",
    priceScope: "store",
    priceConfidence: 0.74,
    availabilityState: row.availability_state,
    availabilityConfidence: 0.7,
    lowStock: row.availability_state === "low-stock",
    lastFetchedAt: timestamp,
    lastParsedAt: timestamp,
    sourceSnapshotAt: timestamp,
    freshness: deriveFreshness(timestamp),
    notes: ["Returned from the historical SQLite catalog."],
    warnings: ["Using previously observed product data because live scraping was unavailable."],
    diagnostics: {
      historical: true,
      observedAt: timestamp
    }
  };
}
