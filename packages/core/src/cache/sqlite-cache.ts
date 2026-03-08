import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { resolveProjectPath } from "../config/project-config.js";

interface CachedRecord<T> {
  expiresAt: number;
  value: T;
}

let database: DatabaseSync | undefined;

export class SqliteCache {
  async get<T>(key: string): Promise<T | null> {
    const db = getDatabase();
    const row = db.prepare(`
      SELECT value_json, expires_at
      FROM adapter_cache_entries
      WHERE cache_key = :key
    `).get({ key }) as { value_json: string; expires_at: number } | undefined;

    if (!row) {
      return null;
    }

    if (row.expires_at < Date.now()) {
      db.prepare("DELETE FROM adapter_cache_entries WHERE cache_key = :key").run({ key });
      return null;
    }

    return JSON.parse(row.value_json) as T;
  }

  async set<T>(key: string, value: T, ttlMs: number): Promise<void> {
    const db = getDatabase();
    db.prepare(`
      INSERT INTO adapter_cache_entries (cache_key, value_json, expires_at, updated_at)
      VALUES (:key, :valueJson, :expiresAt, :updatedAt)
      ON CONFLICT(cache_key) DO UPDATE SET
        value_json = excluded.value_json,
        expires_at = excluded.expires_at,
        updated_at = excluded.updated_at
    `).run({
      key,
      valueJson: JSON.stringify(value),
      expiresAt: Date.now() + ttlMs,
      updatedAt: new Date().toISOString()
    });
  }
}

function getDatabase(): DatabaseSync {
  if (!database) {
    const databasePath = resolveProjectPath(".price-patrol-data/price-patrol.db");
    mkdirSync(dirname(databasePath), { recursive: true });
    database = new DatabaseSync(databasePath, {
      timeout: 5_000
    });
    database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;

      CREATE TABLE IF NOT EXISTS adapter_cache_entries (
        cache_key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_adapter_cache_entries_expires_at
        ON adapter_cache_entries(expires_at);
    `);
  }

  return database;
}
