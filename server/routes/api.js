import { Router } from "express";
import { config } from "../config.js";
import * as store from "../lib/store.js";
import { loadSources, runIngest } from "../ingest.js";
import { CATEGORIES } from "../lib/categorize.js";
import {
  REGIONS,
  CITIES,
  CITY_ALIASES,
  ccn3ForSourceKey,
  isGroupKey,
  citiesForArticles,
  cityLocation,
} from "../lib/geo.js";
import { pluginInfo } from "../plugins/index.js";
import { translationStatus, supportedTargets } from "../lib/translate.js";
import { translateArticle, translationCacheStats } from "../lib/articletranslate.js";
import { resolveReader, LANG_NAMES, LANG_NAMES_EN } from "../lib/geoip.js";
import { relativeTime } from "../lib/text.js";

export const api = Router();

/**
 * How many articles per country travel in the map bundle. The map itself shows
 * at most six cards at a time; the rest is headroom for the topic and category
 * filters, which run client-side. Full text is fetched per article on open.
 */
const BUNDLE_PER_COUNTRY = 30;

/**
 * The outlet catalog, re-keyed from the curated source names to the country
 * names the map uses, so the sources panel resolves for every region.
 */
export function sourcesByRegionName() {
  const raw = loadSources();
  const out = {};
  for (const [key, outlets] of Object.entries(raw)) {
    const ccn3 = ccn3ForSourceKey(key);
    const name = ccn3 ? REGIONS[ccn3]?.name || key : key;
    out[name] = (out[name] || []).concat(outlets);
  }
  return out;
}

/** Recomputes the relative timestamp so cards stay accurate between ingests. */
function withFreshTime(a) {
  return { ...a, time: relativeTime(a.publishedAt) };
}

/**
 * Card-sized projection of an article: everything a news card, a city dot and
 * the client-side filters need, and nothing more. Lede and body arrive with
 * GET /api/article/:id when the reader opens the panel.
 */
function toCard(a) {
  return {
    id: a.id,
    url: a.url,
    src: a.src,
    cat: a.cat,
    lang: a.lang,
    city: a.city,
    srcCity: a.srcCity || "",
    ll: a.ll,
    img: a.img,
    publishedAt: a.publishedAt,
    time: relativeTime(a.publishedAt),
    orig: { title: a.orig.title, teaser: a.orig.teaser },
  };
}

api.get("/bootstrap", async (req, res) => {
  const state = store.getState();
  const news = {};
  const categoryCounts = Object.fromEntries(CATEGORIES.map((c) => [c, 0]));
  let total = 0;

  for (const [ccn3, group] of Object.entries(state.countries)) {
    news[ccn3] = {
      name: group.name,
      total: group.articles.length,
      articles: group.articles.slice(0, BUNDLE_PER_COUNTRY).map(toCard),
    };
    for (const a of group.articles) {
      categoryCounts[a.cat] = (categoryCounts[a.cat] || 0) + 1;
      total++;
    }
  }
  categoryCounts.All = total;

  const regions = {};
  for (const ccn3 of Object.keys(news)) {
    const r = REGIONS[ccn3];
    if (r) regions[ccn3] = { ll: r.ll, z: r.z, min: r.min, bbox: r.bbox || null };
  }

  // Cities the reader can zoom into: every place a bundled story is anchored to,
  // either because it is about that city or because its newsroom sits there.
  const cities = citiesForArticles(Object.values(news).flatMap((g) => g.articles));

  const reader = await resolveReader(req);

  res.json({
    generatedAt: new Date().toISOString(),
    lastIngest: state.lastIngest,
    reader,
    langNames: LANG_NAMES,
    langNamesEn: LANG_NAMES_EN,
    categories: CATEGORIES,
    categoryCounts,
    regions,
    cities,
    news,
    world: { center: [10, 25], zoom: 1.6 },
    cityZoom: 7.6,
    translate: { ...translationStatus(), targets: supportedTargets() },
    stats: state.stats,
  });
});

api.get("/countries", (_req, res) => {
  res.json(
    store.listCountries().map((c) => ({
      ...c,
      region: REGIONS[c.ccn3]?.region || "",
      cca2: REGIONS[c.ccn3]?.cca2 || "",
    }))
  );
});

api.get("/news", (req, res) => {
  const { country, cat, q, lang, limit, city } = req.query;
  const state = store.getState();
  const groups = country
    ? state.countries[country]
      ? [[country, state.countries[country]]]
      : []
    : Object.entries(state.countries);

  const needle = String(q || "").trim().toLowerCase();
  const out = [];
  for (const [ccn3, group] of groups) {
    for (const a of group.articles) {
      if (cat && cat !== "All" && a.cat !== cat) continue;
      if (lang && a.lang !== lang) continue;
      // a city's local news: written about it, or written there
      if (city && a.city !== city && a.srcCity !== city) continue;
      if (needle) {
        const hay = `${a.src} ${group.name} ${a.cat} ${a.city} ${a.orig.title} ${a.orig.teaser}`;
        if (!hay.toLowerCase().includes(needle)) continue;
      }
      out.push({ ccn3, ...toCard(a) });
    }
  }
  out.sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));
  const n = Math.min(Number(limit) || 200, 1000);
  res.json({ total: out.length, articles: out.slice(0, n) });
});

