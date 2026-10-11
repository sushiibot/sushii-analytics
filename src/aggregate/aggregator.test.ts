import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { derive } from "../derive";
import { flush } from "../store/flush";
import { Store } from "../store/store";
import { Aggregator } from "./aggregator";
import { DAY_MS, kstMonthEnd } from "./time";

const G = "100";
// 2026-03-10 12:00 KST
const T0 = Date.UTC(2026, 2, 10, 3, 0, 0);

function msg(over: Record<string, unknown> = {}) {
  return {
    id: String(Math.random()).slice(2),
    guild_id: G,
    channel_id: "c1",
    type: 0,
    author: { id: "u1" },
    content: "hi",
    attachments: [],
    ...over,
  };
}

let dir: string;
let store: Store;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "agg-test-"));
  store = new Store(dir);
});

afterEach(() => {
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function flushAll(agg: Aggregator) {
  const res = flush(agg.take(), store);
  expect(res.errors).toEqual([]);
}

function hourly() {
  return store.get(2026, "guild").query("SELECT * FROM guild_hourly").all() as any[];
}

describe("messages", () => {
  test("counts content, links, mentions, replies, forwards and attachments", () => {
    const agg = new Aggregator();
    agg.apply("MESSAGE_CREATE", msg({ content: "see https://x.y <@123> 😀" }), T0);
    agg.apply(
      "MESSAGE_CREATE",
      msg({ content: "", attachments: [{}, {}], message_reference: { type: 1 } }),
      T0
    );
    agg.apply("MESSAGE_CREATE", msg({ author: { id: "b", bot: true } }), T0);
    agg.apply("MESSAGE_CREATE", msg({ webhook_id: "w", author: { id: "w" } }), T0);
    flushAll(agg);

    const [h] = hourly();
    expect(h.messages).toBe(4);
    expect(h.bot_messages).toBe(2);
    expect(h.msgs_with_content).toBe(4);
    expect(h.msgs_nonempty).toBe(3);
    expect(h.msgs_with_links).toBe(1);
    expect(h.msgs_with_mentions).toBe(1);
    expect(h.replies).toBe(1);
    expect(h.forwards).toBe(1);
    expect(h.msgs_with_attachments).toBe(1);
    expect(h.attachments).toBe(2);
    // Code points: the emoji counts as 1, not 2 UTF-16 units.
    expect(h.total_length).toBe("see https://x.y <@123> 😀".length - 1 + 2 + 2);
  });

  test("reply pings do not count as mentions", () => {
    const agg = new Aggregator();
    agg.apply("MESSAGE_CREATE", msg({ content: "ok", mentions: [{ id: "9" }] }), T0);
    flushAll(agg);
    expect(hourly()[0].msgs_with_mentions).toBe(0);
  });

  test("duplicate message ids are counted once", () => {
    const agg = new Aggregator();
    const m = msg();
    agg.apply("MESSAGE_CREATE", m, T0);
    agg.apply("MESSAGE_CREATE", m, T0);
    flushAll(agg);
    expect(hourly()[0].messages).toBe(1);
  });

  test("per-user counters exclude bots, webhooks and system messages", () => {
    const agg = new Aggregator();
    agg.apply("MESSAGE_CREATE", msg(), T0);
    agg.apply("MESSAGE_CREATE", msg({ author: { id: "b", bot: true } }), T0);
    agg.apply("MESSAGE_CREATE", msg({ webhook_id: "w", author: { id: "w" } }), T0);
    agg.apply("MESSAGE_CREATE", msg({ type: 8, author: { id: "u2" } }), T0);
    flushAll(agg);
    const rows = store.get(2026, "members").query("SELECT * FROM member_monthly").all() as any[];
    expect(rows).toEqual([
      { guild_id: G, user_id: "u1", month: "2026-03", messages: 1, active_day_mask: 1 << 9 },
    ]);
    const daily = store.get(2026, "guild").query("SELECT boost_msgs FROM guild_daily").get() as any;
    expect(daily.boost_msgs).toBe(1);
  });

  test("DMs are ignored", () => {
    const agg = new Aggregator();
    agg.apply("MESSAGE_CREATE", msg({ guild_id: undefined }), T0);
    flushAll(agg);
    expect(hourly()).toEqual([]);
  });
});

describe("edits", () => {
  test("only edited_timestamp updates count as user edits, deduped", () => {
    const agg = new Aggregator();
    agg.apply("MESSAGE_UPDATE", { id: "m1", guild_id: G, edited_timestamp: null }, T0);
    agg.apply("MESSAGE_UPDATE", { id: "m1", guild_id: G, edited_timestamp: "2026-03-10T03:00:00Z" }, T0);
    agg.apply("MESSAGE_UPDATE", { id: "m1", guild_id: G, edited_timestamp: "2026-03-10T03:00:00Z" }, T0);
    flushAll(agg);
    const [h] = hourly();
    expect(h.edits).toBe(3);
    expect(h.edits_user).toBe(1);
  });
});

describe("restart safety", () => {
  test("active-day masks union instead of double counting across flushes", () => {
    const a = new Aggregator();
    a.apply("MESSAGE_CREATE", msg(), T0);
    flushAll(a);
    // A new process (empty memory) sees the same user on the same day.
    const b = new Aggregator();
    b.apply("MESSAGE_CREATE", msg(), T0 + 1000);
    b.apply("MESSAGE_CREATE", msg(), T0 + DAY_MS);
    flushAll(b);
    const row = store.get(2026, "members").query("SELECT * FROM member_monthly").get() as any;
    expect(row.messages).toBe(3);
    expect(row.active_day_mask).toBe((1 << 9) | (1 << 10));
  });

  test("failed units are returned for retry", () => {
    const agg = new Aggregator();
    agg.apply("MESSAGE_CREATE", msg(), T0);
    const deltas = agg.take();
    store.get(2026, "guild").exec("DROP TABLE guild_hourly");
    const res = flush(deltas, store);
    expect(res.errors.length).toBe(1);
    expect(res.failed.for(2026, "guild").isEmpty).toBe(false);
    expect(res.failed.for(2026, "members").isEmpty).toBe(true);
  });
});

describe("time buckets", () => {
  test("year file follows KST: 15:00 UTC Dec 31 is next year", () => {
    const agg = new Aggregator();
    agg.apply("MESSAGE_CREATE", msg(), Date.UTC(2025, 11, 31, 14, 59));
    agg.apply("MESSAGE_CREATE", msg(), Date.UTC(2025, 11, 31, 15, 0));
    flushAll(agg);
    expect(store.getExisting(2025, "guild")).not.toBeNull();
    const rows2026 = store.get(2026, "members").query("SELECT month FROM member_monthly").all();
    expect(rows2026).toEqual([{ month: "2026-01" }]);
  });

  test("kstMonthEnd", () => {
    expect(kstMonthEnd("2026-12")).toBe(Date.UTC(2026, 11, 31, 15));
  });
});

describe("cohorts", () => {
  test("join, activity and leave produce cohort rates via derive", () => {
    const agg = new Aggregator();
    const joined = new Date(T0).toISOString();
    agg.apply("GUILD_MEMBER_ADD", { guild_id: G, user: { id: "u1" }, joined_at: joined }, T0);
    agg.apply("GUILD_MEMBER_ADD", { guild_id: G, user: { id: "u2" }, joined_at: joined }, T0);
    agg.apply("GUILD_MEMBER_ADD", { guild_id: G, user: { id: "bot", bot: true }, joined_at: joined }, T0);
    flushAll(agg);
    agg.apply("MESSAGE_CREATE", msg(), T0 + 30 * 60_000);
    agg.apply("MESSAGE_CREATE", msg(), T0 + 8 * DAY_MS);
    agg.apply("GUILD_MEMBER_REMOVE", { guild_id: G, user: { id: "u2" } }, T0 + 2 * DAY_MS);
    flushAll(agg);

    derive(store.get(2026, "guild"), store.get(2026, "members"), T0 + 100 * DAY_MS, 1);
    const c = store.get(2026, "guild").query("SELECT * FROM cohort_monthly").get() as any;
    expect(c).toMatchObject({
      join_month: "2026-03",
      joined: 2,
      active_d7_14: 1,
      active_d0_30: 1,
      left_d1: 0,
      left_d7: 1,
      left_d30: 1,
      first_msg_lt1h: 1,
      first_msg_never: 1,
      partial: 0,
    });
    const h = hourly().reduce((n, r) => n + r.joins, 0);
    expect(h).toBe(3);
  });

  test("activity early in the year updates a late-December join in last year's file", () => {
    const agg = new Aggregator();
    const join = Date.UTC(2026, 11, 28, 3);
    agg.apply("GUILD_MEMBER_ADD", { guild_id: G, user: { id: "u1" }, joined_at: new Date(join).toISOString() }, join);
    flushAll(agg);
    agg.apply("MESSAGE_CREATE", msg(), join + 8 * DAY_MS);
    flushAll(agg);
    const s = store.get(2026, "members").query("SELECT * FROM member_summary").get() as any;
    expect(s.first_msg_at).toBe(join + 8 * DAY_MS);
    expect(s.active_d7_14).toBe(1);
  });
});

describe("resent member adds", () => {
  test("an add with an old joined_at counts as a join but not as a new cohort member", () => {
    const agg = new Aggregator();
    agg.apply("GUILD_MEMBER_ADD", { guild_id: G, user: { id: "u1" }, joined_at: "2020-12-27T01:01:47Z" }, T0);
    flushAll(agg);
    expect(hourly()[0].joins).toBe(1);
    expect(store.getExisting(2020, "members")).toBeNull();
    expect(store.get(2026, "members").query("SELECT COUNT(*) n FROM member_summary").get()).toEqual({ n: 0 });
  });
});

describe("privacy", () => {
  test("groups under 5 people are not written", () => {
    const agg = new Aggregator();
    agg.apply("MESSAGE_CREATE", msg(), T0);
    flushAll(agg);
    derive(store.get(2026, "guild"), store.get(2026, "members"), T0 + 30 * DAY_MS);
    expect(store.get(2026, "guild").query("SELECT COUNT(*) n FROM guild_monthly").get()).toEqual({ n: 0 });
  });

  test("forgotten users are not recorded, including pending deltas", () => {
    const agg = new Aggregator();
    agg.apply("MESSAGE_CREATE", msg(), T0);
    agg.setForgotten(new Set(["u1"]));
    agg.apply("MESSAGE_CREATE", msg(), T0 + 1000);
    agg.apply("GUILD_MEMBER_ADD", { guild_id: G, user: { id: "u1" }, joined_at: new Date(T0).toISOString() }, T0);
    flushAll(agg);
    expect(hourly()[0].messages).toBe(2);
    expect(hourly()[0].joins).toBe(1);
    const m = store.get(2026, "members");
    expect(m.query("SELECT COUNT(*) n FROM member_monthly").get()).toEqual({ n: 0 });
    expect(m.query("SELECT COUNT(*) n FROM member_summary").get()).toEqual({ n: 0 });
  });

  test("private channel names are not stored and clear an earlier name", () => {
    const agg = new Aggregator();
    agg.apply("CHANNEL_CREATE", { id: "c9", guild_id: G, type: 0, name: "ticket-alice" }, T0);
    flushAll(agg);
    agg.apply("CHANNEL_UPDATE", {
      id: "c9",
      guild_id: G,
      type: 0,
      name: "ticket-alice",
      permission_overwrites: [{ id: G, type: 0, allow: "0", deny: "1024" }],
    }, T0);
    flushAll(agg);
    expect(store.get(2026, "guild").query("SELECT name FROM channels WHERE channel_id = 'c9'").get()).toEqual({ name: "" });
  });
});

describe("derive monthly", () => {
  test("mau, dau, concentration and histogram", () => {
    const agg = new Aggregator();
    for (let i = 0; i < 9; i++) agg.apply("MESSAGE_CREATE", msg(), T0 + i * DAY_MS);
    agg.apply("MESSAGE_CREATE", msg({ author: { id: "u2" } }), T0);
    flushAll(agg);
    derive(store.get(2026, "guild"), store.get(2026, "members"), T0 + 30 * DAY_MS, 1);
    const m = store.get(2026, "guild").query("SELECT * FROM guild_monthly").get() as any;
    expect(m.mau).toBe(2);
    expect(m.human_messages).toBe(10);
    expect(m.top10pct_share).toBeCloseTo(0.9);
    expect(JSON.parse(m.dau)[9]).toBe(2);
    expect(JSON.parse(m.active_days_hist)).toMatchObject({ "1": 1, "6-10": 1 });
  });
});

describe("dimensions", () => {
  test("thread names are not stored; emoji deletions are tracked", () => {
    const agg = new Aggregator();
    agg.apply("GUILD_CREATE", {
      id: G,
      member_count: 50,
      channels: [{ id: "c1", type: 0, name: "general" }],
      threads: [{ id: "t1", type: 11, name: "secret plans", parent_id: "c1" }],
      emojis: [{ id: "e1", name: "a" }, { id: "e2", name: "b" }],
      roles: [{}, {}],
    }, T0);
    agg.apply("GUILD_EMOJIS_UPDATE", { guild_id: G, emojis: [{ id: "e1", name: "a" }] }, T0 + DAY_MS);
    flushAll(agg);
    const g = store.get(2026, "guild");
    expect(g.query("SELECT channel_id, name, parent_id FROM channels ORDER BY channel_id").all()).toEqual([
      { channel_id: "c1", name: "general", parent_id: null },
      { channel_id: "t1", name: null, parent_id: "c1" },
    ]);
    expect(g.query("SELECT emoji_id, deleted_day FROM guild_emoji ORDER BY emoji_id").all()).toEqual([
      { emoji_id: "e1", deleted_day: null },
      { emoji_id: "e2", deleted_day: "2026-03-11" },
    ]);
    expect(g.query("SELECT member_count, role_count, channel_count FROM guild_daily").get()).toEqual({
      member_count: 50,
      role_count: 2,
      channel_count: 1,
    });
  });

  test("unknown and ignored events", () => {
    const agg = new Aggregator();
    agg.apply("TYPING_START", { guild_id: G }, T0);
    agg.apply("SOMETHING_NEW", { guild_id: G }, T0);
    flushAll(agg);
    const g = store.get(2026, "guild");
    expect(g.query("SELECT type, n FROM unknown_events_daily").all()).toEqual([
      { type: "SOMETHING_NEW", n: 1 },
    ]);
    expect((g.query("SELECT events FROM ingest_coverage_hourly").get() as any).events).toBe(2);
  });
});

describe("retention deadlines", () => {
  test("members file overdue after Jan 31 next year, guild file two years later", async () => {
    const { overdueFiles } = await import("../live");
    store.get(2026, "guild");
    store.get(2026, "members");
    const at = (y: number, m: number, d: number) => Date.UTC(y, m, d, 16);
    expect(overdueFiles(dir, at(2027, 0, 30))).toEqual([]);
    expect(overdueFiles(dir, at(2027, 0, 31))).toEqual(["2026/members"]);
    expect(overdueFiles(dir, at(2028, 0, 31))).toEqual(["2026/members", "2026/guild"]);
  });
});
