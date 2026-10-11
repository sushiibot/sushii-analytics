/**
 * Leave a user out of published member rankings. Their activity still counts
 * towards server totals. Report generation must exclude this list.
 *
 *   bun run opt-out <dataDir> <userId>
 */
import { addSuppression, openPrivacyDb } from "../store/privacy";

const [dataDir, userId] = process.argv.slice(2);
if (!dataDir || !/^\d{17,20}$/.test(userId ?? "")) {
  console.error("usage: bun run opt-out <dataDir> <userId>");
  process.exit(2);
}

const db = openPrivacyDb(dataDir);
addSuppression(db, userId, "leaderboard");
db.close();
console.log("added to the leaderboard opt-out list");
