/**
 * Handle a deletion request: stop recording the user, then remove their rows
 * from every year's members file. The guild files hold no user IDs.
 *
 *   bun run delete-user <dataDir> <userId>
 *
 * Run `bun run derive` afterwards so derived monthly figures are recomputed.
 * Old copies can still exist in Litestream replica snapshots until they age out.
 */
import fs from "node:fs";
import { addSuppression, openPrivacyDb } from "../store/privacy";
import { Store } from "../store/store";

// A running bot can flush deltas it buffered before reading the suppression
// list; deleting again after one flush interval removes those.
const SECOND_PASS_DELAY_MS = 35_000;

const [dataDir, userId] = process.argv.slice(2);
if (!dataDir || !/^\d{17,20}$/.test(userId ?? "")) {
  console.error("usage: bun run delete-user <dataDir> <userId>");
  process.exit(2);
}

const privacy = openPrivacyDb(dataDir);
addSuppression(privacy, userId, "forget");
privacy.close();

function deleteRows(): number {
  const store = new Store(dataDir);
  let removed = 0;
  try {
    const years = fs.readdirSync(dataDir).filter((n) => /^\d{4}$/.test(n)).map(Number);
    for (const year of years) {
      const db = store.getExisting(year, "members");
      if (!db) continue;
      db.transaction(() => {
        for (const table of ["member_monthly", "member_summary"]) {
          removed += db.run(`DELETE FROM ${table} WHERE user_id = ?`, [userId]).changes;
        }
      }).immediate();
      // secure_delete zeroes the freed pages; VACUUM also rewrites the file without them.
      db.exec("VACUUM");
    }
  } finally {
    store.close();
  }
  return removed;
}

console.log(`removed ${deleteRows()} rows; waiting to catch in-flight writes...`);
await Bun.sleep(SECOND_PASS_DELAY_MS);
console.log(`second pass removed ${deleteRows()} rows`);
console.log("done. Run `bun run derive` for each affected year.");