/**
 * One article, plus a translation into the reader's language.
 * ?to=xx forces a language, otherwise it is resolved from the request
 * (CDN geo header → optional IP lookup → Accept-Language → default).
 */
api.get("/article/:id", async (req, res) => {
  for (const [ccn3, group] of Object.entries(store.getState().countries)) {
    const a = group.articles.find((x) => x.id === req.params.id);
    if (!a) continue;
    const reader = await resolveReader(req, req.query.to || req.query.lang);
    const translation = await translateArticle(a, reader.lang);
    return res.json({
      ccn3,
      country: group.name,
      ...withFreshTime(a),
      reader,
      translation,
    });
  }
  res.status(404).json({ error: "article not found" });
});

/**
 * Batch translation for card previews: POST { ids: [...], to: "nl" }.
 * Used when a reader asks to see a whole country's headlines in their language.
 */
api.post("/translate", async (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.slice(0, 50) : [];
  if (!ids.length) return res.status(400).json({ error: "ids[] required" });
  const reader = await resolveReader(req, req.body?.to);

  const index = new Map();
  for (const group of Object.values(store.getState().countries)) {
    for (const a of group.articles) if (ids.includes(a.id)) index.set(a.id, a);
  }

  const out = {};
  for (const id of ids) {
    const a = index.get(id);
    if (!a) continue;
    out[id] = await translateArticle(a, reader.lang);
  }
  res.json({ lang: reader.lang, langName: LANG_NAMES[reader.lang] || reader.lang, translations: out });
});

/** What language this visitor will be served, and how that was decided. */
api.get("/me", async (req, res) => {
  const reader = await resolveReader(req);
  res.json({
    ...reader,
    translation: { ...translationStatus(), targets: supportedTargets() },
  });
});

/* ------------------------------------------------------------------ search --
 * The search box answers three different intents, and the client reacts
 * differently to each:
 *
 *   country  → fly to the country
 *   place    → fly to the town or city
 *   topic    → do not move the map; surface every matching story worldwide
 */

const deaccent = (s) =>
  String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");

function matchCountries(needle) {
  const n = deaccent(needle);
  const live = new Set(Object.keys(store.getState().countries));
  const out = [];
  for (const [ccn3, r] of Object.entries(REGIONS)) {
    const name = deaccent(r.name);
    if (!name.includes(n)) continue;
    out.push({
      ccn3,
      name: r.name,
      ll: r.ll,
      z: r.z,
      live: live.has(ccn3),
      exact: name === n,
      startsWith: name.startsWith(n),
    });
  }
  return out.sort(
    (a, b) => b.exact - a.exact || b.startsWith - a.startsWith || b.live - a.live || a.name.localeCompare(b.name)
  );
}

function matchPlaces(needle) {
  const n = deaccent(needle);
  const out = new Map();

  const consider = (city, matchedOn) => {
    const label = deaccent(matchedOn);
    if (!label.includes(n)) return;
    const prev = out.get(city.name);
    const hit = {
      name: city.name,
      ccn3: city.ccn3,
      country: REGIONS[city.ccn3]?.name || "",
      ll: city.ll,
      capital: city.capital,
      exact: label === n,
      startsWith: label.startsWith(n),
    };
    // a town matched on its own name outranks one matched on an alias
    if (!prev || hit.exact > prev.exact || hit.startsWith > prev.startsWith) out.set(city.name, hit);
  };

  for (const c of CITIES) consider(c, c.name);
  // people search for Luzern, Zürich, Kyiv or München the way their own press
  // writes them, so every spelling the gazetteer knows has to find the place
  for (const [alias, canonical] of Object.entries(CITY_ALIASES)) {
    const city = CITIES.find((c) => c.name === canonical);
    if (city) consider(city, alias);
  }

  return [...out.values()].sort(
    (a, b) => b.exact - a.exact || b.startsWith - a.startsWith || b.capital - a.capital || a.name.localeCompare(b.name)
  );
}

function matchArticles(needle, limit) {
  const n = deaccent(needle);
  const out = [];
  for (const [ccn3, group] of Object.entries(store.getState().countries)) {
    for (const a of group.articles) {
      const inTopic = deaccent(a.cat) === n;
      const hay = deaccent(
        `${a.orig.title} ${a.orig.teaser} ${a.src} ${a.cat} ${a.city} ${group.name}`
      );
      if (!inTopic && !hay.includes(n)) continue;
      // headline hits rank above passing mentions
      const weight =
        (inTopic ? 4 : 0) +
        (deaccent(a.orig.title).includes(n) ? 3 : 0) +
        (deaccent(a.src).includes(n) ? 2 : 0) +
        1;
      out.push({ ccn3, weight, article: a });
    }
  }
  out.sort((a, b) => b.weight - a.weight || new Date(b.article.publishedAt) - new Date(a.article.publishedAt));
  return out.slice(0, limit).map((r) => ({ ccn3: r.ccn3, country: REGIONS[r.ccn3]?.name || "", ...toCard(r.article) }));
}

