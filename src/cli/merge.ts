/**
 * One-off: add a backfill output directory into the live data directory.
 * Safe to rerun; each source file is applied to a destination file at most once.
 *
 *   bun run merge <srcDir> <dstDir>
 */
import { mergeDir } from "../store/merge";

const [srcDir, dstDir] = process.argv.slice(2);
if (!srcDir || !dstDir) {
  console.error("usage: bun run merge <srcDir> <dstDir>");
  process.exit(2);
}

mergeDir(srcDir, dstDir, console.log);
