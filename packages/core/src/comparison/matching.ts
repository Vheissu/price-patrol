import { fuzzy } from "fast-fuzzy";
import { NormalizedProduct, RankedProduct, SearchIntent, MatchOutcome, ComparisonMode } from "../types/domain.js";
import { comparableUnitFor, normalizeQuantity, normalizeText } from "../parsing/query.js";

const CRITICAL_ATTRIBUTE_GROUPS = [
  ["plain", "self raising", "self-raising", "wholemeal"],
  ["gluten free", "gluten-free"],
  ["full cream", "skim"],
  ["free range", "cage free"],
  ["unsalted", "salted"]
];

const STOPWORDS = new Set(["a", "an", "and", "or", "the", "of", "with", "style"]);

export function rankProducts(
  products: NormalizedProduct[],
  intent: SearchIntent,
  options: { preferredProductIds?: string[] } = {}
): RankedProduct[] {
  return products
    .map((product) => scoreProduct(product, intent, options))
    .filter((candidate) => candidate.outcome !== "rejected")
    .sort((left, right) => right.rankingScore - left.rankingScore);
}

function scoreProduct(
  product: NormalizedProduct,
  intent: SearchIntent,
  options: { preferredProductIds?: string[] }
): RankedProduct {
  const productText = normalizeText(
    [
      product.canonicalDisplayName,
      product.rawName,
      product.brand,
      product.variantDescriptor,
      product.structuredAttributes.join(" ")
    ]
      .filter(Boolean)
      .join(" ")
  );
  const requestedCoreTokens = tokenize(intent.coreType);
  const productTokens = tokenize(productText);
  const semanticTokens = Array.from(new Set(intent.familyTerms.flatMap((term) => tokenize(term))));

  const reasons: string[] = [];
  let confidence = fuzzy(intent.coreType, productText);
  let packSizeBonus = 0;
  let preferenceBonus = 0;
  if (productText.includes(intent.coreType)) {
    confidence += 0.18;
    reasons.push("Product name aligns closely with the requested item.");
  }

  const tokenCoverage = computeTokenCoverage(requestedCoreTokens, productTokens);
  confidence += tokenCoverage * 0.22;
  if (tokenCoverage >= 0.75) {
    reasons.push("Core product terms are strongly covered.");
  } else if (requestedCoreTokens.length > 0 && tokenCoverage < 0.34) {
    const semanticCoverage = computeTokenCoverage(semanticTokens, productTokens);
    if (semanticCoverage < 0.34) {
      return rejected(product, "Core product terms do not align closely enough.");
    }
  }

  if (intent.requiredMatchTerms.length && !matchesAnyPhrase(productText, intent.requiredMatchTerms)) {
    return rejected(product, "Product misses the required family-specific terms.");
  }

  if (intent.excludedMatchTerms.length && matchesAnyPhrase(productText, intent.excludedMatchTerms)) {
    return rejected(product, "Product matches excluded terms for this family.");
  }

  const semanticCoverage = computeTokenCoverage(semanticTokens, productTokens);
  const substituteTermMatched = intent.substituteTerms.some((term) => productText.includes(term));
  if (semanticCoverage > 0) {
    confidence += semanticCoverage * 0.18;
    if (semanticCoverage >= 0.34) {
      reasons.push("Matches the same product family.");
    }
  }
  if (substituteTermMatched) {
    confidence += 0.1;
    reasons.push("Known store-brand substitute for the requested branded product.");
  }

  for (const attribute of intent.attributeTerms) {
    if (productText.includes(attribute)) {
      confidence += 0.12;
      reasons.push(`Required attribute "${attribute}" is present.`);
    } else if (isCriticalAttribute(attribute)) {
      return rejected(product, `Required attribute "${attribute}" is missing.`);
    }
  }

  for (const group of CRITICAL_ATTRIBUTE_GROUPS) {
    const requested = group.find((term) => intent.attributeTerms.includes(term));
    if (!requested) {
      continue;
    }
    const conflicting = group.filter((term) => term !== requested);
    if (conflicting.some((term) => productText.includes(term))) {
      return rejected(product, `Product conflicts with requested variant "${requested}".`);
    }
  }

  if (intent.brandPreference) {
    if (productText.includes(intent.brandPreference)) {
      confidence += 0.1;
      reasons.push("Brand preference matched.");
    } else if (intent.comparisonMode === "exact") {
      return rejected(product, "Exact match mode requires the requested brand.");
    } else if (substituteTermMatched || semanticCoverage >= 0.5) {
      confidence -= 0.02;
      reasons.push("Brand differs, but the product family still aligns.");
    } else {
      confidence -= 0.08;
      reasons.push("Brand differs from the preferred brand.");
    }
  }

  if (options.preferredProductIds?.includes(product.id)) {
    confidence += 0.14;
    preferenceBonus += 0.6;
    reasons.push("User-approved substitute for this query.");
  }

  if (intent.desiredPackSize && product.packSize) {
    const sizeCompatibility = comparePackSize(intent.desiredPackSize, product.packSize);
    if (!sizeCompatibility.compatible) {
      return rejected(product, "Pack size uses a non-comparable unit.");
    }

    confidence += sizeCompatibility.closeness * 0.16;
    packSizeBonus += sizeCompatibility.closeness * 0.4;
    if (sizeCompatibility.closeness > 0.9) {
      reasons.push("Pack size is effectively the same.");
    } else if (sizeCompatibility.closeness > 0.5) {
      reasons.push("Pack size is comparable, so normalized price can be used.");
    } else if (intent.comparisonMode === "exact") {
      return rejected(product, "Exact match mode rejected a materially different pack size.");
    } else {
      confidence -= 0.12;
      reasons.push("Pack size differs noticeably.");
    }
  } else if (intent.desiredPackSize && !product.packSize) {
    if (intent.comparisonMode === "exact") {
      return rejected(product, "Exact match mode requires a verifiable pack size.");
    }
    confidence -= 0.1;
    reasons.push("Pack size could not be verified.");
  }

  const normalizedConfidence = Math.max(0, Math.min(1, confidence));
  const effectivePrice = effectiveRankingPrice(product, intent);
  const priceScore = effectivePrice > 0 ? 1 / effectivePrice : 0;
  const freshnessBonus = freshnessWeight(product.freshness);
  const availabilityPenalty = product.availabilityState === "out-of-stock" ? 0.4 : product.lowStock ? 0.08 : 0;
  const rankingScore = normalizedConfidence * 3 + priceScore * 2 + freshnessBonus + packSizeBonus + preferenceBonus - availabilityPenalty;

  return {
    product,
    confidence: normalizedConfidence,
    outcome: deriveOutcome(normalizedConfidence, intent.comparisonMode),
    rankingScore,
    reasons
  };
}

