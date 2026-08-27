import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fetchText, mapLimit } from "../lib/http.js";
import { parseFeed } from "../lib/feedparser.js";
import { langFromCatalog } from "../lib/lang.js";
import { config } from "../config.js";

/**
 * The city press: local newspapers, broadcasters and city desks, keyed by the
 * town they publish in.
 *
 * This is the layer that makes zooming past a country worthwhile. A country
 * feed tells you what a nation is discussing; the Luzerner press, the Lagos
 * press or the Osaka press tells you what a place is actually like this week —
 * and that layer never crosses a border on its own.
 *
 * The catalog lives in data/city-sources.json:
 *
 *   { "Switzerland": { "Zurich": [ { "m": "NZZ", "l": "DE", "r": "…", "w": "…" } ],
 *                      "_country": [ … outlets with no particular city … ] } }
 *
 * Import or refresh it from a spreadsheet with:
 *   node scripts/import-media-list.mjs <list.xlsx>
 */
const CATALOG = "city-sources.json";

let cache = null;
let cacheStamp = 0;

export function loadCitySources(file = join(config.paths.data, CATALOG)) {
  if (!existsSync(file)) return {};
  // re-read at most once a minute so an edited catalog is picked up without a restart
  if (cache && Date.now() - cacheStamp < 60000) return cache;
  try {
    cache = JSON.parse(readFileSync(file, "utf8"));
    cacheStamp = Date.now();
  } catch (err) {
    console.error(`[citypress] ${CATALOG} is unreadable:`, err.message);
    cache = {};
  }
  return cache;
}

/** Flattens the catalog into one entry per feed. */
export function cityTargets(catalog) {
  const out = [];
  for (const [country, cities] of Object.entries(catalog)) {
    for (const [city, outlets] of Object.entries(cities)) {
      for (const outlet of outlets) {
        if (!outlet?.r) continue;
        out.push({ country, city: city === "_country" ? "" : city, outlet });
      }
    }
  }
  return out;
}

const plugin = {
  id: "city-press",
  label: "City press (local outlets, keyed by town)",
  enabled: () => config.plugins.cityPress,

  async collect({ onProgress } = {}) {
    const targets = cityTargets(loadCitySources());
    if (!targets.length) return { items: [], health: [] };

    const items = [];
    const health = [];
    let done = 0;

    await mapLimit(targets, config.ingest.concurrency, async (t) => {
      const res = await fetchText(t.outlet.r);
      let parsed = { format: "", meta: {}, items: [] };
      let error = res.error || null;

      if (res.ok && res.text) {
        if (/^\s*(<!doctype html|<html)/i.test(res.text)) error = "endpoint returns a web page, not a feed";
        else {
          parsed = parseFeed(res.text, res.contentType);
          if (parsed.error) error = `parse: ${parsed.error}`;
          else if (!parsed.items.length) error = "feed parsed but is empty";
        }
      } else if (!error) {
        error = `HTTP ${res.status}`;
      }

      const record = {
        plugin: this.id,
        sourceKey: t.country,
        outlet: t.city ? `${t.outlet.m} · ${t.city}` : t.outlet.m,
        url: t.outlet.r,
        ok: parsed.items.length > 0,
        skipped: false,
        status: res.status,
        format: parsed.format || "",
        items: parsed.items.length,
        ms: res.ms,
        error: parsed.items.length ? null : error,
      };
      health.push(record);
      onProgress?.(++done, targets.length, record);

      for (const i of parsed.items.slice(0, config.cityPress.perFeed)) {
        if (!i.title || !i.link) continue;
        items.push({
          ...i,
          src: t.outlet.m,
          srcHome: t.outlet.w || parsed.meta.link || "",
          sourceKey: t.country,
          // the town this newsroom publishes in, which is what a city zoom uses
          forceCity: t.city,
          catalogLang: langFromCatalog(t.outlet.l),
          feedLang: parsed.meta.language || "",
          feedUrl: t.outlet.r,
          plugin: this.id,
        });
      }
    });

    return { items, health };
  },
};

export default plugin;
