import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import {
  BasketComparisonResult,
  ItemComparisonResult,
  NormalizedProduct,
  RankedProduct
} from "@price-patrol/core";
import { getDatabase, getProductImageCacheDir } from "./database.js";

type CachedImageRow = {
  cache_key: string;
  local_path: string;
  content_type?: string | null;
};

const CACHE_ROUTE_PREFIX = "/api/assets/product-images/";
const ALLOWED_IMAGE_HOSTS = new Set([
  "cdn0.woolworths.media",
  "assets.woolworths.com.au",
  "dm.apac.cms.aldi.cx",
  "www.aldi.com.au"
]);

export async function cacheImagesForItemComparison(result: ItemComparisonResult): Promise<ItemComparisonResult> {
  const products = [result.recommended, ...result.alternatives].filter(Boolean) as RankedProduct[];
  await cacheImagesForRankedProducts(products);
  return result;
}

export async function cacheImagesForBasketComparison(result: BasketComparisonResult): Promise<BasketComparisonResult> {
  const products = result.lines.flatMap((line) =>
    [line.comparison.recommended, ...line.comparison.alternatives].filter(Boolean) as RankedProduct[]
  );
  await cacheImagesForRankedProducts(products);
  return result;
}

export function getCachedImageAsset(cacheKey: string): { localPath: string; contentType?: string } | undefined {
  const db = getDatabase();
  const row = db
    .prepare(`
      SELECT cache_key, local_path, content_type
      FROM cached_product_images
      WHERE cache_key = :cacheKey
      LIMIT 1
    `)
    .get({ cacheKey }) as CachedImageRow | undefined;

  if (!row || !existsSync(row.local_path)) {
    return undefined;
  }

  db.prepare(`
    UPDATE cached_product_images
    SET last_accessed_at = :timestamp
    WHERE cache_key = :cacheKey
  `).run({
    cacheKey,
    timestamp: new Date().toISOString()
  });

  return {
    localPath: row.local_path,
    contentType: row.content_type ?? undefined
  };
}

export function readCachedImage(localPath: string): Buffer {
  return readFileSync(localPath);
}

async function cacheImagesForRankedProducts(products: RankedProduct[]): Promise<void> {
  const uniqueProducts = dedupeProducts(products.map((candidate) => candidate.product));
  await Promise.all(uniqueProducts.map((product) => cacheImageForProduct(product)));
}

async function cacheImageForProduct(product: NormalizedProduct): Promise<void> {
  if (product.retailer === "coles") {
    product.imageUrl = undefined;
    return;
  }

  if (!product.imageUrl) {
    const cachedByProduct = findCachedImageByProductId(product.id);
    product.imageUrl = cachedByProduct ? buildCachedImageUrl(cachedByProduct.cache_key) : undefined;
    return;
  }

  if (product.imageUrl.startsWith(CACHE_ROUTE_PREFIX)) {
    return;
  }

  const remoteUrl = normalizeRemoteImageUrl(product.imageUrl);
  if (!remoteUrl) {
    product.imageUrl = undefined;
    return;
  }

  const existing = findCachedImage(product.id, remoteUrl);
  if (existing) {
    product.imageUrl = buildCachedImageUrl(existing.cache_key);
    return;
  }

  const download = await downloadImage(remoteUrl);
  if (!download) {
    product.imageUrl = undefined;
    return;
  }

  const cacheKey = createHash("sha256").update(`${product.id}|${remoteUrl}`).digest("hex").slice(0, 32);
  const localPath = join(getProductImageCacheDir(), `${cacheKey}.${download.extension}`);
  mkdirSync(getProductImageCacheDir(), { recursive: true });
  writeFileSync(localPath, download.buffer);

  const timestamp = new Date().toISOString();
  const db = getDatabase();
  db.prepare(`
    INSERT INTO cached_product_images (
      cache_key, product_id, retailer, original_url, local_path, content_type, created_at, updated_at, last_accessed_at
    ) VALUES (
      :cacheKey, :productId, :retailer, :originalUrl, :localPath, :contentType, :createdAt, :updatedAt, :lastAccessedAt
    )
    ON CONFLICT(original_url) DO UPDATE SET
      cache_key = excluded.cache_key,
      product_id = excluded.product_id,
      retailer = excluded.retailer,
      local_path = excluded.local_path,
      content_type = excluded.content_type,
      updated_at = excluded.updated_at,
      last_accessed_at = excluded.last_accessed_at
  `).run({
    cacheKey,
    productId: product.id,
    retailer: product.retailer,
    originalUrl: remoteUrl,
    localPath,
    contentType: download.contentType,
    createdAt: timestamp,
    updatedAt: timestamp,
    lastAccessedAt: timestamp
  });

  product.imageUrl = buildCachedImageUrl(cacheKey);
}

