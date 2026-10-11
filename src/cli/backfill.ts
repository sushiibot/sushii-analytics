/**
 * One-off: replay a legacy raw-event database through the aggregator into
 * fresh year files. Resumable; each output file records how far it got.
 *
 *   bun run backfill <legacy.sqlite> <outDir> [--limit-rows N]
 */
import { Database } from "bun:sqlite";
import fs from "node:fs";
import { Aggregator } from "../aggregate/aggregator";
import { flush } from "../store/flush";
import { Store, getMeta, setMeta } from "../store/store";

const CHUNK_ROWS = 50_000;
const WATERMARK = "backfill_watermark";

const [legacyPath, outDir, ...rest] = process.argv.slice(2);
if (!legacyPath || !outDir) {
  console.error("usage: bun run backfill <legacy.sqlite> <outDir> [--limit-rows N]");
  process.exit(2);
}
const limitIdx = rest.indexOf("--limit-rows");
const limitRows = limitIdx >= 0 ? Number(rest[limitIdx + 1]) : Infinity;

const legacy = new Database(legacyPath, { readonly: true });
const store = new Store(outDir);
const aggregator = new Aggregator();
const decoder = new TextDecoder();

const { lo, hi } = legacy.query("SELECT MIN(rowid) AS lo, MAX(rowid) AS hi FROM events").get() as {
  lo: number;
  hi: number;
};

// Resume from the lowest watermark of any existing output file.
let start = lo;
const existing = new Map<string, number>();
const years = fs.existsSync(outDir)
  ? fs.readdirSync(outDir).filter((n) => /^\d{4}$/.test(n)).map(Number)
  : [];
for (const year of years) {
  for (const file of ["guild", "members"] as const) {
    const db = store.getExisting(year, file);
    const wm = db ? Number(getMeta(db, WATERMARK) ?? 0) : 0;
    existing.set(`${year}:${file}`, wm);
  }
}
const anyProgress = [...existing.values()].some((v) => v > 0);
if (anyProgress) start = Math.min(...[...existing.values()].filter((v) => v > 0)) + 1;

console.log(`legacy rowids ${lo}..${hi}, starting at ${start}`);

const rowsQuery = legacy.query(
  "SELECT rowid, time, type, payload FROM events WHERE rowid >= ? AND rowid < ? ORDER BY rowid"
);

let processed = 0;
let failedParse = 0;
let lastTime = 0;
let lastRowid = start - 1;
const started = Date.now();

for (let from = start; from <= hi && processed < limitRows; from += CHUNK_ROWS) {
  const to = Math.min(from + CHUNK_ROWS, hi + 1);
  for (const row of rowsQuery.iterate(from, to) as Iterable<{
    rowid: number;
    time: number;
    type: string;
    payload: Uint8Array | string;
  }>) {
    let d: unknown;
    try {
      d = JSON.parse(typeof row.payload === "string" ? row.payload : decoder.decode(row.payload));
    } catch {
      failedParse++;
      continue;
    }
    aggregator.apply(row.type, d, row.time);
    lastTime = row.time;
    lastRowid = row.rowid;
    if (++processed >= limitRows) break;
  }

  const chunkEnd = processed >= limitRows ? lastRowid : to - 1;
  const deltas = aggregator.take();
  // Drop units already committed on a previous run so a resume never double counts.
  for (const id of [...deltas.files.keys()]) {
    const wm = existing.get(id) ?? 0;
    if (wm >= chunkEnd) deltas.files.delete(id);
    else existing.set(id, chunkEnd);
  }
  const { errors } = flush(deltas, store, (db) => setMeta(db, WATERMARK, String(chunkEnd)));
  if (errors.length > 0) {
    console.error("flush failed; stopping. Rerun to resume.", errors);
    process.exit(1);
  }

  const rate = Math.round(processed / ((Date.now() - started) / 1000));
  console.log(
    `rowid ${chunkEnd}/${hi}  processed=${processed}  ${rate}/s  at=${new Date(lastTime).toISOString()}`
  );
}

console.log(`done: processed=${processed} failedParse=${failedParse}`);
store.close();
legacy.close();
