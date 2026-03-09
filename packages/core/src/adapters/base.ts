import { SqliteCache } from "../cache/sqlite-cache.js";
import { getProjectConfig, getRetailerConfig } from "../config/project-config.js";
import { normalizeText } from "../parsing/query.js";
import { AdapterHealth, AdapterSearchResult, NormalizedProduct, RetailerId, SearchIntent, SearchOptions } from "../types/domain.js";
import { getHistoricalFallbackProducts } from "./shared/historical-catalog.js";
import { asScrapeFailure, runWithResilience } from "./shared/resilience.js";

export interface RetailerAdapter {
  readonly retailer: RetailerId;
  search(intent: SearchIntent, options?: SearchOptions): Promise<AdapterSearchResult>;
  getHealth(): AdapterHealth;
}

export abstract class BaseRetailerAdapter implements RetailerAdapter {
  protected readonly cache = new SqliteCache();
  protected health: AdapterHealth;

  constructor(public readonly retailer: RetailerId) {
    this.health = {
      retailer,
      status: "healthy",
      extractionConfidence: 0.65,
      browserMode: "hybrid"
    };
  }

  async search(intent: SearchIntent, options: SearchOptions = {}): Promise<AdapterSearchResult> {
    const projectConfig = await getProjectConfig();
    const retailerConfig = await getRetailerConfig(this.retailer);
    const cacheKey = `${this.retailer}-${intent.normalizedQuery}-${options.location?.postcode ?? "default"}`;
    const cached = await this.cache.get<AdapterSearchResult>(cacheKey);
    if (cached?.products.length) {
      return cached;
    }

    const warnings: string[] = [];
    const diagnostics: string[] = [];
    let products: NormalizedProduct[] = [];

    const allowLiveScrape =
      retailerConfig.enabled &&
      retailerConfig.liveScrape &&
      (options.allowLiveScrape ?? projectConfig.cache.liveScrapeEnabled) &&
      process.env.PRICE_PATROL_LIVE_SCRAPE !== "false";

    if (!retailerConfig.enabled) {
      this.health = {
        ...this.health,
        status: "offline",
        recentFailure: "Retailer disabled in configuration."
      };
      warnings.push("Retailer is disabled in price-patrol.toml.");
    } else if (allowLiveScrape) {
      try {
        const liveSearch = await this.searchLiveWithFallbacks(intent, options);
        products = liveSearch.products;
        warnings.push(...liveSearch.warnings);
        diagnostics.push(...liveSearch.diagnostics);
        if (products.length) {
          this.health = {
            ...this.health,
            status: "healthy",
            browserMode: "hybrid",
            lastSuccessfulRetrieval: new Date().toISOString(),
            recentFailure: undefined
          };
          diagnostics.push("Live retailer scraping succeeded.");
        } else {
          const message = "Live scraping completed but returned no comparable products.";
          warnings.push(message);
          diagnostics.push("Live scraping returned zero products.");
          this.health = {
            ...this.health,
            status: "degraded",
            recentFailure: message,
            browserMode: "hybrid"
          };
        }
      } catch (error) {
        const failure = asScrapeFailure(error);
        const message = failure.message;
        warnings.push(message);
        diagnostics.push(`Live scraping failed: ${message}`);
        diagnostics.push(...failure.diagnostics);
        this.health = {
          ...this.health,
          status: "degraded",
          recentFailure: message,
          browserMode: "hybrid"
        };
      }
    }

    if (!products.length && projectConfig.cache.useHistoricalFallbackOnFailure) {
      const fallback = this.searchFallbackCatalog(intent, options.maxResults ?? retailerConfig.maxResults);
      products = fallback.products;
      warnings.push(...fallback.warnings);
      diagnostics.push(...fallback.diagnostics);
      this.health = {
        ...this.health,
        browserMode: "historical",
        extractionConfidence: Math.min(this.health.extractionConfidence, 0.62)
      };
    }

    const result: AdapterSearchResult = {
      retailer: this.retailer,
      products,
      warnings,
      diagnostics,
      health: this.health
    };

    if (shouldCacheResult(result)) {
      await this.cache.set(cacheKey, result, projectConfig.cache.ttlMs);
    }
    return result;
  }

  protected async searchLiveWithFallbacks(
    intent: SearchIntent,
    options: SearchOptions
  ): Promise<Pick<AdapterSearchResult, "products" | "warnings" | "diagnostics">> {
    const attemptedQueries = new Set<string>();
    const diagnostics: string[] = [];
    const warnings: string[] = [];

    const searchIntents = [
      intent,
      ...intent.fallbackQueries.map((query) => ({
        ...intent,
        rawQuery: query,
        normalizedQuery: query
      }))
    ];

    for (const candidateIntent of searchIntents) {
      if (attemptedQueries.has(candidateIntent.normalizedQuery)) {
        continue;
      }
      attemptedQueries.add(candidateIntent.normalizedQuery);

      const products = await runWithResilience<NormalizedProduct[]>({
        retailer: this.retailer,
        task: () => this.searchLive(candidateIntent, options)
      });

      if (products.length && hasRelevantResults(products, intent)) {
        if (candidateIntent.normalizedQuery !== intent.normalizedQuery) {
          warnings.push(`Used related search "${candidateIntent.rawQuery}" to find substitute options.`);
          diagnostics.push(`Live search fallback query succeeded: ${candidateIntent.rawQuery}`);
        }
        return { products, warnings, diagnostics };
      }

      if (products.length) {
        diagnostics.push(`Live search query returned unrelated products: ${candidateIntent.rawQuery}`);
      }

      if (candidateIntent.normalizedQuery !== intent.normalizedQuery) {
        diagnostics.push(`Live search fallback query returned no products: ${candidateIntent.rawQuery}`);
      }
    }

    return { products: [], warnings, diagnostics };
  }

  getHealth(): AdapterHealth {
    return this.health;
  }

  protected searchFallbackCatalog(intent: SearchIntent, maxResults: number): Pick<AdapterSearchResult, "products" | "warnings" | "diagnostics"> {
    const products = getHistoricalFallbackProducts(this.retailer, intent, maxResults);
    const diagnostics = products.length ? ["Historical SQLite fallback matched the query."] : ["Historical SQLite fallback had no match."];

    return {
      products,
      warnings: products.length
        ? ["Served from historical SQLite catalog for resilience."]
        : ["No live or historical match found."],
      diagnostics
    };
  }

  protected abstract searchLive(intent: SearchIntent, options: SearchOptions): Promise<NormalizedProduct[]>;
}

function shouldCacheResult(result: AdapterSearchResult): boolean {
  if (!result.products.length) {
    return false;
  }

  return result.products.some((product) => product.sourceType !== "historical");
}

function hasRelevantResults(products: NormalizedProduct[], intent: SearchIntent): boolean {
  const relevanceTerms = Array.from(
    new Set(
      [intent.coreType, ...intent.familyTerms, ...intent.substituteTerms]
        .map((term) => normalizeText(term))
        .filter(Boolean)
    )
  );

  if (!relevanceTerms.length) {
    return products.length > 0;
  }

  return products.some((product) => {
    const haystack = normalizeText(
      [
        product.canonicalDisplayName,
        product.rawName,
        product.brand,
        product.structuredAttributes.join(" ")
      ]
        .filter(Boolean)
        .join(" ")
    );

    if (intent.requiredMatchTerms.length && !intent.requiredMatchTerms.some((term) => haystack.includes(term))) {
      return false;
    }

    if (intent.excludedMatchTerms.some((term) => haystack.includes(term))) {
      return false;
    }

    return relevanceTerms.some((term) => haystack.includes(term));
  });
}
