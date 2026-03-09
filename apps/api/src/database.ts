import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { resolveProjectPath, SavedList } from "@price-patrol/core";

let database: DatabaseSync | undefined;

export function getDatabase(): DatabaseSync {
  if (!database) {
    const databasePath = getDatabasePath();
    mkdirSync(dirname(databasePath), { recursive: true });
    database = new DatabaseSync(databasePath, {
      enableForeignKeyConstraints: true,
      timeout: 5_000
    });
    initializeDatabase(database);
    migrateLegacySavedLists(database);
  }

  return database;
}

export function getDatabasePath(): string {
  return resolveProjectPath(".price-patrol-data/price-patrol.db");
}

export function getProductImageCacheDir(): string {
  return resolveProjectPath(".price-patrol-data/product-images");
}

function initializeDatabase(db: DatabaseSync): void {
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;

    CREATE TABLE IF NOT EXISTS saved_lists (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      comparison_mode TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS saved_list_items (
      list_id TEXT NOT NULL,
      position INTEGER NOT NULL,
      name TEXT NOT NULL,
      quantity REAL,
      PRIMARY KEY (list_id, position),
      FOREIGN KEY (list_id) REFERENCES saved_lists(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS product_observations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id TEXT NOT NULL,
      retailer TEXT NOT NULL,
      canonical_name TEXT NOT NULL,
      brand TEXT,
      query_text TEXT,
      comparison_mode TEXT,
      postcode TEXT,
      suburb TEXT,
      pack_quantity REAL,
      pack_unit TEXT,
      comparable_unit_type TEXT,
      shelf_price REAL NOT NULL,
      promotional_price REAL,
      effective_price REAL NOT NULL,
      unit_price REAL,
      unit_price_unit TEXT,
      promotion_text TEXT,
      availability_state TEXT NOT NULL,
      observed_at TEXT NOT NULL,
      source_url TEXT,
      source_type TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_product_observations_product_id
      ON product_observations(product_id, observed_at DESC);

    CREATE INDEX IF NOT EXISTS idx_product_observations_query
      ON product_observations(query_text, observed_at DESC);

    CREATE TABLE IF NOT EXISTS favorite_products (
      product_id TEXT PRIMARY KEY,
      retailer TEXT NOT NULL,
      canonical_name TEXT NOT NULL,
      brand TEXT,
      pack_label TEXT,
      last_price REAL NOT NULL,
      unit_price_label TEXT,
      metadata_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS watchlist_items (
      id TEXT PRIMARY KEY,
      query_text TEXT NOT NULL,
      product_id TEXT,
      retailer TEXT,
      target_price REAL,
      note TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS match_preferences (
      id TEXT PRIMARY KEY,
      query_text TEXT NOT NULL,
      normalized_query TEXT NOT NULL,
      product_id TEXT NOT NULL,
      retailer TEXT NOT NULL,
      product_name TEXT NOT NULL,
      note TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_match_preferences_query
      ON match_preferences(normalized_query, updated_at DESC);

    CREATE TABLE IF NOT EXISTS cached_product_images (
      cache_key TEXT PRIMARY KEY,
      product_id TEXT,
      retailer TEXT NOT NULL,
      original_url TEXT NOT NULL UNIQUE,
      local_path TEXT NOT NULL,
      content_type TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_accessed_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_cached_product_images_product
      ON cached_product_images(product_id, updated_at DESC);
  `);

  ensureColumn(db, "product_observations", "source_url", "TEXT");
  ensureColumn(db, "product_observations", "source_type", "TEXT");
}

function migrateLegacySavedLists(db: DatabaseSync): void {
  const countRow = db.prepare("SELECT COUNT(*) AS count FROM saved_lists").get() as { count: number } | undefined;
  const legacySavedListsPath = resolveProjectPath(".price-patrol-data/saved-lists.json");
  if ((countRow?.count ?? 0) > 0 || !existsSync(legacySavedListsPath)) {
    return;
  }

  let lists: SavedList[] = [];
  try {
    lists = JSON.parse(readFileSync(legacySavedListsPath, "utf8")) as SavedList[];
  } catch {
    return;
  }

  const insertList = db.prepare(`
    INSERT INTO saved_lists (id, name, description, comparison_mode, created_at, updated_at)
    VALUES (:id, :name, :description, :comparisonMode, :createdAt, :updatedAt)
  `);
  const insertItem = db.prepare(`
    INSERT INTO saved_list_items (list_id, position, name, quantity)
    VALUES (:listId, :position, :name, :quantity)
  `);

  for (const list of lists) {
    insertList.run({
      id: list.id,
      name: list.name,
      description: list.description ?? null,
      comparisonMode: list.comparisonMode,
      createdAt: list.createdAt,
      updatedAt: list.updatedAt
    });

    list.items.forEach((item, index) => {
      insertItem.run({
        listId: list.id,
        position: index,
        name: item.name,
        quantity: item.quantity ?? null
      });
    });
  }
}

function ensureColumn(db: DatabaseSync, tableName: string, columnName: string, columnDefinition: string): void {
  const columns = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;
  if (columns.some((column) => column.name === columnName)) {
    return;
  }

  db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnDefinition}`);
}
