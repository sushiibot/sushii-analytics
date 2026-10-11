/**
 * Recompute guild_monthly and cohort_monthly for a year. Run before the
 * year-end report and before deleting that year's members file.
 *
 *   bun run derive <dataDir> <year>
 */
import { derive } from "../derive";
import { Store } from "../store/store";

const [dataDir, yearArg] = process.argv.slice(2);
const year = Number(yearArg);
if (!dataDir || !Number.isInteger(year)) {
  console.error("usage: bun run derive <dataDir> <year>");
  process.exit(2);
}

const store = new Store(dataDir);
const members = store.getExisting(year, "members");
if (!members) {
  console.error(`no members file for ${year} in ${dataDir}`);
  process.exit(1);
}
const result = derive(store.get(year, "guild"), members, Date.now());
console.log(`derived ${result.months} guild-months and ${result.cohorts} cohorts for ${year}`);
store.close();
