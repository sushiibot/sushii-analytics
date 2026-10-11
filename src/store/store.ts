import { Database } from "bun:sqlite";
import fs from "node:fs";
import path from "node:path";
import {
  GUILD_DERIVED_SQL,
  MEMBER_SUMMARY_SQL,
  META_SQL,
  SCHEMA_VERSION,
  TABLES,
  createTableSQL,
  type FileKind,
  type TableName,
} from "./tables";

export function filePath(dataDir: string, year: number, file: FileKind): string {
  return path.join(dataDir, String(year), `${file}.sqlite`);
}

export function openFile(
  dataDir: string,
  year: number,
  file: FileKind,
  opts: { create: boolean; readonly?: boolean } = { create: true }
): Database | null {
  const p = filePath(dataDir, year, file);
  if (!opts.create && !fs.existsSync(p)) return null;
  fs.mkdirSync(path.dirname(p), { recursive: true });

  const db = new Database(p, opts.readonly ? { readonly: true } : { create: true });
  if (opts.readonly) return db;

  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA synchronous = NORMAL");
  // Keeps VACUUM and sort temp files off the container's unencrypted disk.
  db.exec("PRAGMA temp_store = MEMORY");
  if (file === "members") db.exec("PRAGMA secure_delete = ON");
  initSchema(db, file);
  return db;
}

function initSchema(db: Database, file: FileKind): void {
  db.exec(META_SQL);
  for (const name of Object.keys(TABLES) as TableName[]) {
    if (TABLES[name].file === file) db.exec(createTableSQL(name));
  }
  if (file === "members") db.exec(MEMBER_SUMMARY_SQL);
  if (file === "guild") for (const sql of GUILD_DERIVED_SQL) db.exec(sql);

  db.run("INSERT OR IGNORE INTO meta (key, value) VALUES ('schema_version', ?)", [
    SCHEMA_VERSION,
  ]);
  // Identifies this file so a merge into another file can only be applied once.
  db.run("INSERT OR IGNORE INTO meta (key, value) VALUES ('file_id', ?)", [
    crypto.randomUUID(),
  ]);
  const version = getMeta(db, "schema_version");
  if (version !== SCHEMA_VERSION) {
    throw new Error(`Unsupported schema_version ${version} in ${db.filename}`);
  }
}

export function getMeta(db: Database, key: string): string | null {
  const row = db.query("SELECT value FROM meta WHERE key = ?").get(key) as
    | { value: string }
    | null;
  return row?.value ?? null;
}

export function setMeta(db: Database, key: string, value: string): void {
  db.run(
    "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    [key, value]
  );
}

/** Lazily opened year files under one data directory. */
export class Store {
  private readonly open = new Map<string, Database>();

  constructor(readonly dataDir: string) {}

  get(year: number, file: FileKind): Database {
    const id = `${year}:${file}`;
    let db = this.open.get(id);
    if (!db) {
      db = openFile(this.dataDir, year, file)!;
      this.open.set(id, db);
    }
    return db;
  }

  /** Opens a year file only if it already exists on disk. */
  getExisting(year: number, file: FileKind): Database | null {
    const id = `${year}:${file}`;
    const cached = this.open.get(id);
    if (cached) return cached;
    const db = openFile(this.dataDir, year, file, { create: false });
    if (db) this.open.set(id, db);
    return db;
  }

  close(): void {
    for (const db of this.open.values()) db.close();
    this.open.clear();
  }
}
