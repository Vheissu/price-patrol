import { SearchIntent, ComparisonMode, ParsedSize, ComparableUnitType, FreshnessLevel } from "../types/domain.js";

const ATTRIBUTE_TERMS = [
  "plain",
  "self raising",
  "self-raising",
  "gluten free",
  "gluten-free",
  "organic",
  "wholemeal",
  "full cream",
  "skim",
  "unsalted",
  "salted",
  "free range",
  "cage free",
  "greek",
  "low fat",
  "lactose free"
];

const BRANDS = [
  "coles",
  "woolworths",
  "aldi",
  "pepsi max",
  "pepsi",
  "suimin",
  "essentials",
  "white wings",
  "macro",
  "the healthy baker",
  "goldenvale",
  "brooklea"
];

const COUNT_TERMS = new Set(["pack", "pk", "count", "each"]);

export function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9.%/\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function comparableUnitFor(unit: string): ComparableUnitType {
  if (["g", "kg"].includes(unit)) {
    return "mass";
  }
  if (["ml", "l"].includes(unit)) {
    return "volume";
  }
  if (["each", "ct"].includes(unit)) {
    return "count";
  }
  return "unknown";
}

export function parsePackSize(input: string): ParsedSize | undefined {
  const normalized = normalizeText(input);
  const multipack = normalized.match(/(\d+)\s*x\s*(\d+(?:\.\d+)?)\s*(kg|g|l|ml|each|ct)\b/);
  if (multipack) {
    const count = Number(multipack[1]);
    const value = Number(multipack[2]);
    const unit = standardizeUnit(multipack[3]);
    const comparableUnitType = comparableUnitFor(unit);
    return {
      value,
      unit,
      totalQuantity: normalizeQuantity(value, unit) * count,
      comparableUnitType,
      multipackQuantity: count
    };
  }

  const reversedMultipack = normalized.match(/(\d+(?:\.\d+)?)\s*(kg|g|l|ml)\s*x\s*(\d+)\b/);
  if (reversedMultipack) {
    const value = Number(reversedMultipack[1]);
    const unit = standardizeUnit(reversedMultipack[2]);
    const count = Number(reversedMultipack[3]);
    const comparableUnitType = comparableUnitFor(unit);
    return {
      value,
      unit,
      totalQuantity: normalizeQuantity(value, unit) * count,
      comparableUnitType,
      multipackQuantity: count
    };
  }

  const simple = normalized.match(/(\d+(?:\.\d+)?)\s*(kg|g|l|ml)\b|(\d+)\s*(pack|pk|count|each|ct)\b/);
  if (!simple) {
    return undefined;
  }

  if (simple[1] && simple[2]) {
    const value = Number(simple[1]);
    const unit = standardizeUnit(simple[2]);
    return {
      value,
      unit,
      totalQuantity: normalizeQuantity(value, unit),
      comparableUnitType: comparableUnitFor(unit)
    };
  }

  const count = Number(simple[3]);
  return {
    value: count,
    unit: "each",
    totalQuantity: count,
    comparableUnitType: "count"
  };
}

function standardizeUnit(unit: string): string {
  const lower = unit.toLowerCase();
  if (COUNT_TERMS.has(lower)) {
    return "each";
  }
  return lower;
}

export function normalizeQuantity(value: number, unit: string): number {
  if (unit === "kg" || unit === "l") {
    return value * 1000;
  }
  return value;
}

export function parseMoney(input?: string | null): number | undefined {
  if (!input) {
    return undefined;
  }
  const match = input.match(/(\d+(?:\.\d+)?)/);
  return match ? Number(match[1]) : undefined;
}

export function parseUnitPrice(input?: string | null): { value: number; unit: string } | undefined {
  if (!input) {
    return undefined;
  }
  const match = input.replace(/\s+/g, "").match(/\$?(\d+(?:\.\d+)?)\/(100g|1kg|100ml|1l|1each|1ct|1kg|1ml)/i);
  if (!match) {
    return undefined;
  }
  return {
    value: Number(match[1]),
    unit: match[2].toLowerCase()
  };
}

export function deriveFreshness(timestamp: string): FreshnessLevel {
  const ageMs = Date.now() - new Date(timestamp).getTime();
  const ageHours = ageMs / 3_600_000;
  if (ageHours <= 12) {
    return "fresh";
  }
  if (ageHours <= 48) {
    return "recent";
  }
  if (ageHours <= 168) {
    return "aging";
  }
  return "stale";
}

export function parseSearchIntent(query: string, comparisonMode: ComparisonMode): SearchIntent {
  const normalizedQuery = normalizeText(query);
  const desiredPackSize = parsePackSize(normalizedQuery);
  const attributeTerms = ATTRIBUTE_TERMS.filter((term) => normalizedQuery.includes(term));
  const brandPreference = BRANDS.find((brand) => normalizedQuery.includes(brand));

  let coreType = normalizedQuery;
  if (desiredPackSize) {
    coreType = coreType.replace(/\b\d+(?:\.\d+)?\s*(kg|g|l|ml|pack|pk|count|each|ct)\b/g, " ").trim();
  }
  for (const term of attributeTerms) {
    coreType = coreType.replace(term, " ").trim();
  }
  if (brandPreference) {
    coreType = coreType.replace(brandPreference, " ").trim();
  }
  coreType = coreType.replace(/\s+/g, " ").trim() || normalizedQuery;

  return {
    rawQuery: query,
    normalizedQuery,
    comparisonMode,
    coreType,
    variantTerms: attributeTerms,
    attributeTerms,
    excludedTerms: [],
    brandPreference,
    desiredPackSize
  };
}