/**
 * The local press of one city: stories about it, plus stories from newsrooms
 * based there. This is what a city-level zoom shows.
 */
api.get("/city", (req, res) => {
  const name = String(req.query.name || "").trim();
  if (!name) return res.status(400).json({ error: "name required" });

  const out = [];
  let ccn3 = String(req.query.country || "");
  for (const [id, group] of Object.entries(store.getState().countries)) {
    if (ccn3 && id !== ccn3) continue;
    for (const a of group.articles) {
      if (a.city !== name && a.srcCity !== name) continue;
      if (!ccn3) ccn3 = id;
      out.push({ ccn3: id, country: group.name, ...toCard(a) });
    }
  }
  out.sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));

  const outlets = [...new Set(out.filter((a) => a.srcCity === name).map((a) => a.src))];
  res.json({
    city: name,
    ccn3: ccn3 || null,
    country: ccn3 ? REGIONS[ccn3]?.name || "" : "",
    ll: cityLocation(name, ccn3 || undefined),
    localOutlets: outlets,
    total: out.length,
    articles: out.slice(0, Math.min(Number(req.query.limit) || 60, 200)),
  });
});

api.get("/places", (req, res) => {
  const q = String(req.query.q || "").trim();
  if (q.length < 2) return res.json({ places: [] });
  res.json({ places: matchPlaces(q).slice(0, Number(req.query.limit) || 20) });
});

api.get("/search", (req, res) => {
  const q = String(req.query.q || "").trim();
  if (!q) return res.json({ q, type: "empty", countries: [], places: [], articles: [] });

  const limit = Math.min(Number(req.query.limit) || 24, 60);
  const countries = matchCountries(q).slice(0, 10);
  const places = matchPlaces(q).slice(0, 10);
  const articles = matchArticles(q, limit);

  // A country or a town wins only when the name really matches; anything else
  // is treated as a topic so the reader sees stories instead of a map jump.
  let type = "topic";
  if (countries[0]?.exact || (countries[0]?.startsWith && !places[0]?.exact)) type = "country";
  else if (places[0]?.exact || places[0]?.startsWith) type = "place";
  else if (countries.length) type = "country";
  else if (!articles.length && places.length) type = "place";

  res.json({
    q,
    type,
    country: type === "country" ? countries[0] : null,
    place: type === "place" ? places[0] : null,
    countries,
    places,
    total: articles.length,
    articles,
  });
});

api.get("/sources", (req, res) => {
  const all = sourcesByRegionName();
  const name = req.query.country;
  if (name) return res.json({ country: name, sources: all[name] || [] });
  res.json(all);
});

api.get("/health", (_req, res) => {
  const state = store.getState();
  const feeds = Object.values(state.feeds);
  const ok = feeds.filter((f) => f.ok);
  const failed = feeds.filter((f) => !f.ok && !f.skipped);
  const skipped = feeds.filter((f) => f.skipped);
  res.json({
    status: state.lastIngest ? "ok" : "starting",
    lastIngest: state.lastIngest,
    ingestRuns: state.ingestRuns,
    stats: state.stats,
    plugins: pluginInfo(),
    translate: { ...translationStatus(), cache: translationCacheStats() },
    endpoints: {
      total: feeds.length,
      ok: ok.length,
      failed: failed.length,
      skipped: skipped.length,
      items: ok.reduce((n, f) => n + (f.items || 0), 0),
    },
    failures: failed
      .map((f) => ({ outlet: f.outlet, sourceKey: f.sourceKey, url: f.url, status: f.status, error: f.error }))
      .slice(0, 200),
  });
});

api.get("/plugins", (_req, res) => {
  res.json({ plugins: pluginInfo(), sourceGroups: Object.keys(loadSources()).filter(isGroupKey) });
});

/**
 * Manual ingest trigger. Guarded by INGEST_TOKEN so a public deployment cannot
 * be used to hammer upstream feeds; without the env var it is disabled.
 */
api.post("/ingest", async (req, res) => {
  const token = process.env.INGEST_TOKEN;
  if (!token) return res.status(403).json({ error: "manual ingest disabled (set INGEST_TOKEN)" });
  if (req.get("x-ingest-token") !== token) return res.status(401).json({ error: "unauthorized" });
  try {
    const { summary } = await runIngest({ log: console.log });
    store.save();
    res.json(summary);
  } catch (err) {
    res.status(500).json({ error: String(err?.message || err) });
  }
});

api.get("/config", (_req, res) => {
  res.json({
    ingest: {
      intervalMin: config.ingest.intervalMin,
      maxAgeHours: config.ingest.maxAgeHours,
      maxPerCountry: config.ingest.maxPerCountry,
      routeGlobalFeeds: config.ingest.routeGlobalFeeds,
    },
    translate: { ...translationStatus(), targets: supportedTargets() },
    plugins: pluginInfo(),
  });
});
