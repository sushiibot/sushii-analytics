import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Aggregator } from "../aggregate/aggregator";
import { flush } from "./flush";
import { mergeDir } from "./merge";
import { Store } from "./store";

const G = "100";
const BACKFILL_T = Date.UTC(2026, 2, 10, 3);
const LIVE_T = Date.UTC(2026, 9, 12, 3);

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "merge-test-"));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function write(dir: string, fn: (agg: Aggregator) => void) {
  const store = new Store(dir);
  const agg = new Aggregator();
  fn(agg);
  expect(flush(agg.take(), store).errors).toEqual([]);
  store.close();
}

test("merge adds counters, unions masks, keeps newer names, and applies once", () => {
  const backfill = path.join(root, "backfill");
  const live = path.join(root, "live");
  const msg = (id: string) => ({
    id,
    guild_id: G,
    channel_id: "c1",
    type: 0,
    author: { id: "u1" },
    content: "hi",
  });

  write(backfill, (agg) => {
    agg.apply("CHANNEL_CREATE", { id: "c1", guild_id: G, type: 0, name: "old-name" }, BACKFILL_T);
    agg.apply("MESSAGE_CREATE", msg("1"), BACKFILL_T);
    agg.apply("MESSAGE_CREATE", msg("2"), LIVE_T - 86_400_000);
  });
  write(live, (agg) => {
    agg.apply("CHANNEL_UPDATE", { id: "c1", guild_id: G, type: 0, name: "new-name" }, LIVE_T);
    agg.apply("MESSAGE_CREATE", msg("3"), LIVE_T);
  });

  mergeDir(backfill, live);
  mergeDir(backfill, live);

  const store = new Store(live);
  const g = store.get(2026, "guild");
  expect((g.query("SELECT SUM(messages) n FROM guild_hourly").get() as any).n).toBe(3);
  expect(g.query("SELECT name, first_seen_day FROM channels").get()).toEqual({
    name: "new-name",
    first_seen_day: "2026-03-10",
  });
  const m = store.get(2026, "members").query("SELECT month, messages, active_day_mask FROM member_monthly ORDER BY month").all();
  expect(m).toEqual([
    { month: "2026-03", messages: 1, active_day_mask: 1 << 9 },
    { month: "2026-10", messages: 2, active_day_mask: (1 << 10) | (1 << 11) },
  ]);
  store.close();
});
