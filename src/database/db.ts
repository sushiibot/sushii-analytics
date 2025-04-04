import { BunSQLiteDatabase, drizzle } from "drizzle-orm/bun-sqlite";
import { Database } from "bun:sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import fs from "fs";
import path from "path";

export type DB = BunSQLiteDatabase;

export function getDb(dbUri: string): BunSQLiteDatabase {
  // Ensure dbUri directory path exists
  const dir = path.dirname(dbUri);

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const sqlite = new Database(dbUri);
  const db = drizzle(sqlite, { casing: "snake_case" });

  migrate(db, {
    migrationsFolder: "./drizzle",
    migrationsSchema: "main",
    migrationsTable: "drizzle_migrations",
  });

  return db;
}
