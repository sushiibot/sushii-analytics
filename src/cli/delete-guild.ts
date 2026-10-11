/**
 * Delete all stored data for one server, in every year file. Use when the bot
 * is removed from a server or its admins ask.
 *
 *   bun run delete-guild <dataDir> <guildId>
 *
 * Remove the bot from the server first, or new events will be recorded again.
 */
import fs from "node:fs";
import { Store } from "../store/store";
import { TABLES, type FileKind, type TableName } from "../store/tables";

const [dataDir, guildId] = process.argv.slice(2);
if (!dataDir || !/^\d{17,20}$/.test(guildId ?? "")) {
  console.error("usage: bun run delete-guild <dataDir> <guildId>");
  process.exit(2);
}

const EXTRA_TABLES: Record<FileKind, string[]> = {
  guild: ["guild_monthly", "cohort_monthly"],
  members: ["member_summary"],
};

// The running bot can flush deltas it buffered before removal; a second pass
// after one flush interval removes those.
const SECOND_PASS_DELAY_MS = 35_000;

function deleteRows(): number {
  const store = new Store(dataDir);
  let total = 0;
  try {
    const years = fs.readdirSync(dataDir).filter((n) => /^\d{4}$/.test(n)).map(Number);
    for (const year of years) {
      for (const file of ["guild", "members"] as FileKind[]) {
        const db = store.getExisting(year, file);
        if (!db) continue;
        const tables = [
          ...(Object.keys(TABLES) as TableName[]).filter(
            (t) => TABLES[t].file === file && "guild_id" in TABLES[t].keys
          ),
          ...EXTRA_TABLES[file],
        ];
        let removed = 0;
        db.transaction(() => {
          for (const t of tables) {
            removed += db.run(`DELETE FROM ${t} WHERE guild_id = ?`, [guildId]).changes;
          }
        }).immediate();
        db.exec("VACUUM");
        console.log(`${year}/${file}: removed ${removed} rows`);
        total += removed;
      }
    }
  } finally {
    store.close();
  }
  return total;
}

console.log(`removed ${deleteRows()} rows; waiting to catch in-flight writes...`);
await Bun.sleep(SECOND_PASS_DELAY_MS);
console.log(`second pass removed ${deleteRows()} rows`);
