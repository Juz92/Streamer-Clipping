import Database from "better-sqlite3";
import type BetterSqlite3 from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema.js";
import { existsSync, mkdirSync } from "fs";
import { dirname, resolve } from "path";

const DB_PATH = process.env.DATABASE_PATH || "data/ltx.db";

let _db: ReturnType<typeof drizzle> | null = null;
let _sqlite: BetterSqlite3.Database | null = null;

export function getDb() {
  if (!_db) {
    const absPath = resolve(DB_PATH);
    const dir = dirname(absPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    _sqlite = new Database(absPath);
    _sqlite.pragma("journal_mode = WAL");
    _sqlite.pragma("foreign_keys = ON");
    _db = drizzle(_sqlite, { schema });
  }
  return _db;
}

export function getSqlite(): BetterSqlite3.Database {
  if (!_sqlite) getDb();
  return _sqlite!;
}

export function closeDb() {
  if (_sqlite) {
    _sqlite.close();
    _sqlite = null;
    _db = null;
  }
}

export { schema };