function deriveOutcome(confidence: number, comparisonMode: ComparisonMode): MatchOutcome {
  if (comparisonMode === "exact" && confidence >= 0.86) {
    return "exact-match";
  }
  if (confidence >= 0.8) {
    return comparisonMode === "exact" ? "high-confidence-equivalent" : "high-confidence-equivalent";
  }
  if (confidence >= 0.62) {
    return "moderate-confidence-equivalent";
  }
  if (confidence >= 0.48) {
    return "low-confidence-substitute";
  }
  return "rejected";
}

function effectiveRankingPrice(product: NormalizedProduct, intent: SearchIntent): number {
  const shelfLikePrice = product.promotionalPrice ?? product.shelfPrice;

  if (intent.comparisonMode === "best-value" && product.unitPrice) {
    return product.unitPrice.value;
  }

  if (
    intent.comparisonMode !== "exact" &&
    intent.desiredPackSize?.comparableUnitType === "count" &&
    product.packSize?.multipackQuantity &&
    product.packSize.multipackQuantity > 0
  ) {
    return Number((shelfLikePrice * (intent.desiredPackSize.totalQuantity / product.packSize.multipackQuantity)).toFixed(2));
  }

  if (intent.comparisonMode !== "exact" && intent.desiredPackSize && product.packSize && product.unitPrice) {
    const desiredQuantityPrice = estimateDesiredQuantityPrice(product.unitPrice.value, product.unitPrice.unit, intent.desiredPackSize.totalQuantity);
    if (desiredQuantityPrice != null) {
      return desiredQuantityPrice;
    }
  }

  return shelfLikePrice;
}

