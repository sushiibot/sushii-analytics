import type { Database } from "bun:sqlite";
import { DAY_MS, HOUR_MS, kstMonth, kstMonthEnd } from "./aggregate/time";

const COHORT_WINDOW_MS = 60 * DAY_MS;
// Groups smaller than this could single out a person, so they are not written.
const MIN_GROUP_SIZE = 5;
const ACTIVE_DAY_BUCKETS: [string, number, number][] = [
  ["1", 1, 1],
  ["2-5", 2, 5],
  ["6-10", 6, 10],
  ["11-20", 11, 20],
  ["21+", 21, 31],
];

function popcount(n: number): number {
  let c = 0;
  for (let x = n >>> 0; x; x &= x - 1) c++;
  return c;
}

function topShare(sortedDesc: number[], total: number, fraction: number): number | null {
  if (total === 0 || sortedDesc.length === 0) return null;
  const n = Math.max(1, Math.ceil(sortedDesc.length * fraction));
  let sum = 0;
  for (let i = 0; i < n; i++) sum += sortedDesc[i];
  return sum / total;
}

/**
 * Recomputes guild_monthly and cohort_monthly for one year from that year's
 * members file. Read-only on members; INSERT OR REPLACE on guild, so it can be
 * run any number of times.
 */
export function derive(
  guild: Database,
  members: Database,
  now: number,
  minGroupSize = MIN_GROUP_SIZE
): {
  months: number;
  cohorts: number;
} {
  const monthly = new Map<string, { messages: number[]; masks: number[] }>();
  const rows = members
    .query("SELECT guild_id, month, messages, active_day_mask FROM member_monthly")
    .iterate() as Iterable<{
    guild_id: string;
    month: string;
    messages: number;
    active_day_mask: number;
  }>;
  for (const r of rows) {
    const id = `${r.guild_id}\u0000${r.month}`;
    let m = monthly.get(id);
    if (!m) monthly.set(id, (m = { messages: [], masks: [] }));
    m.messages.push(r.messages);
    m.masks.push(r.active_day_mask);
  }

  const insertMonthly = guild.prepare(`INSERT OR REPLACE INTO guild_monthly
    (guild_id, month, mau, human_messages, top1pct_share, top10pct_share, active_days_hist, dau, derived_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);

  const cohorts = members
    .query(
      `SELECT guild_id, joined_at, first_msg_at, active_d7_14, active_d0_30, left_at FROM member_summary`
    )
    .all() as {
    guild_id: string;
    joined_at: number;
    first_msg_at: number | null;
    active_d7_14: number;
    active_d0_30: number;
    left_at: number | null;
  }[];

  const byCohort = new Map<string, Record<string, number>>();
  for (const c of cohorts) {
    const id = `${c.guild_id}\u0000${kstMonth(c.joined_at)}`;
    let agg = byCohort.get(id);
    if (!agg) {
      byCohort.set(
        id,
        (agg = {
          joined: 0,
          active_d7_14: 0,
          active_d0_30: 0,
          left_d1: 0,
          left_d7: 0,
          left_d30: 0,
          first_msg_lt1h: 0,
          first_msg_lt1d: 0,
          first_msg_lt7d: 0,
          first_msg_lt30d: 0,
          first_msg_never: 0,
        })
      );
    }
    agg.joined++;
    agg.active_d7_14 += c.active_d7_14;
    agg.active_d0_30 += c.active_d0_30;
    if (c.left_at !== null) {
      const stay = c.left_at - c.joined_at;
      if (stay < DAY_MS) agg.left_d1++;
      if (stay < 7 * DAY_MS) agg.left_d7++;
      if (stay < 30 * DAY_MS) agg.left_d30++;
    }
    const wait = c.first_msg_at === null ? null : c.first_msg_at - c.joined_at;
    if (wait === null || wait >= 30 * DAY_MS) agg.first_msg_never++;
    else if (wait < HOUR_MS) agg.first_msg_lt1h++;
    else if (wait < DAY_MS) agg.first_msg_lt1d++;
    else if (wait < 7 * DAY_MS) agg.first_msg_lt7d++;
    else agg.first_msg_lt30d++;
  }

  const insertCohort = guild.prepare(`INSERT OR REPLACE INTO cohort_monthly
    (guild_id, join_month, joined, active_d7_14, active_d0_30, left_d1, left_d7, left_d30,
     first_msg_lt1h, first_msg_lt1d, first_msg_lt7d, first_msg_lt30d, first_msg_never, partial, derived_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

  guild.transaction(() => {
    // Full recompute, so groups that shrank below the minimum after a deletion disappear.
    guild.run("DELETE FROM guild_monthly");
    guild.run("DELETE FROM cohort_monthly");
    for (const [id, m] of monthly) {
      if (m.messages.length < minGroupSize) continue;
      const [guildId, month] = id.split("\u0000");
      const sorted = [...m.messages].sort((a, b) => b - a);
      const total = sorted.reduce((a, b) => a + b, 0);
      const dau = Array.from({ length: 31 }, (_, d) =>
        m.masks.reduce((n, mask) => n + ((mask >>> d) & 1), 0)
      );
      const hist: Record<string, number> = {};
      for (const [label] of ACTIVE_DAY_BUCKETS) hist[label] = 0;
      for (const mask of m.masks) {
        const days = popcount(mask);
        const bucket = ACTIVE_DAY_BUCKETS.find(([, lo, hi]) => days >= lo && days <= hi);
        if (bucket) hist[bucket[0]]++;
      }
      insertMonthly.run(
        guildId,
        month,
        m.messages.length,
        total,
        topShare(sorted, total, 0.01),
        topShare(sorted, total, 0.1),
        JSON.stringify(hist),
        JSON.stringify(dau),
        now
      );
    }
    for (const [id, a] of byCohort) {
      if (a.joined < minGroupSize) continue;
      const [guildId, joinMonth] = id.split("\u0000");
      const partial = now < kstMonthEnd(joinMonth) + COHORT_WINDOW_MS ? 1 : 0;
      insertCohort.run(
        guildId,
        joinMonth,
        a.joined,
        a.active_d7_14,
        a.active_d0_30,
        a.left_d1,
        a.left_d7,
        a.left_d30,
        a.first_msg_lt1h,
        a.first_msg_lt1d,
        a.first_msg_lt7d,
        a.first_msg_lt30d,
        a.first_msg_never,
        partial,
        now
      );
    }
  }).immediate();

  return { months: monthly.size, cohorts: byCohort.size };
}
