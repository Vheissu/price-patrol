import type { ParsedSize, SearchIntent } from "../types/domain.js";
import substitutionRules from "./substitution-rules.json" with { type: "json" };

type SubstitutionRule = {
  key: string;
  triggers: string[];
  defaultCoreType: string;
  familyTerms: string[];
  substituteTerms: string[];
  fallbackSearchPhrases: string[];
  requiredMatchTerms?: string[];
  excludedMatchTerms?: string[];
};

const SUBSTITUTION_RULES = substitutionRules as SubstitutionRule[];

export function findSubstitutionRule(normalizedQuery: string): SubstitutionRule | undefined {
  return SUBSTITUTION_RULES.find((rule) => rule.triggers.some((trigger) => normalizedQuery.includes(trigger)));
}

export function buildFallbackQueries(
  normalizedQuery: string,
  desiredPackSize: ParsedSize | undefined,
  rule: SubstitutionRule | undefined
): string[] {
  if (!rule) {
    return [];
  }

  const packHints = derivePackHints(normalizedQuery, desiredPackSize);
  const queries = new Set<string>();

  for (const phrase of rule.fallbackSearchPhrases) {
    for (const hint of packHints) {
      queries.add(`${phrase} ${hint}`.trim());
    }
    queries.add(phrase);
  }

  queries.delete(normalizedQuery);
  return Array.from(queries);
}

export function deriveSemanticTerms(
  _intent: Pick<SearchIntent, "coreType" | "brandPreference">,
  normalizedQuery: string,
  desiredPackSize: ParsedSize | undefined
): {
  familyTerms: string[];
  substituteTerms: string[];
  fallbackQueries: string[];
  requiredMatchTerms: string[];
  excludedMatchTerms: string[];
  defaultCoreType?: string;
} {
  const rule = findSubstitutionRule(normalizedQuery);
  return {
    familyTerms: rule ? Array.from(new Set([rule.defaultCoreType, ...rule.familyTerms])) : [],
    substituteTerms: rule?.substituteTerms ?? [],
    fallbackQueries: buildFallbackQueries(normalizedQuery, desiredPackSize, rule),
    requiredMatchTerms: rule?.requiredMatchTerms?.map((term) => normalizeText(term)) ?? [],
    excludedMatchTerms: rule?.excludedMatchTerms?.map((term) => normalizeText(term)) ?? [],
    defaultCoreType: rule?.defaultCoreType
  };
}

function derivePackHints(normalizedQuery: string, desiredPackSize: ParsedSize | undefined): string[] {
  const hints = new Set<string>();

  if (normalizedQuery.includes("can")) {
    hints.add("cans");
  }
  if (normalizedQuery.includes("bottle")) {
    hints.add("bottles");
  }
  if (normalizedQuery.includes("tablet") || normalizedQuery.includes("caplet")) {
    hints.add("tablets");
  }
  if (normalizedQuery.includes("wipe")) {
    hints.add("wipes");
  }

  if (desiredPackSize?.comparableUnitType === "count") {
    const count = Math.round(desiredPackSize.totalQuantity);
    if (count > 0) {
      hints.add(`${count} pack`);
      if (normalizedQuery.includes("can")) {
        hints.add(`${count} cans`);
      }
      if (normalizedQuery.includes("bottle")) {
        hints.add(`${count} bottles`);
      }
      if (normalizedQuery.includes("tablet") || normalizedQuery.includes("caplet")) {
        hints.add(`${count} tablets`);
      }
      if (normalizedQuery.includes("wipe")) {
        hints.add(`${count} wipes`);
      }
    }
  }

  return Array.from(hints).map((value) => normalizeText(value));
}

function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9.%/\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
