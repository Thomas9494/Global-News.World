#!/usr/bin/env node
/**
 * Runs a single ingest cycle and writes the snapshot, then exits.
 * Useful for cron-driven deployments and for warming a fresh checkout:
 *
 *   npm run ingest
 */
import { runIngest } from "../server/ingest.js";
import * as store from "../server/lib/store.js";

const { summary } = await runIngest({ log: console.log });
store.save();

console.log("\n--- summary ---");
console.log(JSON.stringify(summary, null, 2));
process.exit(summary.kept > 0 ? 0 : 1);
