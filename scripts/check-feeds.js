#!/usr/bin/env node
/**
 * Feed health check.
 *
 * Fetches every endpoint in the catalog through the real plugins, then prints
 * a per-country table and writes data/feed-report.json. Use it to verify a
 * source you added actually parses, and to see which outlets have gone stale:
 *
 *   npm run check:feeds
 *   npm run check:feeds -- --failures     only the broken ones
 *   npm run check:feeds -- --country=Kenya
 */
import { writeFileSync } from "node:fs";
import { config } from "../server/config.js";
import { loadSources } from "../server/ingest.js";
import { activePlugins } from "../server/plugins/index.js";
import { REGIONS, ccn3ForSourceKey } from "../server/lib/geo.js";

const args = process.argv.slice(2);
const onlyFailures = args.includes("--failures");
const countryArg = (args.find((a) => a.startsWith("--country=")) || "").split("=")[1];

let sources = loadSources();
if (countryArg) {
  const key = Object.keys(sources).find((k) => k.toLowerCase() === countryArg.toLowerCase());
  if (!key) {
    console.error(`unknown country "${countryArg}". Known keys:\n  ${Object.keys(sources).join(", ")}`);
    process.exit(2);
  }
  sources = { [key]: sources[key] };
}

const totalEndpoints = Object.values(sources).reduce((n, list) => n + list.length, 0);
console.log(`Checking ${totalEndpoints} endpoints across ${Object.keys(sources).length} source groups…\n`);

const coverGaps = Object.keys(REGIONS).filter(
  (id) => !new Set(Object.keys(sources).map(ccn3ForSourceKey).filter(Boolean)).has(id)
);

const health = [];
let seen = 0;
for (const plugin of activePlugins()) {
  const { health: h } = await plugin.collect({
    sources,
    coverGaps,
    onProgress(done, total, record) {
      seen++;
      const mark = record.ok ? "ok " : record.skipped ? "-- " : "FAIL";
      process.stdout.write(
        `\r[${String(seen).padStart(4)}/${totalEndpoints}] ${mark} ${record.outlet.slice(0, 46).padEnd(46)}`
      );
      void done;
      void total;
    },
  });
  health.push(...h);
}
process.stdout.write("\r" + " ".repeat(78) + "\r");

/* ---- group by country ---- */
const byGroup = new Map();
for (const h of health) {
  if (!byGroup.has(h.sourceKey)) byGroup.set(h.sourceKey, []);
  byGroup.get(h.sourceKey).push(h);
}

let ok = 0;
let failed = 0;
let skipped = 0;
let items = 0;

for (const [group, list] of [...byGroup].sort((a, b) => a[0].localeCompare(b[0]))) {
  const g = { ok: list.filter((h) => h.ok), bad: list.filter((h) => !h.ok && !h.skipped), skip: list.filter((h) => h.skipped) };
  ok += g.ok.length;
  failed += g.bad.length;
  skipped += g.skip.length;
  items += g.ok.reduce((n, h) => n + h.items, 0);

  if (onlyFailures && !g.bad.length) continue;

  const groupItems = g.ok.reduce((n, h) => n + h.items, 0);
  console.log(
    `${group.padEnd(26)} ${String(g.ok.length).padStart(3)}/${String(list.length).padEnd(3)} ok  ` +
      `${String(groupItems).padStart(4)} items` +
      (g.bad.length ? `  ${g.bad.length} failing` : "") +
      (g.skip.length ? `  ${g.skip.length} without a feed` : "")
  );
  for (const h of g.bad) console.log(`   ✗ ${h.outlet.slice(0, 52).padEnd(52)} ${h.error}`);
  if (!onlyFailures) for (const h of g.skip) console.log(`   – ${h.outlet.slice(0, 52).padEnd(52)} ${h.error}`);
}

const report = {
  checkedAt: new Date().toISOString(),
  totals: { endpoints: health.length, ok, failed, skipped, items },
  endpoints: health,
};
writeFileSync(config.paths.report, JSON.stringify(report, null, 2));

const fetchable = ok + failed;
const rate = fetchable ? Math.round((ok / fetchable) * 100) : 0;
console.log(
  `\n${ok}/${fetchable} fetchable endpoints returned items (${rate}%), ` +
    `${skipped} documented without a machine-readable feed, ${items} items total.`
);
console.log(`report written to ${config.paths.report}`);

// Green as long as the catalog as a whole is healthy; individual outlets go
// down all the time and must not break CI.
process.exit(rate >= 70 ? 0 : 1);
