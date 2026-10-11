export type FileKind = "guild" | "members";

/**
 * How a column merges on upsert conflict:
 * - add: running counter
 * - or: bitmask union
 * - set: last write wins (NULL never overwrites)
 * - min / max: keep the extreme, ignoring NULL
 */
export type ColumnOp = "add" | "or" | "set" | "min" | "max";

export type ColumnType = "INTEGER" | "TEXT";

export interface TableDef {
  file: FileKind;
  keys: Record<string, ColumnType>;
  cols: Record<string, { type: ColumnType; op: ColumnOp }>;
}

const counter = { type: "INTEGER", op: "add" } as const;
const setInt = { type: "INTEGER", op: "set" } as const;
const setText = { type: "TEXT", op: "set" } as const;

function counters<const K extends string>(...names: K[]) {
  return Object.fromEntries(names.map((n) => [n, counter])) as Record<
    K,
    typeof counter
  >;
}

export const TABLES = {
  guild_hourly: {
    file: "guild",
    keys: { guild_id: "TEXT", hour: "INTEGER" },
    cols: counters(
      "messages",
      "bot_messages",
      "msgs_with_content",
      "msgs_nonempty",
      "total_length",
      "replies",
      "forwards",
      "msgs_with_links",
      "msgs_with_attachments",
      "attachments",
      "msgs_with_mentions",
      "edits",
      "edits_user",
      "deletes",
      "bulk_delete_events",
      "bulk_deleted_msgs",
      "reactions_add",
      "reactions_add_bot",
      "reactions_add_burst",
      "reactions_remove",
      "joins",
      "leaves",
      "polls_created",
      "poll_votes_add",
      "poll_votes_remove"
    ),
  },
  channel_hourly: {
    file: "guild",
    keys: { guild_id: "TEXT", channel_id: "TEXT", hour: "INTEGER" },
    cols: counters("messages", "bot_messages"),
  },
  channels: {
    file: "guild",
    keys: { guild_id: "TEXT", channel_id: "TEXT" },
    cols: {
      type: setInt,
      parent_id: setText,
      name: setText,
      first_seen_day: { type: "TEXT", op: "min" },
      deleted_day: setText,
    },
  },
  emoji_daily: {
    file: "guild",
    keys: { guild_id: "TEXT", day: "TEXT", emoji_key: "TEXT" },
    cols: {
      emoji_id: setText,
      emoji_name: setText,
      reactions: counter,
    },
  },
  guild_emoji: {
    file: "guild",
    keys: { guild_id: "TEXT", emoji_id: "TEXT" },
    cols: {
      name: setText,
      animated: setInt,
      first_seen_day: { type: "TEXT", op: "min" },
      deleted_day: setText,
    },
  },
  mod_daily: {
    file: "guild",
    keys: { guild_id: "TEXT", day: "TEXT", action_type: "INTEGER" },
    cols: counters("n"),
  },
  guild_daily: {
    file: "guild",
    keys: { guild_id: "TEXT", day: "TEXT" },
    cols: {
      ...counters(
        "threads_created",
        "sched_events_created",
        "sched_event_interest_adds",
        "boost_msgs"
      ),
      member_count: setInt,
      premium_count: setInt,
      premium_tier: setInt,
      channel_count: setInt,
      role_count: setInt,
    },
  },
  ingest_coverage_hourly: {
    file: "guild",
    keys: { hour: "INTEGER" },
    // Samples (one per flush tick) while each privileged intent was enabled, so
    // reports can tell missing data from zero activity.
    cols: counters("events", "ready_samples", "content_intent_samples", "members_intent_samples"),
  },
  unknown_events_daily: {
    file: "guild",
    keys: { day: "TEXT", type: "TEXT" },
    cols: counters("n"),
  },
  member_monthly: {
    file: "members",
    keys: { guild_id: "TEXT", user_id: "TEXT", month: "TEXT" },
    cols: {
      messages: counter,
      active_day_mask: { type: "INTEGER", op: "or" },
    },
  },
} as const satisfies Record<string, TableDef>;

