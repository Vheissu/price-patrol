import Fastify from "fastify";
import cors from "@fastify/cors";
import sensible from "@fastify/sensible";
import {
  AldiAdapter,
  checkBrowserRuntime,
  closeBrowsers,
  ColesAdapter,
  ComparisonMode,
  getCachedConfigPath,
  getProjectConfig,
  LocationContext,
  NormalizedProduct,
  PricePatrolService,
  WoolworthsAdapter
} from "@price-patrol/core";
import { z } from "zod";
import { getDatabasePath } from "./database.js";
import {
  enrichBasketComparison,
  enrichItemComparison,
  explainPriceIntelligence,
  getProductHistory,
  getRecentSpecials,
  getWatchlistView,
  recordBasketComparison,
  recordItemComparison
} from "./intelligence.js";
import { cacheImagesForBasketComparison, cacheImagesForItemComparison, getCachedImageAsset, readCachedImage } from "./image-cache.js";
import {
  deleteFavorite,
  deleteList,
  deleteWatchlist,
  getFavorites,
  getMatchPreferences,
  getSavedLists,
  saveFavorite,
  saveMatchPreference,
  saveList,
  saveWatchlist
} from "./storage.js";

const adapters = [new ColesAdapter(), new WoolworthsAdapter(), new AldiAdapter()];
const service = new PricePatrolService(adapters);
const projectConfig = await getProjectConfig();
const browserRuntime = checkBrowserRuntime();
const MAX_QUERY_LENGTH = 200;
const MAX_BASKET_ITEMS = 60;

const locationSchema = z
  .object({
    postcode: z.string().optional(),
    suburb: z.string().optional(),
    storeId: z.string().optional(),
    storeDisplayName: z.string().optional(),
    locationText: z.string().optional()
  })
  .optional();

const compareItemSchema = z.object({
  query: z.string().trim().min(1).max(MAX_QUERY_LENGTH),
  comparisonMode: z.enum(["exact", "equivalent", "best-value"]).default("equivalent"),
  location: locationSchema,
  allowLiveScrape: z.boolean().optional()
});

const basketSchema = z.object({
  items: z
    .array(z.object({ name: z.string().trim().min(1).max(MAX_QUERY_LENGTH), quantity: z.number().positive().max(999).optional() }))
    .min(1)
    .max(MAX_BASKET_ITEMS),
  comparisonMode: z.enum(["exact", "equivalent", "best-value"]).default("equivalent"),
  location: locationSchema,
  allowLiveScrape: z.boolean().optional()
});

const explainSchema = z.object({
  query: z.string().trim().min(1).max(MAX_QUERY_LENGTH),
  productId: z.string().min(1),
  comparisonMode: z.enum(["exact", "equivalent", "best-value"]).default("equivalent"),
  location: locationSchema,
  allowLiveScrape: z.boolean().optional()
});

const savedListSchema = z.object({
  id: z.string().optional(),
  name: z.string().min(1),
  description: z.string().optional(),
  comparisonMode: z.enum(["exact", "equivalent", "best-value"]).default("equivalent"),
  items: z.array(z.object({ name: z.string().min(1), quantity: z.number().positive().optional() })).min(1)
});

const favoriteSchema = z.object({
  product: z.object({
    id: z.string().min(1),
    retailer: z.enum(["coles", "woolworths", "aldi"]),
    sourceUrl: z.string().min(1),
    sourceType: z.enum(["search", "detail", "network", "historical"]),
    imageUrl: z.string().optional(),
    canonicalDisplayName: z.string().min(1),
    rawName: z.string().min(1),
    brand: z.string().optional(),
    categoryPath: z.array(z.string()),
    structuredAttributes: z.array(z.string()),
    packSize: z
      .object({
        value: z.number(),
        unit: z.string(),
        totalQuantity: z.number(),
        comparableUnitType: z.enum(["mass", "volume", "count", "unknown"]),
        multipackQuantity: z.number().optional()
      })
      .optional(),
    unitPrice: z
      .object({
        value: z.number(),
        unit: z.string(),
        inferred: z.boolean()
      })
      .optional(),
    shelfPrice: z.number(),
    promotionalPrice: z.number().optional(),
    promotionText: z.string().optional(),
    effectiveComparisonPrice: z.number(),
    currency: z.string(),
    priceScope: z.enum(["estimated", "store", "national"]),
    priceConfidence: z.number(),
    availabilityState: z.enum(["in-stock", "low-stock", "out-of-stock", "unknown"]),
    availabilityConfidence: z.number(),
    lowStock: z.boolean(),
    lastFetchedAt: z.string(),
    lastParsedAt: z.string(),
    sourceSnapshotAt: z.string(),
    freshness: z.enum(["fresh", "recent", "aging", "stale"]),
    notes: z.array(z.string()),
    warnings: z.array(z.string()),
    diagnostics: z.record(z.string(), z.unknown()).optional(),
    storeContext: locationSchema
  })
});