function freshnessWeight(freshness: NormalizedProduct["freshness"]): number {
  switch (freshness) {
    case "fresh":
      return 0.25;
    case "recent":
      return 0.14;
    case "aging":
      return 0.04;
    default:
      return -0.08;
  }
}

function isCriticalAttribute(term: string): boolean {
  return CRITICAL_ATTRIBUTE_GROUPS.some((group) => group.includes(term));
}

function rejected(product: NormalizedProduct, reason: string): RankedProduct {
  return {
    product,
    confidence: 0,
    outcome: "rejected",
    rankingScore: -1,
    reasons: [reason]
  };
}

function tokenize(value: string): string[] {
  return normalizeText(value)
    .split(" ")
    .filter((token) => token.length > 1 && !STOPWORDS.has(token));
}

function computeTokenCoverage(requestedTokens: string[], productTokens: string[]): number {
  if (!requestedTokens.length) {
    return 1;
  }

  const productTokenSet = new Set(productTokens);
  const matched = requestedTokens.filter((token) => productTokenSet.has(token)).length;
  return matched / requestedTokens.length;
}

function matchesAnyPhrase(productText: string, phrases: string[]): boolean {
  return phrases.some((phrase) => productText.includes(phrase));
}

function comparePackSize(requested: NonNullable<SearchIntent["desiredPackSize"]>, actual: NonNullable<NormalizedProduct["packSize"]>): {
  compatible: boolean;
  closeness: number;
} {
  if (requested.comparableUnitType === "count" && actual.multipackQuantity) {
    const sizeGap = Math.abs(requested.totalQuantity - actual.multipackQuantity);
    const baseline = Math.max(requested.totalQuantity, 1);
    return {
      compatible: true,
      closeness: Math.max(0, 1 - sizeGap / baseline)
    };
  }

  if (actual.comparableUnitType === "count" && requested.multipackQuantity) {
    const sizeGap = Math.abs(requested.multipackQuantity - actual.totalQuantity);
    const baseline = Math.max(requested.multipackQuantity, 1);
    return {
      compatible: true,
      closeness: Math.max(0, 1 - sizeGap / baseline)
    };
  }

  if (requested.comparableUnitType === "unknown" || actual.comparableUnitType === "unknown") {
    return { compatible: true, closeness: 0.5 };
  }

  if (requested.comparableUnitType !== actual.comparableUnitType) {
    return { compatible: false, closeness: 0 };
  }

  const sizeGap = Math.abs(requested.totalQuantity - actual.totalQuantity);
  const baseline = Math.max(requested.totalQuantity, 1);
  return {
    compatible: true,
    closeness: Math.max(0, 1 - sizeGap / baseline)
  };
}

function estimateDesiredQuantityPrice(unitPriceValue: number, unitPriceUnit: string, desiredQuantity: number): number | undefined {
  const match = normalizeText(unitPriceUnit).match(/(\d+(?:\.\d+)?)\s*(kg|g|l|ml|each|ct)/);
  if (!match) {
    return undefined;
  }

  const basisAmount = Number(match[1]);
  const basisUnit = match[2] === "ct" ? "each" : match[2];
  const basisComparableUnit = comparableUnitFor(basisUnit);
  if (basisComparableUnit === "unknown") {
    return undefined;
  }

  const basisQuantity = normalizeQuantity(basisAmount, basisUnit);
  if (!basisQuantity) {
    return undefined;
  }

  return Number((unitPriceValue * (desiredQuantity / basisQuantity)).toFixed(2));
}
