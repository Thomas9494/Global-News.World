import { readFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.js";
import { activePlugins } from "./plugins/index.js";
import { categorize } from "./lib/categorize.js";
import { resolveLang } from "./lib/lang.js";
import {
  REGIONS,
  ccn3ForSourceKey,
  isGroupKey,
  detectCity,
  countryCenter,
  routeCountry,
  outletCity,
  cityLocation,
} from "./lib/geo.js";
import { hash, truncate, toParagraphs, stripHtml, relativeTime, canonicalUrl } from "./lib/text.js";
import * as store from "./lib/store.js";

/**
 * The ingest pipeline.
 *
 *   plugins → normalise → locate → classify → de-duplicate → store
 *
 * Every article the map shows comes out of this function. There is no seeded
 * or sample content anywhere in the project: if the feeds are unreachable the
 * map is empty and /api/health says why.
 *
 * Articles are stored in their original language. Translation into the
 * reader's language is a request-time concern (server/lib/articletranslate.js).
 */

export function loadSources() {
  return JSON.parse(readFileSync(join(config.paths.data, "sources.json"), "utf8"));
}

/** Parses the many date shapes feeds emit; returns epoch ms or null. */
export function parseDate(value) {
  if (!value) return null;
  const s = String(value).trim();
  let t = Date.parse(s);
  if (Number.isFinite(t)) return t;
  // "2026-08-27 14:30:00" (no T) and "27.08.2026 14:30"
  t = Date.parse(s.replace(" ", "T"));
  if (Number.isFinite(t)) return t;
  const m = /^(\d{1,2})[.\/](\d{1,2})[.\/](\d{4})(?:[ T](\d{1,2}):(\d{2}))?/.exec(s);
  if (m) {
    const d = Date.UTC(+m[3], +m[2] - 1, +m[1], +(m[4] || 0), +(m[5] || 0));
    if (Number.isFinite(d)) return d;
  }
  return null;
}

const isHttpImage = (u) => /^https?:\/\//i.test(String(u || ""));

/**
 * Turns one raw plugin item into the article shape the frontend renders.
 * @param {object} raw
 * @param {number} [now]
 * @param {{maxAgeHours?: number}} [opts] overrides the freshness window
 */
export function normalizeItem(raw, now = Date.now(), opts = {}) {
  const title = stripHtml(raw.title).trim();
  const link = canonicalUrl(raw.link);
  if (!title || !link) return null;

  // --- locate -------------------------------------------------------------
  let ccn3 = raw.forceCcn3 || ccn3ForSourceKey(raw.sourceKey);
  let routed = null;
  if (!ccn3 && isGroupKey(raw.sourceKey) && config.ingest.routeGlobalFeeds) {
    routed = routeCountry(`${title} ${raw.summary || ""}`);
    ccn3 = routed?.ccn3 || null;
  }
  if (!ccn3 || !REGIONS[ccn3]) return null;

  // --- time ---------------------------------------------------------------
  const ts = parseDate(raw.published);
  const publishedAt = ts && ts < now + 36e5 ? ts : now;
  const maxAgeHours = opts.maxAgeHours ?? config.ingest.maxAgeHours;
  if (maxAgeHours > 0 && now - publishedAt > maxAgeHours * 36e5) {
    return null;
  }

  // --- language, topic, place --------------------------------------------
  const summary = stripHtml(raw.summary || "");
  const lang = resolveLang({
    itemLang: raw.lang,
    feedLang: raw.feedLang,
    catalogLang: raw.catalogLang,
    text: `${title} ${summary}`,
  });
  const cat = categorize({ title, summary, categories: raw.categories, link });
  // the headline's own place wins; a place-scoped feed supplies one otherwise
  const place =
    detectCity(`${title} ${summary}`, ccn3) ||
    (raw.forceCity && cityLocation(raw.forceCity, ccn3)
      ? { city: raw.forceCity, ll: cityLocation(raw.forceCity, ccn3) }
      : null);
  // Where the newsroom sits. A story with no city of its own still belongs to
  // its outlet's home city, which is what makes a city-level zoom useful.
  const srcCity = routed ? "" : raw.forceCity || outletCity(raw.src, ccn3);
  // pin to the story's city, else the newsroom's, else the country
  const ll = place?.ll || (srcCity && cityLocation(srcCity, ccn3)) || countryCenter(ccn3);

  const body = toParagraphs(raw.content || summary);
  const orig = {
    title,
    teaser: truncate(summary || title, 150),
    lede: truncate(summary || title, 280),
    body: body.length ? body : summary ? [summary] : [],
  };

  return {
    id: hash(link),
    url: link,
    src: raw.src,
    srcHome: raw.srcHome || "",
    sourceKey: raw.sourceKey,
    plugin: raw.plugin,
    /** Set when the article reached us through an index rather than the outlet's own feed. */
    viaIndex: raw.viaIndex || "",
    ccn3,
    country: REGIONS[ccn3].name,
    cat,
    lang,
    city: place?.city || "",
    srcCity,
    ll,
    img: isHttpImage(raw.image) ? raw.image : "",
    publishedAt: new Date(publishedAt).toISOString(),
    time: relativeTime(publishedAt, now),
    routedFrom: routed ? { via: routed.via, sourceKey: raw.sourceKey } : null,
    /**
     * The article exactly as its newsroom published it. Translation into the
     * reader's language happens on demand in the API layer, never here — the
     * map shows local reporting in the local language by design.
     */
    orig,
  };
}

/** Drops repeats by URL, then by near-identical headline inside a country. */
export function dedupe(articles) {
  const byUrl = new Map();
  for (const a of articles) {
    const prev = byUrl.get(a.url);
    if (!prev || new Date(a.publishedAt) > new Date(prev.publishedAt)) byUrl.set(a.url, a);
  }
  const seenTitles = new Set();
  const out = [];
  for (const a of byUrl.values()) {
    const key = `${a.ccn3}:${hash(a.orig.title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ""))}`;
    if (seenTitles.has(key)) continue;
    seenTitles.add(key);
    out.push(a);
  }
  return out;
}

/**
 * Trims a country to its cap without letting the capital crowd everywhere else
 * out. Zurich publishes far more than Chur, but zooming into Chur has to find
 * something, so cities take turns: the newest story from each place, then the
 * next, and only then whatever is left by recency.
 *
 * @param {object[]} articles newest first
 */
export function capFairlyByCity(articles, cap) {
  if (!cap || articles.length <= cap) return articles;

  const queues = new Map();
  for (const a of articles) {
    const place = a.city || a.srcCity || "";
    if (!queues.has(place)) queues.set(place, []);
    queues.get(place).push(a);
  }

  const out = [];
  const taken = new Set();
  // round-robin over the places, so every town gets a turn before anyone gets seconds
  let served = true;
  while (served && out.length < cap) {
    served = false;
    for (const queue of queues.values()) {
      if (out.length >= cap) break;
      const next = queue.shift();
      if (!next) continue;
      out.push(next);
      taken.add(next.id);
      served = true;
    }
  }
  // fill any remainder with the newest of what is left
  if (out.length < cap) {
    for (const a of articles) {
      if (out.length >= cap) break;
      if (!taken.has(a.id)) out.push(a);
    }
  }
  out.sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));
  return out;
}