const watchlistSchema = z.object({
  id: z.string().optional(),
  query: z.string().min(1),
  productId: z.string().optional(),
  retailer: z.enum(["coles", "woolworths", "aldi"]).optional(),
  targetPrice: z.number().positive().optional(),
  note: z.string().optional()
});

const matchPreferenceSchema = z.object({
  id: z.string().optional(),
  query: z.string().min(1),
  productId: z.string().min(1),
  retailer: z.enum(["coles", "woolworths", "aldi"]),
  productName: z.string().min(1),
  note: z.string().optional()
});

const historyQuerySchema = z.object({
  days: z.coerce.number().int().positive().max(365).optional()
});

const dealsQuerySchema = z.object({
  days: z.coerce.number().int().positive().max(90).optional(),
  limit: z.coerce.number().int().positive().max(100).optional()
});

const app = Fastify({
  logger: true,
  bodyLimit: 256 * 1024,
  // Comparisons are browser-driven and can legitimately run for minutes; never cut a live scrape off mid-flight.
  requestTimeout: 0,
  keepAliveTimeout: 75_000
});
await app.register(cors, { origin: true });
await app.register(sensible);

app.setErrorHandler((error: unknown, request, reply) => {
  const failure = error instanceof Error ? error : new Error(String(error));
  const declaredStatus = (failure as { statusCode?: unknown }).statusCode;
  const statusCode = typeof declaredStatus === "number" && declaredStatus >= 400 ? declaredStatus : 500;
  if (statusCode >= 500) {
    request.log.error({ err: failure, url: request.url }, "Unhandled request failure");
  }
  reply.status(statusCode).send({
    message: statusCode >= 500 ? "The request failed unexpectedly. Check the API log for details." : failure.message
  });
});

if (!browserRuntime.ok) {
  for (const problem of browserRuntime.problems) {
    app.log.warn(problem);
  }
}

app.get("/api/health", async () => ({
  status: "ok",
  generatedAt: new Date().toISOString(),
  config: {
    path: getCachedConfigPath(),
    databasePath: getDatabasePath(),
    defaultLocation: resolveLocation(),
    browser: {
      headless: projectConfig.browser.headless,
      reuseSessions: projectConfig.browser.reuseSessions,
      maskAutomation: projectConfig.browser.maskAutomation,
      runtime: browserRuntime
    },
    cache: {
      ttlMs: projectConfig.cache.ttlMs,
      liveScrapeEnabled: projectConfig.cache.liveScrapeEnabled,
      useHistoricalFallbackOnFailure: projectConfig.cache.useHistoricalFallbackOnFailure
    },
    resilience: {
      maxAttempts: projectConfig.resilience.maxAttempts,
      baseBackoffMs: projectConfig.resilience.baseBackoffMs,
      maxBackoffMs: projectConfig.resilience.maxBackoffMs,
      cooldownMs: projectConfig.resilience.cooldownMs,
      maxConcurrentRetailerTasks: projectConfig.resilience.maxConcurrentRetailerTasks
    }
  },
  adapters: adapters.map((adapter) => adapter.getHealth())
}));

app.get("/api/adapters/health", async () => ({
  adapters: adapters.map((adapter) => adapter.getHealth())
}));

app.post("/api/compare/item", async (request, reply) => {
  const parsed = compareItemSchema.safeParse(request.body);
  if (!parsed.success) {
    return reply.status(400).send({ message: "Invalid compare item request.", issues: parsed.error.flatten() });
  }

  const body = parsed.data;
  const preferredProductIds = (await getMatchPreferences(body.query)).map((preference) => preference.productId);
  const result = await service.compareItem(body.query, body.comparisonMode as ComparisonMode, {
    location: resolveLocation(body.location as LocationContext | undefined),
    allowLiveScrape: body.allowLiveScrape,
    preferredProductIds
  });
  await persistQuietly(request.log, "item comparison", () => recordItemComparison(result));
  const enriched = await enrichItemComparison(result);
  return cacheImagesForItemComparison(enriched);
});

