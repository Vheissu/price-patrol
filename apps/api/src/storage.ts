import { randomUUID } from "node:crypto";
import { NormalizedProduct, SavedList, normalizeText } from "@price-patrol/core";
import { getDatabase } from "./database.js";

export interface FavoriteProduct {
  productId: string;
  retailer: string;
  canonicalName: string;
  imageUrl?: string;
  brand?: string;
  packLabel?: string;
  lastPrice: number;
  unitPriceLabel?: string;
  createdAt: string;
  updatedAt: string;
}

export interface WatchlistItem {
  id: string;
  query: string;
  productId?: string;
  retailer?: string;
  targetPrice?: number;
  note?: string;
  createdAt: string;
  updatedAt: string;
}

export interface MatchPreference {
  id: string;
  query: string;
  normalizedQuery: string;
  productId: string;
  retailer: string;
  productName: string;
  note?: string;
  createdAt: string;
  updatedAt: string;
}

type SavedListRow = {
  id: string;
  name: string;
  description?: string | null;
  comparison_mode: SavedList["comparisonMode"];
  created_at: string;
  updated_at: string;
};

type SavedListItemRow = {
  list_id: string;
  position: number;
  name: string;
  quantity?: number | null;
};

export async function getSavedLists(): Promise<SavedList[]> {
  const db = getDatabase();
  const listRows = db.prepare("SELECT * FROM saved_lists ORDER BY updated_at DESC, name ASC").all() as SavedListRow[];
  const itemRows = db.prepare("SELECT * FROM saved_list_items ORDER BY list_id ASC, position ASC").all() as SavedListItemRow[];

  return listRows.map((row) => ({
    id: row.id,
    name: row.name,
    description: row.description ?? undefined,
    comparisonMode: row.comparison_mode,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    items: itemRows
      .filter((item) => item.list_id === row.id)
      .map((item) => ({
        name: item.name,
        quantity: item.quantity ?? undefined
      }))
  }));
}