/**
 * Runs one full ingest cycle and writes the result into the store.
 * @param {{log?: Function, sources?: object}} [opts]
 */
export async function runIngest(opts = {}) {
  const log = opts.log || (() => {});
  const sources = opts.sources || loadSources();
  const started = Date.now();
  const plugins = activePlugins();

  const now = Date.now();
  const allHealth = [];
  const normalized = [];
  /** Everything the plugins returned, for the quiet-country second look. */
  const rejected = [];
  let collected = 0;
  let dropped = 0;

  /**
   * Which countries still have nothing. Recomputed after every plugin so the
   * fallback plugins cover what is actually missing — a curated feed that is
   * down today must not remove its country from the map.
   */
  const gapsNow = () => {
    const have = new Set(normalized.map((a) => a.ccn3));
    return Object.keys(REGIONS).filter((id) => !have.has(id));
  };

  for (const plugin of plugins) {
    const t0 = Date.now();
    const coverGaps = gapsNow();
    log(`[${plugin.id}] collecting… (${coverGaps.length} countries still uncovered)`);

    const { items, health } = await plugin.collect({ sources, coverGaps });
    collected += items.length;
    allHealth.push(...health);
    rejected.push(...items);

    let kept = 0;
    for (const raw of items) {
      const a = normalizeItem(raw, now);
      if (a) {
        normalized.push(a);
        kept++;
      } else dropped++;
    }

    const okFeeds = health.filter((h) => h.ok).length;
    log(
      `[${plugin.id}] ${kept} articles from ${okFeeds}/${health.length} endpoints ` +
        `in ${((Date.now() - t0) / 1000).toFixed(1)}s`
    );
  }

  /**
   * Second look for countries that ended the cycle with nothing. Their press
   * exists, it is simply slower or less well indexed than a 72-hour window
   * assumes. Widening it for those countries only is the difference between a
   * blank spot on the map and an honestly dated story.
   */
  let recovered = 0;
  if (config.ingest.quietCountryAgeHours > config.ingest.maxAgeHours) {
    const quiet = new Set(gapsNow());
    if (quiet.size) {
      for (const raw of rejected) {
        const target = raw.forceCcn3 || ccn3ForSourceKey(raw.sourceKey);
        if (!target || !quiet.has(target)) continue;
        const a = normalizeItem(raw, now, { maxAgeHours: config.ingest.quietCountryAgeHours });
        if (a) {
          normalized.push(a);
          recovered++;
        }
      }
      if (recovered) log(`[quiet countries] recovered ${recovered} older articles for ${quiet.size} blank countries`);
    }
  }

  const unique = dedupe(normalized);
  unique.sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));

  const byCountry = {};
  for (const a of unique) {
    if (!byCountry[a.ccn3]) byCountry[a.ccn3] = { name: a.country, articles: [] };
    byCountry[a.ccn3].articles.push(a);
  }
  for (const group of Object.values(byCountry)) {
    group.articles = capFairlyByCity(group.articles, config.ingest.maxPerCountry);
  }

  for (const [ccn3, group] of Object.entries(byCountry)) {
    store.setCountry(ccn3, group.name, group.articles);
  }
  // Countries that lost all their coverage this cycle must disappear from the map.
  for (const { ccn3 } of store.listCountries()) {
    if (!byCountry[ccn3]) store.setCountry(ccn3, "", []);
  }
  for (const h of allHealth) store.setFeedHealth(h.url, h);

  const summary = {
    ms: Date.now() - started,
    plugins: plugins.map((p) => p.id),
    collected,
    dropped,
    kept: unique.length,
    countries: Object.keys(byCountry).length,
    endpoints: allHealth.length,
    endpointsOk: allHealth.filter((h) => h.ok).length,
    endpointsSkipped: allHealth.filter((h) => h.skipped).length,
    recoveredFromQuietCountries: recovered,
  };
  store.finishIngest(summary);
  log(
    `ingest done: ${summary.kept} articles across ${summary.countries} countries ` +
      `(${summary.endpointsOk}/${summary.endpoints} endpoints ok) in ${(summary.ms / 1000).toFixed(1)}s`
  );
  return { summary, health: allHealth };
}

let timer = null;

export function startScheduler(log = console.log) {
  const minutes = config.ingest.intervalMin;
  if (!minutes) {
    log("[ingest] scheduler disabled (INGEST_INTERVAL_MIN=0)");
    return;
  }
  const tick = async () => {
    try {
      await runIngest({ log });
      store.save();
    } catch (err) {
      console.error("[ingest] cycle failed:", err);
    }
  };
  if (config.ingest.onBoot) tick();
  timer = setInterval(tick, minutes * 60000);
  timer.unref?.();
  log(`[ingest] scheduled every ${minutes} min`);
}

export function stopScheduler() {
  if (timer) clearInterval(timer);
  timer = null;
}
