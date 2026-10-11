import { TABLES, type ColumnOp, type FileKind, type TableName } from "../store/tables";

export type Value = number | string | null;

export interface Row {
  keys: Value[];
  vals: Record<string, Value>;
}

export type SummaryOp =
  | { kind: "join"; guildId: string; userId: string; joinedAt: number }
  | { kind: "activity"; guildId: string; userId: string; t: number }
  | { kind: "leave"; guildId: string; userId: string; t: number };

function combine(op: ColumnOp, prev: Value | undefined, next: Value): Value {
  if (prev === undefined || prev === null) return next;
  if (next === null) return prev;
  switch (op) {
    case "add":
      return (prev as number) + (next as number);
    case "or":
      return (prev as number) | (next as number);
    case "set":
      return next;
    case "min":
      return next < prev ? next : prev;
    case "max":
      return next > prev ? next : prev;
  }
}

/** Pending writes for one SQLite file (one year, one file kind). */
export class FileDeltas {
  readonly tables = new Map<TableName, Map<string, Row>>();
  readonly summaryOps: SummaryOp[] = [];

  upsert(table: TableName, keys: Value[], vals: Record<string, Value>): void {
    let rows = this.tables.get(table);
    if (!rows) {
      rows = new Map();
      this.tables.set(table, rows);
    }
    const id = JSON.stringify(keys);
    const row = rows.get(id);
    if (!row) {
      rows.set(id, { keys, vals: { ...vals } });
      return;
    }
    const cols = TABLES[table].cols as Record<string, { op: ColumnOp }>;
    for (const [col, v] of Object.entries(vals)) {
      row.vals[col] = combine(cols[col].op, row.vals[col], v);
    }
  }

  mergeFrom(other: FileDeltas): void {
    for (const [table, rows] of other.tables) {
      for (const row of rows.values()) this.upsert(table, row.keys, row.vals);
    }
    // Older ops first so join/activity/leave ordering is preserved.
    this.summaryOps.unshift(...other.summaryOps);
  }

  /** Drops pending per-member writes for users who asked to be forgotten. */
  removeUsers(userIds: Set<string>): void {
    const monthly = this.tables.get("member_monthly");
    if (monthly) {
      for (const [id, row] of monthly) {
        if (userIds.has(row.keys[1] as string)) monthly.delete(id);
      }
    }
    for (let i = this.summaryOps.length - 1; i >= 0; i--) {
      if (userIds.has(this.summaryOps[i].userId)) this.summaryOps.splice(i, 1);
    }
  }

  get isEmpty(): boolean {
    return this.tables.size === 0 && this.summaryOps.length === 0;
  }
}

/** All pending writes, partitioned by `${year}:${file}`. */
export class Deltas {
  readonly files = new Map<string, { year: number; file: FileKind; deltas: FileDeltas }>();

  for(year: number, file: FileKind): FileDeltas {
    const id = `${year}:${file}`;
    let entry = this.files.get(id);
    if (!entry) {
      entry = { year, file, deltas: new FileDeltas() };
      this.files.set(id, entry);
    }
    return entry.deltas;
  }

  get isEmpty(): boolean {
    for (const { deltas } of this.files.values()) if (!deltas.isEmpty) return false;
    return true;
  }
}