app.post("/api/compare/basket", async (request, reply) => {
  const parsed = basketSchema.safeParse(request.body);
  if (!parsed.success) {
    return reply.status(400).send({ message: "Invalid compare basket request.", issues: parsed.error.flatten() });
  }

  const body = parsed.data;
  const preferredProductIds = Array.from(
    new Set(
      (
        await Promise.all(body.items.map((item) => getMatchPreferences(item.name)))
      ).flatMap((preferences) => preferences.map((preference) => preference.productId))
    )
  );
  const result = await service.compareBasket(body.items, body.comparisonMode as ComparisonMode, {
    location: resolveLocation(body.location as LocationContext | undefined),
    allowLiveScrape: body.allowLiveScrape,
    preferredProductIds
  });
  await persistQuietly(request.log, "basket comparison", () => recordBasketComparison(result));
  const enriched = await enrichBasketComparison(result);
  return cacheImagesForBasketComparison(enriched);
});

app.post("/api/explain/item", async (request, reply) => {
  const parsed = explainSchema.safeParse(request.body);
  if (!parsed.success) {
    return reply.status(400).send({ message: "Invalid explain item request.", issues: parsed.error.flatten() });
  }

  const body = parsed.data;
  const preferredProductIds = (await getMatchPreferences(body.query)).map((preference) => preference.productId);
  const explanation = await service.explainItem(body.query, body.productId, body.comparisonMode as ComparisonMode, {
    location: resolveLocation(body.location as LocationContext | undefined),
    allowLiveScrape: body.allowLiveScrape,
    preferredProductIds
  });
  const historyContext = await explainPriceIntelligence(body.productId);
  if (historyContext.length) {
    explanation.explanation.push(...historyContext);
  }
  return explanation;
});

app.get("/api/saved-lists", async () => ({
  lists: await getSavedLists()
}));

app.post("/api/saved-lists", async (request, reply) => {
  const parsed = savedListSchema.safeParse(request.body);
  if (!parsed.success) {
    return reply.status(400).send({ message: "Invalid saved list request.", issues: parsed.error.flatten() });
  }
  return saveList(parsed.data);
});

app.delete("/api/saved-lists/:id", async (request, reply) => {
  const params = z.object({ id: z.string() }).safeParse(request.params);
  if (!params.success) {
    return reply.status(400).send({ message: "Invalid saved list id.", issues: params.error.flatten() });
  }

  const deleted = await deleteList(params.data.id);
  if (!deleted) {
    return reply.notFound("Saved list not found.");
  }
  return { deleted: true };
});

app.get("/api/favorites", async () => ({
  favorites: await getFavorites()
}));

app.post("/api/favorites", async (request, reply) => {
  const parsed = favoriteSchema.safeParse(request.body);
  if (!parsed.success) {
    return reply.status(400).send({ message: "Invalid favorite request.", issues: parsed.error.flatten() });
  }
  return saveFavorite(parsed.data.product as NormalizedProduct);
});

app.delete("/api/favorites/:productId", async (request, reply) => {
  const params = z.object({ productId: z.string() }).safeParse(request.params);
  if (!params.success) {
    return reply.status(400).send({ message: "Invalid favorite id.", issues: params.error.flatten() });
  }

  const deleted = await deleteFavorite(params.data.productId);
  if (!deleted) {
    return reply.notFound("Favorite not found.");
  }
  return { deleted: true };
});

app.get("/api/watchlist", async () => ({
  watchlist: await getWatchlistView()
}));

app.post("/api/watchlist", async (request, reply) => {
  const parsed = watchlistSchema.safeParse(request.body);
  if (!parsed.success) {
    return reply.status(400).send({ message: "Invalid watchlist request.", issues: parsed.error.flatten() });
  }
  return saveWatchlist(parsed.data);
});

app.delete("/api/watchlist/:id", async (request, reply) => {
  const params = z.object({ id: z.string() }).safeParse(request.params);
  if (!params.success) {
    return reply.status(400).send({ message: "Invalid watchlist id.", issues: params.error.flatten() });
  }

  const deleted = await deleteWatchlist(params.data.id);
  if (!deleted) {
    return reply.notFound("Watchlist entry not found.");
  }
  return { deleted: true };
});

