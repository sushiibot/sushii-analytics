import { Database } from "bun:sqlite";
import fs from "node:fs";
import { Store, filePath, getMeta, setMeta } from "./store";
import { TABLES, mergeExpr, type ColumnOp, type FileKind, type TableName } from "./tables";

/**
 * The destination holds newer live data, so `set` columns (dimension names,
 * snapshots) only fill gaps instead of reverting to older backfilled values.
 */
function mergeColumnExpr(col: string, op: ColumnOp): string {
  return op === "set" ? `${col} = COALESCE(${col}, excluded.${col})` : mergeExpr(col, op, `excluded.${col}`);
}

function mergeTableSQL(table: TableName): string {
  const def = TABLES[table];
  const keys = Object.keys(def.keys);
  const cols = Object.entries(def.cols as Record<string, { op: ColumnOp }>);
  const all = [...keys, ...cols.map(([c]) => c)];
  // "WHERE true" is required for an upsert on INSERT ... SELECT.
  return (
    `INSERT INTO main.${table} (${all.join(", ")}) SELECT ${all.join(", ")} FROM src.${table} WHERE true ` +
    `ON CONFLICT (${keys.join(", ")}) DO UPDATE SET ${cols.map(([c, { op }]) => mergeColumnExpr(c, op)).join(", ")}`
  );
}

const MERGE_SUMMARY_SQL = `INSERT INTO main.member_summary
  SELECT * FROM src.member_summary WHERE true
  ON CONFLICT (guild_id, user_id, joined_at) DO UPDATE SET
    first_msg_at = CASE WHEN first_msg_at IS NULL OR excluded.first_msg_at < first_msg_at
                        THEN COALESCE(excluded.first_msg_at, first_msg_at) ELSE first_msg_at END,
    active_d7_14 = active_d7_14 | excluded.active_d7_14,
    active_d0_30 = active_d0_30 | excluded.active_d0_30,
    left_at = CASE WHEN left_at IS NULL OR excluded.left_at < left_at
                   THEN COALESCE(excluded.left_at, left_at) ELSE left_at END`;

/** Adds every year file in srcDir into dstDir. Each source file applies at most once. */
export function mergeDir(srcDir: string, dstDir: string, log: (msg: string) => void = () => {}): void {
  const store = new Store(dstDir);
  try {
    const years = fs.readdirSync(srcDir).filter((n) => /^\d{4}$/.test(n)).map(Number);
    for (const year of years) {
      for (const file of ["guild", "members"] as FileKind[]) {
        const src = filePath(srcDir, year, file);
        if (!fs.existsSync(src)) continue;

        const srcDb = new Database(src, { readonly: true });
        const srcId = getMeta(srcDb, "file_id");
        srcDb.close();
        if (!srcId) throw new Error(`${src} has no file_id`);

        const dst = store.get(year, file);
        const guardKey = `merged:${srcId}`;
        if (getMeta(dst, guardKey)) {
          log(`skip ${year}/${file}: already merged`);
          continue;
        }

        dst.run("ATTACH DATABASE ? AS src", [src]);
        try {
          dst.transaction(() => {
            for (const name of Object.keys(TABLES) as TableName[]) {
              if (TABLES[name].file === file) dst.run(mergeTableSQL(name));
            }
            if (file === "members") dst.run(MERGE_SUMMARY_SQL);
            setMeta(dst, guardKey, new Date().toISOString());
          }).immediate();
          log(`merged ${year}/${file}`);
        } finally {
          dst.run("DETACH DATABASE src");
        }
      }
    }
  } finally {
    store.close();
  }
}