export async function saveList(
  input: Partial<Pick<SavedList, "id">> & Pick<SavedList, "name" | "description" | "items" | "comparisonMode">
): Promise<SavedList> {
  const db = getDatabase();
  const timestamp = new Date().toISOString();
  const id = input.id ?? randomUUID();
  const existing = db.prepare("SELECT created_at FROM saved_lists WHERE id = ?").get(id) as { created_at: string } | undefined;

  db.exec("BEGIN");
  try {
    db.prepare(`
      INSERT INTO saved_lists (id, name, description, comparison_mode, created_at, updated_at)
      VALUES (:id, :name, :description, :comparisonMode, :createdAt, :updatedAt)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        description = excluded.description,
        comparison_mode = excluded.comparison_mode,
        updated_at = excluded.updated_at
    `).run({
      id,
      name: input.name,
      description: input.description ?? null,
      comparisonMode: input.comparisonMode,
      createdAt: existing?.created_at ?? timestamp,
      updatedAt: timestamp
    });

    db.prepare("DELETE FROM saved_list_items WHERE list_id = ?").run(id);
    const insertItem = db.prepare(`
      INSERT INTO saved_list_items (list_id, position, name, quantity)
      VALUES (:listId, :position, :name, :quantity)
    `);
    input.items.forEach((item, index) => {
      insertItem.run({
        listId: id,
        position: index,
        name: item.name,
        quantity: item.quantity ?? null
      });
    });
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

  return {
    id,
    name: input.name,
    description: input.description,
    items: input.items,
    comparisonMode: input.comparisonMode,
    createdAt: existing?.created_at ?? timestamp,
    updatedAt: timestamp
  };
}

export async function deleteList(id: string): Promise<boolean> {
  const db = getDatabase();
  const result = db.prepare("DELETE FROM saved_lists WHERE id = ?").run(id);
  return result.changes > 0;
}

export async function getFavorites(): Promise<FavoriteProduct[]> {
  const db = getDatabase();
  const rows = db.prepare("SELECT * FROM favorite_products ORDER BY updated_at DESC, canonical_name ASC").all() as Array<{
    product_id: string;
    retailer: string;
    canonical_name: string;
    brand?: string | null;
    pack_label?: string | null;
    last_price: number;
    unit_price_label?: string | null;
    created_at: string;
    metadata_json: string;
    updated_at: string;
  }>;

  return rows.map((row) => ({
    ...(parseFavoriteMetadata(row.metadata_json) ?? {}),
    productId: row.product_id,
    retailer: row.retailer,
    canonicalName: row.canonical_name,
    brand: row.brand ?? undefined,
    packLabel: row.pack_label ?? undefined,
    lastPrice: row.last_price,
    unitPriceLabel: row.unit_price_label ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }));
}

export async function saveFavorite(product: NormalizedProduct): Promise<FavoriteProduct> {
  const db = getDatabase();
  const timestamp = new Date().toISOString();
  const pack = product.packSize ? `${product.packSize.value}${product.packSize.unit}` : undefined;
  const unitPriceLabel = product.unitPrice ? `$${product.unitPrice.value.toFixed(2)} / ${product.unitPrice.unit}` : undefined;
  const metadata = JSON.stringify({
    sourceUrl: product.sourceUrl,
    imageUrl: product.imageUrl,
    promotionText: product.promotionText,
    priceIntelligence: product.priceIntelligence
  });

  db.prepare(`
    INSERT INTO favorite_products (
      product_id, retailer, canonical_name, brand, pack_label, last_price, unit_price_label, metadata_json, created_at, updated_at
    ) VALUES (
      :productId, :retailer, :canonicalName, :brand, :packLabel, :lastPrice, :unitPriceLabel, :metadataJson, :createdAt, :updatedAt
    )
    ON CONFLICT(product_id) DO UPDATE SET
      retailer = excluded.retailer,
      canonical_name = excluded.canonical_name,
      brand = excluded.brand,
      pack_label = excluded.pack_label,
      last_price = excluded.last_price,
      unit_price_label = excluded.unit_price_label,
      metadata_json = excluded.metadata_json,
      updated_at = excluded.updated_at
  `).run({
    productId: product.id,
    retailer: product.retailer,
    canonicalName: product.canonicalDisplayName,
    brand: product.brand ?? null,
    packLabel: pack ?? null,
    lastPrice: product.effectiveComparisonPrice,
    unitPriceLabel: unitPriceLabel ?? null,
    metadataJson: metadata,
    createdAt: timestamp,
    updatedAt: timestamp
  });

  return {
    productId: product.id,
    retailer: product.retailer,
    canonicalName: product.canonicalDisplayName,
    imageUrl: product.imageUrl,
    brand: product.brand,
    packLabel: pack,
    lastPrice: product.effectiveComparisonPrice,
    unitPriceLabel,
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

export async function deleteFavorite(productId: string): Promise<boolean> {
  const db = getDatabase();
  const result = db.prepare("DELETE FROM favorite_products WHERE product_id = ?").run(productId);
  return result.changes > 0;
}

export async function getWatchlist(): Promise<WatchlistItem[]> {
  const db = getDatabase();
  const rows = db.prepare("SELECT * FROM watchlist_items ORDER BY updated_at DESC, query_text ASC").all() as Array<{
    id: string;
    query_text: string;
    product_id?: string | null;
    retailer?: string | null;
    target_price?: number | null;
    note?: string | null;
    created_at: string;
    updated_at: string;
  }>;

  return rows.map((row) => ({
    id: row.id,
    query: row.query_text,
    productId: row.product_id ?? undefined,
    retailer: row.retailer ?? undefined,
    targetPrice: row.target_price ?? undefined,
    note: row.note ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }));
}

export async function saveWatchlist(
  input: Partial<Pick<WatchlistItem, "id">> & Pick<WatchlistItem, "query"> & Partial<Pick<WatchlistItem, "productId" | "retailer" | "targetPrice" | "note">>
): Promise<WatchlistItem> {
  const db = getDatabase();
  const timestamp = new Date().toISOString();
  const id = input.id ?? randomUUID();
  const existing = db.prepare("SELECT created_at FROM watchlist_items WHERE id = ?").get(id) as { created_at: string } | undefined;

  db.prepare(`
    INSERT INTO watchlist_items (id, query_text, product_id, retailer, target_price, note, created_at, updated_at)
    VALUES (:id, :queryText, :productId, :retailer, :targetPrice, :note, :createdAt, :updatedAt)
    ON CONFLICT(id) DO UPDATE SET
      query_text = excluded.query_text,
      product_id = excluded.product_id,
      retailer = excluded.retailer,
      target_price = excluded.target_price,
      note = excluded.note,
      updated_at = excluded.updated_at
  `).run({
    id,
    queryText: input.query,
    productId: input.productId ?? null,
    retailer: input.retailer ?? null,
    targetPrice: input.targetPrice ?? null,
    note: input.note ?? null,
    createdAt: existing?.created_at ?? timestamp,
    updatedAt: timestamp
  });

  return {
    id,
    query: input.query,
    productId: input.productId,
    retailer: input.retailer,
    targetPrice: input.targetPrice,
    note: input.note,
    createdAt: existing?.created_at ?? timestamp,
    updatedAt: timestamp
  };
}

export async function deleteWatchlist(id: string): Promise<boolean> {
  const db = getDatabase();
  const result = db.prepare("DELETE FROM watchlist_items WHERE id = ?").run(id);
  return result.changes > 0;
}

export async function getMatchPreferences(query?: string): Promise<MatchPreference[]> {
  const db = getDatabase();
  const normalizedQuery = query ? normalizeText(query) : undefined;
  const rows = normalizedQuery
    ? (db
        .prepare("SELECT * FROM match_preferences WHERE normalized_query = ? ORDER BY updated_at DESC, product_name ASC")
        .all(normalizedQuery) as MatchPreferenceRow[])
    : (db.prepare("SELECT * FROM match_preferences ORDER BY updated_at DESC, product_name ASC").all() as MatchPreferenceRow[]);

  return rows.map(mapMatchPreferenceRow);
}

export async function saveMatchPreference(input: {
  id?: string;
  query: string;
  productId: string;
  retailer: string;
  productName: string;
  note?: string;
}): Promise<MatchPreference> {
  const db = getDatabase();
  const timestamp = new Date().toISOString();
  const normalizedQuery = normalizeText(input.query);
  const existing = db
    .prepare("SELECT id, created_at FROM match_preferences WHERE normalized_query = ? AND product_id = ?")
    .get(normalizedQuery, input.productId) as { id: string; created_at: string } | undefined;
  const id = input.id ?? existing?.id ?? randomUUID();

  db.prepare(`
    INSERT INTO match_preferences (id, query_text, normalized_query, product_id, retailer, product_name, note, created_at, updated_at)
    VALUES (:id, :queryText, :normalizedQuery, :productId, :retailer, :productName, :note, :createdAt, :updatedAt)
    ON CONFLICT(id) DO UPDATE SET
      query_text = excluded.query_text,
      normalized_query = excluded.normalized_query,
      product_id = excluded.product_id,
      retailer = excluded.retailer,
      product_name = excluded.product_name,
      note = excluded.note,
      updated_at = excluded.updated_at
  `).run({
    id,
    queryText: input.query,
    normalizedQuery,
    productId: input.productId,
    retailer: input.retailer,
    productName: input.productName,
    note: input.note ?? null,
    createdAt: existing?.created_at ?? timestamp,
    updatedAt: timestamp
  });

  return {
    id,
    query: input.query,
    normalizedQuery,
    productId: input.productId,
    retailer: input.retailer,
    productName: input.productName,
    note: input.note,
    createdAt: existing?.created_at ?? timestamp,
    updatedAt: timestamp
  };
}

type MatchPreferenceRow = {
  id: string;
  query_text: string;
  normalized_query: string;
  product_id: string;
  retailer: string;
  product_name: string;
  note?: string | null;
  created_at: string;
  updated_at: string;
};

function mapMatchPreferenceRow(row: MatchPreferenceRow): MatchPreference {
  return {
    id: row.id,
    query: row.query_text,
    normalizedQuery: row.normalized_query,
    productId: row.product_id,
    retailer: row.retailer,
    productName: row.product_name,
    note: row.note ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function parseFavoriteMetadata(metadataJson: string): { imageUrl?: string } | undefined {
  try {
    const metadata = JSON.parse(metadataJson) as { imageUrl?: string };
    return {
      imageUrl: metadata.imageUrl
    };
  } catch {
    return undefined;
  }
}