export type TableName = keyof typeof TABLES;
export type KeysOf<T extends TableName> = keyof (typeof TABLES)[T]["keys"];
export type ColsOf<T extends TableName> = keyof (typeof TABLES)[T]["cols"];

function columnDDL(name: string, type: ColumnType, op: ColumnOp): string {
  // Counters and masks default to 0 so a row created by a set-only upsert reads cleanly.
  return op === "add" || op === "or"
    ? `${name} ${type} NOT NULL DEFAULT 0`
    : `${name} ${type}`;
}

export function createTableSQL(name: TableName): string {
  const def: TableDef = TABLES[name];
  const keyCols = Object.entries(def.keys).map(([k, t]) => `${k} ${t} NOT NULL`);
  const cols = Object.entries(def.cols).map(([k, c]) => columnDDL(k, c.type, c.op));
  return `CREATE TABLE IF NOT EXISTS ${name} (${[...keyCols, ...cols].join(
    ", "
  )}, PRIMARY KEY (${Object.keys(def.keys).join(", ")}))`;
}

/** SQL fragment merging `excluded.<col>` (or `src.<col>`) into the existing row. */
export function mergeExpr(col: string, op: ColumnOp, incoming: string): string {
  switch (op) {
    case "add":
      return `${col} = ${col} + ${incoming}`;
    case "or":
      return `${col} = ${col} | ${incoming}`;
    case "set":
      return `${col} = COALESCE(${incoming}, ${col})`;
    case "min":
      return `${col} = CASE WHEN ${col} IS NULL OR ${incoming} < ${col} THEN COALESCE(${incoming}, ${col}) ELSE ${col} END`;
    case "max":
      return `${col} = CASE WHEN ${col} IS NULL OR ${incoming} > ${col} THEN COALESCE(${incoming}, ${col}) ELSE ${col} END`;
  }
}

export const MEMBER_SUMMARY_SQL = `CREATE TABLE IF NOT EXISTS member_summary (
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  joined_at INTEGER NOT NULL,
  first_msg_at INTEGER,
  active_d7_14 INTEGER NOT NULL DEFAULT 0,
  active_d0_30 INTEGER NOT NULL DEFAULT 0,
  left_at INTEGER,
  PRIMARY KEY (guild_id, user_id, joined_at)
)`;

export const GUILD_DERIVED_SQL = [
  `CREATE TABLE IF NOT EXISTS guild_monthly (
    guild_id TEXT NOT NULL,
    month TEXT NOT NULL,
    mau INTEGER NOT NULL,
    human_messages INTEGER NOT NULL,
    top1pct_share REAL,
    top10pct_share REAL,
    active_days_hist TEXT NOT NULL,
    dau TEXT NOT NULL,
    derived_at INTEGER NOT NULL,
    PRIMARY KEY (guild_id, month)
  )`,
  `CREATE TABLE IF NOT EXISTS cohort_monthly (
    guild_id TEXT NOT NULL,
    join_month TEXT NOT NULL,
    joined INTEGER NOT NULL,
    active_d7_14 INTEGER NOT NULL,
    active_d0_30 INTEGER NOT NULL,
    left_d1 INTEGER NOT NULL,
    left_d7 INTEGER NOT NULL,
    left_d30 INTEGER NOT NULL,
    first_msg_lt1h INTEGER NOT NULL,
    first_msg_lt1d INTEGER NOT NULL,
    first_msg_lt7d INTEGER NOT NULL,
    first_msg_lt30d INTEGER NOT NULL,
    first_msg_never INTEGER NOT NULL,
    partial INTEGER NOT NULL,
    derived_at INTEGER NOT NULL,
    PRIMARY KEY (guild_id, join_month)
  )`,
];

export const META_SQL = `CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`;

export const SCHEMA_VERSION = "1";
