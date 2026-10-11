import { Database } from "bun:sqlite";
import fs from "node:fs";
import path from "node:path";

/**
 * - forget: deleted on request; no per-member counts are recorded again.
 * - leaderboard: still counted, but left out of published member rankings.
 */
export type SuppressionScope = "forget" | "leaderboard";

/** Persistent opt-out list. Lives outside the year files so it survives their deletion. */
export function openPrivacyDb(dataDir: string): Database {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new Database(path.join(dataDir, "privacy.sqlite"), { create: true });
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec(`CREATE TABLE IF NOT EXISTS suppressed_users (
    user_id TEXT NOT NULL,
    scope TEXT NOT NULL,
    added_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, scope)
  )`);
  return db;
}

export function addSuppression(db: Database, userId: string, scope: SuppressionScope): void {
  db.run("INSERT OR IGNORE INTO suppressed_users (user_id, scope, added_at) VALUES (?, ?, ?)", [
    userId,
    scope,
    Date.now(),
  ]);
}

export function loadSuppressed(db: Database, scope: SuppressionScope): Set<string> {
  const rows = db.query("SELECT user_id FROM suppressed_users WHERE scope = ?").all(scope) as {
    user_id: string;
  }[];
  return new Set(rows.map((r) => r.user_id));
}
