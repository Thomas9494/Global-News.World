import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "../config.js";

/**
 * In-memory article store with a JSON snapshot on disk.
 *
 * Deliberately dependency-free: a news map holds a few thousand recent
 * headlines, which fits in memory comfortably, and the snapshot means a restart
 * shows content immediately instead of an empty map while the first ingest runs.
 */

const state = {
  /** ccn3 → { name, articles: Article[] } */
  countries: {},
  /** feed url → { ok, status, items, ms, error, checkedAt } */
  feeds: {},
  lastIngest: null,
  ingestRuns: 0,
  stats: { articles: 0, countries: 0, sources: 0 },
};

export function getState() {
  return state;
}

export function getCountry(ccn3) {
  return state.countries[ccn3] || null;
}

export function listCountries() {
  return Object.entries(state.countries).map(([ccn3, c]) => ({
    ccn3,
    name: c.name,
    articles: c.articles.length,
  }));
}

/** Replaces the article set for one country (ingest writes whole countries). */
export function setCountry(ccn3, name, articles) {
  if (!articles.length) {
    delete state.countries[ccn3];
    return;
  }
  state.countries[ccn3] = { name, articles };
}

export function setFeedHealth(url, health) {
  state.feeds[url] = { ...health, checkedAt: new Date().toISOString() };
}

export function feedHealth() {
  return state.feeds;
}

export function finishIngest(meta = {}) {
  state.lastIngest = new Date().toISOString();
  state.ingestRuns++;
  const articles = Object.values(state.countries).reduce((n, c) => n + c.articles.length, 0);
  const sources = new Set();
  for (const c of Object.values(state.countries)) for (const a of c.articles) sources.add(a.src);
  state.stats = {
    articles,
    countries: Object.keys(state.countries).length,
    sources: sources.size,
    ...meta,
  };
}

/**
 * Writes the snapshot, unless the file on disk already holds fresher data.
 *
 * A web process and a cron ingest can both be running; the web process must
 * never overwrite a newer snapshot with the state it happens to be holding.
 */
export function save(file = config.paths.store) {
  try {
    if (existsSync(file) && state.lastIngest) {
      const onDisk = JSON.parse(readFileSync(file, "utf8"))?.lastIngest;
      if (onDisk && new Date(onDisk) > new Date(state.lastIngest)) {
        console.log("[store] snapshot on disk is newer — not overwriting");
        return false;
      }
    }
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(state));
    renameSync(tmp, file);
    return true;
  } catch (err) {
    console.error("[store] snapshot failed:", err.message);
    return false;
  }
}

export function load(file = config.paths.store) {
  if (!existsSync(file)) return false;
  try {
    const data = JSON.parse(readFileSync(file, "utf8"));
    Object.assign(state, {
      countries: data.countries || {},
      feeds: data.feeds || {},
      lastIngest: data.lastIngest || null,
      ingestRuns: data.ingestRuns || 0,
      stats: data.stats || state.stats,
    });
    return true;
  } catch (err) {
    console.error("[store] snapshot unreadable, starting empty:", err.message);
    return false;
  }
}

/** Test helper — drops everything without touching disk. */
export function reset() {
  state.countries = {};
  state.feeds = {};
  state.lastIngest = null;
  state.ingestRuns = 0;
  state.stats = { articles: 0, countries: 0, sources: 0 };
}
