import type { Database, Statement } from "bun:sqlite";
import { Deltas, FileDeltas, type Row, type SummaryOp } from "../aggregate/deltas";
import { DAY_MS, kstDay, kstYear } from "../aggregate/time";
import { Store, setMeta } from "./store";
import { TABLES, mergeExpr, type ColumnOp, type FileKind, type TableName } from "./tables";

/** Joins older than this no longer receive activity updates. */
const SUMMARY_WINDOW_MS = 60 * DAY_MS;

const stmtCache = new WeakMap<Database, Map<string, Statement>>();

function prepared(db: Database, sql: string): Statement {
  let cache = stmtCache.get(db);
  if (!cache) {
    cache = new Map();
    stmtCache.set(db, cache);
  }
  let stmt = cache.get(sql);
  if (!stmt) {
    stmt = db.prepare(sql);
    cache.set(sql, stmt);
  }
  return stmt;
}

function upsertSQL(table: TableName, cols: string[]): string {
  const def = TABLES[table];
  const keys = Object.keys(def.keys);
  const ops = def.cols as Record<string, { op: ColumnOp }>;
  const all = [...keys, ...cols];
  const updates = cols.map((c) => mergeExpr(c, ops[c].op, `excluded.${c}`));
  return (
    `INSERT INTO ${table} (${all.join(", ")}) VALUES (${all.map(() => "?").join(", ")}) ` +
    `ON CONFLICT (${keys.join(", ")}) DO UPDATE SET ${updates.join(", ")}`
  );
}

function writeRow(db: Database, table: TableName, row: Row): void {
  const cols = Object.keys(row.vals).sort();
  const sql = upsertSQL(table, cols);
  prepared(db, sql).run(...(row.keys as any[]), ...(cols.map((c) => row.vals[c]) as any[]));
}

const JOIN_SQL = `INSERT OR IGNORE INTO member_summary (guild_id, user_id, joined_at) VALUES (?, ?, ?)`;

// Targets the member's most recent observed join at or before t. Every update is
// order-independent (MIN / OR), so replays and merges converge.
const LATEST_JOIN = `guild_id = ?1 AND user_id = ?2 AND joined_at = (
  SELECT MAX(joined_at) FROM member_summary WHERE guild_id = ?1 AND user_id = ?2 AND joined_at <= ?3
)`;

const ACTIVITY_SQL = `UPDATE member_summary SET
  first_msg_at = CASE WHEN first_msg_at IS NULL OR ?3 < first_msg_at THEN ?3 ELSE first_msg_at END,
  active_d7_14 = active_d7_14 | (?3 - joined_at >= ${7 * DAY_MS} AND ?3 - joined_at < ${15 * DAY_MS}),
  active_d0_30 = active_d0_30 | (?3 - joined_at < ${30 * DAY_MS})
WHERE ${LATEST_JOIN} AND ?3 - joined_at < ${SUMMARY_WINDOW_MS}`;

const LEAVE_SQL = `UPDATE member_summary SET
  left_at = CASE WHEN left_at IS NULL OR ?3 < left_at THEN ?3 ELSE left_at END
WHERE ${LATEST_JOIN}`;

function writeSummaryOps(db: Database, ops: SummaryOp[]): void {
  // Activity only matters once per member-day for flags; keep the earliest time.
  const activity = new Map<string, SummaryOp>();
  for (const op of ops) {
    if (op.kind === "join") {
      prepared(db, JOIN_SQL).run(op.guildId, op.userId, op.joinedAt);
    } else if (op.kind === "activity") {
      const id = `${op.guildId}:${op.userId}:${kstDay(op.t)}`;
      const prev = activity.get(id);
      if (!prev || op.t < (prev as { t: number }).t) activity.set(id, op);
    }
  }
  for (const op of activity.values()) {
    const a = op as Extract<SummaryOp, { kind: "activity" }>;
    prepared(db, ACTIVITY_SQL).run(a.guildId, a.userId, a.t);
  }
  for (const op of ops) {
    if (op.kind === "leave") prepared(db, LEAVE_SQL).run(op.guildId, op.userId, op.t);
  }
}

export function writeFileDeltas(db: Database, deltas: FileDeltas): void {
  for (const [table, rows] of deltas.tables) {
    for (const row of rows.values()) writeRow(db, table, row);
  }
  if (deltas.summaryOps.length > 0) writeSummaryOps(db, deltas.summaryOps);
}

/**
 * Activity and leaves early in a year can belong to a member who joined late
 * the previous year; their summary row lives in that year's members file.
 */
function routeToPreviousYear(deltas: Deltas, store: Store): void {
  for (const { year, file, deltas: fd } of [...deltas.files.values()]) {
    if (file !== "members") continue;
    const carry = fd.summaryOps.filter(
      (op) => op.kind !== "join" && kstYear(op.t - SUMMARY_WINDOW_MS) < year
    );
    if (carry.length === 0 || !store.getExisting(year - 1, "members")) continue;
    deltas.for(year - 1, "members").summaryOps.push(...carry);
  }
}

export interface FlushResult {
  failed: Deltas;
  errors: { year: number; file: FileKind; error: unknown }[];
}

/**
 * Writes each year file in its own transaction. Units that fail are returned
 * so the caller can merge them back for the next attempt.
 */
export function flush(
  deltas: Deltas,
  store: Store,
  extraMeta?: (db: Database, year: number, file: FileKind) => void
): FlushResult {
  routeToPreviousYear(deltas, store);
  const failed = new Deltas();
  const errors: FlushResult["errors"] = [];

  for (const { year, file, deltas: fd } of deltas.files.values()) {
    if (fd.isEmpty) continue;
    try {
      const db = store.get(year, file);
      db.transaction(() => {
        writeFileDeltas(db, fd);
        extraMeta?.(db, year, file);
      }).immediate();
    } catch (error) {
      failed.for(year, file).mergeFrom(fd);
      errors.push({ year, file, error });
    }
  }
  return { failed, errors };
}

export { setMeta };