function dedupeProducts(products: NormalizedProduct[]): NormalizedProduct[] {
  const seen = new Set<string>();
  const unique: NormalizedProduct[] = [];

  for (const product of products) {
    const key = `${product.id}:${product.imageUrl ?? ""}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(product);
  }

  return unique;
}

function normalizeRemoteImageUrl(urlValue: string): string | undefined {
  try {
    const url = new URL(urlValue, "https://www.woolworths.com.au");
    if (!ALLOWED_IMAGE_HOSTS.has(url.hostname)) {
      return undefined;
    }
    return url.toString();
  } catch {
    return undefined;
  }
}

function findCachedImage(productId: string, originalUrl: string): CachedImageRow | undefined {
  const db = getDatabase();
  const row = db
    .prepare(`
      SELECT cache_key, local_path, content_type
      FROM cached_product_images
      WHERE original_url = :originalUrl OR product_id = :productId
      ORDER BY updated_at DESC
      LIMIT 1
    `)
    .get({ originalUrl, productId }) as CachedImageRow | undefined;

  if (!row) {
    return undefined;
  }

  if (!existsSync(row.local_path)) {
    db.prepare("DELETE FROM cached_product_images WHERE cache_key = :cacheKey").run({ cacheKey: row.cache_key });
    try {
      unlinkSync(row.local_path);
    } catch {
      // Ignore missing file cleanup failures.
    }
    return undefined;
  }

  return row;
}

function findCachedImageByProductId(productId: string): CachedImageRow | undefined {
  const db = getDatabase();
  const row = db
    .prepare(`
      SELECT cache_key, local_path, content_type
      FROM cached_product_images
      WHERE product_id = :productId
      ORDER BY updated_at DESC
      LIMIT 1
    `)
    .get({ productId }) as CachedImageRow | undefined;

  if (!row) {
    return undefined;
  }

  if (!existsSync(row.local_path)) {
    db.prepare("DELETE FROM cached_product_images WHERE cache_key = :cacheKey").run({ cacheKey: row.cache_key });
    return undefined;
  }

  return row;
}

async function downloadImage(url: string): Promise<{ buffer: Buffer; contentType: string; extension: string } | undefined> {
  try {
    const response = await fetch(url, {
      headers: {
        "user-agent": "Price Patrol/0.1 (+local image cache)"
      },
      signal: AbortSignal.timeout(8_000)
    });

    if (!response.ok) {
      return undefined;
    }

    const contentType = response.headers.get("content-type")?.split(";")[0]?.trim() ?? "";
    if (!contentType.startsWith("image/")) {
      return undefined;
    }

    const arrayBuffer = await response.arrayBuffer();
    if (!arrayBuffer.byteLength) {
      return undefined;
    }

    return {
      buffer: Buffer.from(arrayBuffer),
      contentType,
      extension: inferImageExtension(url, contentType)
    };
  } catch {
    return undefined;
  }
}

function inferImageExtension(url: string, contentType: string): string {
  const fromType = contentType.replace("image/", "").toLowerCase();
  if (fromType === "jpeg") {
    return "jpg";
  }
  if (["jpg", "png", "webp", "gif", "svg+xml", "avif"].includes(fromType)) {
    return fromType === "svg+xml" ? "svg" : fromType;
  }

  const pathnameExtension = extname(new URL(url).pathname).replace(/^\./, "").toLowerCase();
  return pathnameExtension || "img";
}

function buildCachedImageUrl(cacheKey: string): string {
  return `${CACHE_ROUTE_PREFIX}${cacheKey}`;
}
