#!/usr/bin/env node
/**
 * Imports a city-level media list from a spreadsheet into data/city-sources.json.
 *
 *   node scripts/import-media-list.mjs <list.xlsx> [--sheet News_Feeds] [--no-validate] [--dry-run]
 *
 * The sheet needs a header row with these columns (extra columns are ignored):
 *
 *   Land · ISO · Stadt · Medium · Sprache · Website · RSS-Feed-URL
 *
 * English headings work too (Country, City, Outlet, Language, Website, RSS).
 *
 * Every feed is fetched once before it is written, and only feeds that actually
 * answer are imported — the catalog should never claim coverage it does not
 * have. Rejected rows are written next to it with the reason, so they can be
 * fixed rather than silently lost.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { readWorkbook, rowsToObjects } from "./lib/xlsx.mjs";
import { fetchText, mapLimit } from "../server/lib/http.js";
import { parseFeed } from "../server/lib/feedparser.js";
import { REGIONS, resolveCity } from "../server/lib/geo.js";
import { config } from "../server/config.js";

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("--"));
const sheetName = (args.find((a) => a.startsWith("--sheet=")) || "").split("=")[1] || "News_Feeds";
const validate = !args.includes("--no-validate");
const dryRun = args.includes("--dry-run");

if (!file) {
  console.error("usage: node scripts/import-media-list.mjs <list.xlsx> [--sheet=News_Feeds] [--no-validate] [--dry-run]");
  process.exit(2);
}

const pick = (row, ...names) => {
  for (const n of names) {
    const key = Object.keys(row).find((k) => k.toLowerCase().startsWith(n.toLowerCase()));
    if (key && row[key]) return row[key];
  }
  return "";
};

const book = readWorkbook(file);
const sheet = book[sheetName] || book[Object.keys(book).find((k) => k.toLowerCase().includes("feed"))];
if (!sheet) {
  console.error(`sheet "${sheetName}" not found. Sheets in this file: ${Object.keys(book).join(", ")}`);
  process.exit(2);
}

const cca2ToCcn3 = new Map(Object.entries(REGIONS).map(([ccn3, r]) => [r.cca2, ccn3]));

const rows = [];
const rejected = [];
for (const row of rowsToObjects(sheet)) {
  const outlet = pick(row, "Medium", "Outlet", "Media");
  const feed = pick(row, "RSS-Feed-URL", "RSS", "Feed");
  const iso = pick(row, "ISO", "Country Code").toUpperCase();
  const city = pick(row, "Stadt", "City");
  if (!outlet) continue;

  const reject = (reason) => rejected.push({ outlet, iso, city, feed, reason });

  const ccn3 = cca2ToCcn3.get(iso);
  if (!ccn3) {
    reject(`unknown country code "${iso}"`);
    continue;
  }
  if (!/^https?:\/\/\S+$/.test(feed)) {
    reject("no usable feed url");
    continue;
  }
  const place = resolveCity(city, ccn3);
  if (city && !place) {
    reject(`city "${city}" is not in data/cities.json — add it with coordinates`);
    continue;
  }

  rows.push({
    ccn3,
    iso,
    country: REGIONS[ccn3].name,
    city: place ? place.name : "",
    outlet,
    lang: pick(row, "Sprache", "Language").slice(0, 2).toLowerCase(),
    site: pick(row, "Website", "Site", "Homepage"),
    feed,
  });
}

console.log(`${rows.length} rows to consider, ${rejected.length} rejected before fetching`);

/* ---------------------------------------------------------- validation -- */

let accepted = rows;
if (validate) {
  console.log(`checking ${rows.length} feeds…`);
  let done = 0;
  const checked = await mapLimit(rows, config.ingest.concurrency, async (r) => {
    const res = await fetchText(r.feed, { timeoutMs: 15000 });
    let verdict = null;
    if (!res.ok) verdict = res.error || `HTTP ${res.status}`;
    else if (/^\s*(<!doctype html|<html)/i.test(res.text)) verdict = "returns a web page, not a feed";
    else {
      const parsed = parseFeed(res.text, res.contentType);
      if (parsed.error) verdict = `parse: ${parsed.error}`;
      else if (!parsed.items.length) verdict = `feed parsed but is empty (${parsed.format || "unknown"})`;
      else r.items = parsed.items.length;
    }
    done++;
    if (done % 50 === 0) process.stdout.write(`\r  ${done}/${rows.length}`);
    return verdict ? { ...r, reason: verdict } : r;
  });
  process.stdout.write("\r" + " ".repeat(30) + "\r");

  accepted = checked.filter((r) => r && !r.reason);
  for (const r of checked) if (r?.reason) rejected.push(r);
  console.log(`${accepted.length} feeds returned items, ${checked.length - accepted.length} did not`);
}

/* -------------------------------------------------------------- write --- */

const catalog = {};
for (const r of accepted) {
  const country = (catalog[r.country] ||= {});
  const city = (country[r.city || "_country"] ||= []);
  if (city.some((o) => o.r === r.feed)) continue;
  city.push({ m: r.outlet, l: (r.lang || "").toUpperCase(), r: r.feed, w: r.site });
}

const countries = Object.keys(catalog).length;
const cities = Object.values(catalog).reduce((n, c) => n + Object.keys(c).filter((k) => k !== "_country").length, 0);
const outlets = accepted.length;

console.log(`\n→ ${outlets} outlets · ${cities} cities · ${countries} countries`);
if (dryRun) {
  console.log("(dry run — nothing written)");
  process.exit(0);
}

const out = join(config.paths.data, "city-sources.json");
writeFileSync(
  out,
  JSON.stringify(catalog, null, 0).replace(/\},\{/g, "},\n{").replace(/\],"/g, '],\n"').replace(/:\{"/g, ': {\n"') + "\n"
);
writeFileSync(join(config.paths.data, "city-sources-rejected.json"), JSON.stringify(rejected, null, 1));

console.log(`written: ${out}`);
console.log(`rejected rows (with reasons): data/city-sources-rejected.json`);