app.get("/api/match-preferences", async (request, reply) => {
  const query = z.object({ query: z.string().optional() }).safeParse(request.query);
  if (!query.success) {
    return reply.status(400).send({ message: "Invalid match preference request." });
  }

  return {
    preferences: await getMatchPreferences(query.data.query)
  };
});

app.post("/api/match-preferences", async (request, reply) => {
  const parsed = matchPreferenceSchema.safeParse(request.body);
  if (!parsed.success) {
    return reply.status(400).send({ message: "Invalid match preference request.", issues: parsed.error.flatten() });
  }

  return saveMatchPreference(parsed.data);
});

app.get("/api/products/:productId/history", async (request, reply) => {
  const params = z.object({ productId: z.string() }).safeParse(request.params);
  const query = historyQuerySchema.safeParse(request.query);
  if (!params.success || !query.success) {
    return reply.status(400).send({ message: "Invalid history request." });
  }

  return {
    productId: params.data.productId,
    history: await getProductHistory(params.data.productId, query.data.days ?? 60)
  };
});

app.get("/api/deals", async (request, reply) => {
  const query = dealsQuerySchema.safeParse(request.query);
  if (!query.success) {
    return reply.status(400).send({ message: "Invalid deals request." });
  }

  return {
    deals: await getRecentSpecials(query.data.days ?? 21, query.data.limit ?? 40)
  };
});

app.get("/api/assets/product-images/:cacheKey", async (request, reply) => {
  const params = z.object({ cacheKey: z.string().min(8) }).safeParse(request.params);
  if (!params.success) {
    return reply.status(400).send({ message: "Invalid image asset request." });
  }

  const asset = getCachedImageAsset(params.data.cacheKey);
  if (!asset) {
    return reply.notFound("Image asset not found.");
  }

  reply.header("Cache-Control", "public, max-age=2592000, immutable");
  return reply.type(asset.contentType ?? "application/octet-stream").send(readCachedImage(asset.localPath));
});

const requestedPort = Number(process.env.PORT ?? 8787);
const listeningHost = process.env.HOST ?? "0.0.0.0";
const listeningPort = await listenWithPortFallback(app, Number.isFinite(requestedPort) ? requestedPort : 8787, listeningHost);
app.log.info(`API listening on http://127.0.0.1:${listeningPort}`);
registerShutdownHandlers();

async function persistQuietly(log: typeof app.log, label: string, write: () => Promise<void>): Promise<void> {
  try {
    await write();
  } catch (error) {
    // A locked or failing SQLite write must not turn a successful comparison into a 500.
    log.warn({ err: error }, `Failed to record ${label}; response will still be returned.`);
  }
}

function registerShutdownHandlers(): void {
  let shuttingDown = false;
  const shutdown = async (signal: NodeJS.Signals) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    app.log.info(`Received ${signal}, shutting down.`);

    const forceExit = setTimeout(() => {
      app.log.warn("Shutdown took too long; exiting forcefully.");
      process.exit(1);
    }, 10_000);
    forceExit.unref();

    await app.close().catch((error: unknown) => app.log.warn({ err: error }, "HTTP server did not close cleanly."));
    await closeBrowsers().catch(() => undefined);
    process.exit(signal === "SIGINT" ? 130 : 143);
  };

  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("unhandledRejection", (reason) => {
    app.log.error({ err: reason }, "Unhandled promise rejection");
  });
}

function resolveLocation(location?: LocationContext): LocationContext | undefined {
  const merged = {
    postcode: location?.postcode ?? projectConfig.defaultLocation.postcode,
    suburb: location?.suburb ?? projectConfig.defaultLocation.suburb,
    storeId: location?.storeId,
    storeDisplayName: location?.storeDisplayName,
    locationText: location?.locationText
  };

  return Object.values(merged).some((value) => value != null && value !== "") ? merged : undefined;
}

async function listenWithPortFallback(server: typeof app, preferredPort: number, host: string): Promise<number> {
  let port = preferredPort;
  while (port <= 65_535) {
    try {
      await server.listen({ port, host });
      return port;
    } catch (error) {
      if (!isAddressInUse(error)) {
        throw error;
      }
      port += 1;
    }
  }

  throw new Error("Unable to find a free API port.");
}

function isAddressInUse(error: unknown): error is NodeJS.ErrnoException {
  return Boolean(error && typeof error === "object" && "code" in error && (error as NodeJS.ErrnoException).code === "EADDRINUSE");
}
