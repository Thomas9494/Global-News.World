import { config } from "../config.js";
import { fetchText } from "./http.js";
import { parseFeed } from "./feedparser.js";
import { REGIONS, CITIES, resolveCity } from "./geo.js";
import { langForCountry } from "./geoip.js";
import { normalizeItem } from "../ingest.js";
import { splitTitle } from "../plugins/googlenews.js";
import * as store from "./store.js";

/**
 * Live news for any place on earth.
 *
 * The gazetteer knows 573 towns and the ingest only stores what the catalogued
 * outlets published, so zooming into Kanchanaburi, Iquique or Nakuru would
 * otherwise show an empty map. These indexes answer for *any* place name, need
 * no API key, and are queried on demand — none of this runs during the normal
 * ingest cycle:
 *
 *   Google News RSS, place-scoped   https://news.google.com/rss/search?q=<place>
 *   GDELT DOC 2.0                   https://api.gdeltproject.org/api/v2/doc/doc
 *
 * And because a reader can zoom into a point rather than a name, a point is
 * turned into a place first, again with key-less services:
 *
 *   BigDataCloud reverse geocode    https://api.bigdatacloud.net/data/reverse-geocode-client
 *   OpenStreetMap Nominatim         https://nominatim.openstreetmap.org/reverse
 *
 * Both layers are cached, because a reader panning across a region would
 * otherwise re-ask the same question for every frame.
 */

const NEWS_TTL_MS = 15 * 60 * 1000;
const PLACE_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 600;

const newsCache = new Map(); // "ccn3:place" → { at, articles }
const placeCache = new Map(); // "lat,lng" → { at, place }
let requests = 0;
let served = 0;

const deaccent = (s) =>
  String(s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");

/** Bounded LRU-ish insert: Map keeps insertion order, so drop from the front. */
function remember(cache, key, value) {
  if (cache.size >= MAX_ENTRIES) {
    let i = 0;
    for (const k of cache.keys()) {
      cache.delete(k);
      if (++i >= Math.ceil(MAX_ENTRIES / 10)) break;
    }
  }
  cache.set(key, value);
}

export function liveStats() {
  return { places: placeCache.size, queries: newsCache.size, requests, served };
}

export function clearLiveCache() {
  newsCache.clear();
  placeCache.clear();
  requests = 0;
  served = 0;
}

/** ISO alpha-2 → ccn3, built once from the country catalog. */
const CCN3_BY_CCA2 = new Map();
for (const [ccn3, r] of Object.entries(REGIONS)) {
  if (r.cca2) CCN3_BY_CCA2.set(r.cca2.toUpperCase(), ccn3);
}

/** The hostname of a URL, or "" when it is not one. */
function hostOfUrl(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

/** Rough degrees between two points, good enough to pick a nearest town. */
function degreesBetween(lng1, lat1, lng2, lat2) {
  const dx = (lng1 - lng2) * Math.cos(((lat1 + lat2) / 2) * (Math.PI / 180));
  return Math.hypot(dx, lat1 - lat2);
}

/**
 * The gazetteer town nearest a point, if one is close enough to be the place
 * the reader is actually looking at. Free, offline and exact — always tried
 * before any network lookup.
 */
export function nearestKnownCity(lng, lat, maxDegrees = 0.45) {
  let best = null;
  let bestD = Infinity;
  for (const c of CITIES) {
    const d = degreesBetween(c.ll[0], c.ll[1], lng, lat);
    if (d < bestD) {
      bestD = d;
      best = c;
    }
  }
  return best && bestD <= maxDegrees ? { ...best, distance: bestD } : null;
}

/* --------------------------------------------------------- reverse geocode -- */

/**
 * Administrative wrappers the geocoders return around a place's actual name:
 * "Amphoe Mueang Kanchanaburi", "Kabupaten Bogor", "Landkreis Rosenheim". The
 * press writes about Kanchanaburi, Bogor and Rosenheim, so a search for the
 * full label finds nothing at all.
 */
const ADMIN_WORDS =
  /\b(amphoe|mueang|tambon|changwat|kabupaten|kecamatan|kota|distrito|municipio|munic[ií]pio|provincia|comuna|departamento|arrondissement|communaut[ée]|canton|d[ée]partement|gemeinde|landkreis|kreis|stadt|bezirk|comune|gmina|powiat|oblast|rayon|raion|okrug|governorate|prefecture|province|district|county|municipality|township|borough|metropolitan|sub-county|local government area|lga|city of|the)\b/gi;

/**
 * Reduces an administrative label to the name people actually use. Falls back
 * to the label untouched when the cleaning would leave nothing behind — a place
 * really can be called "District".
 */
export function placeNameFrom(label) {
  const cleaned = String(label || "")
    .replace(ADMIN_WORDS, " ")
    .replace(/[,–—-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.length >= 3 ? cleaned : String(label || "").trim();
}

/**
 * BigDataCloud's client endpoint: no key, no signup, and it answers for any
 * coordinate on land. Documented as free for client-side use.
 */
async function viaBigDataCloud(lat, lng) {
  const url =
    "https://api.bigdatacloud.net/data/reverse-geocode-client?" +
    new URLSearchParams({ latitude: String(lat), longitude: String(lng), localityLanguage: "en" });
  const res = await fetchText(url, { headers: { Accept: "application/json" }, timeoutMs: 8000 });
  if (!res.ok || !res.text) return null;
  const d = JSON.parse(res.text);
  const name = placeNameFrom(d.city || d.locality || d.principalSubdivision || "");
  const cca2 = String(d.countryCode || "").toUpperCase();
  return name && cca2 ? { name, cca2, via: "bigdatacloud" } : null;
}

/**
 * Nominatim is the fallback. Its usage policy asks for an identifying
 * User-Agent (lib/http.js sends ours) and at most one request a second, which
 * the gate below enforces — the place cache means it is rarely reached anyway.
 */
let nominatimBusy = Promise.resolve();
async function viaNominatim(lat, lng) {
  const gate = nominatimBusy.then(() => new Promise((r) => setTimeout(r, 1100)));
  nominatimBusy = gate;
  await gate;

  const url =
    "https://nominatim.openstreetmap.org/reverse?" +
    new URLSearchParams({ format: "jsonv2", lat: String(lat), lon: String(lng), zoom: "10" });
  const res = await fetchText(url, { headers: { Accept: "application/json" }, timeoutMs: 8000 });
  if (!res.ok || !res.text) return null;
  const d = JSON.parse(res.text);
  const a = d.address || {};
  const name = placeNameFrom(
    a.city || a.town || a.village || a.municipality || a.county || a.state || ""
  );
  const cca2 = String(a.country_code || "").toUpperCase();
  return name && cca2 ? { name, cca2, via: "nominatim" } : null;
}

async function reverseGeocode(lat, lng) {
  for (const lookup of [viaBigDataCloud, viaNominatim]) {
    try {
      const hit = await lookup(lat, lng);
      if (hit) return hit;
    } catch {
      /* try the next service */
    }
  }
  return null;
}

/**
 * What place is at this point, or under this name.
 *
 * Order matters: the gazetteer first (instant and authoritative for the towns
 * the map already knows), then the reverse geocoders for everywhere else.
 *
 * @param {{name?:string, ccn3?:string, lat?:number, lng?:number}} q
 * @returns {Promise<{name:string, ccn3:string, country:string, ll:[number,number],
 *                    via:string}|null>}
 */
export async function resolvePlace(q = {}) {
  const lat = Number(q.lat);
  const lng = Number(q.lng);
  const hasPoint = Number.isFinite(lat) && Number.isFinite(lng);

  if (q.name) {
    const known = resolveCity(q.name, q.ccn3 || undefined);
    if (known) {
      return {
        name: known.name,
        ccn3: known.ccn3,
        country: REGIONS[known.ccn3]?.name || "",
        ll: known.ll,
        via: "gazetteer",
      };
    }
    // A name we do not know still needs a country and a pin to hang on.
    if (q.ccn3 && REGIONS[q.ccn3]) {
      return {
        name: String(q.name),
        ccn3: q.ccn3,
        country: REGIONS[q.ccn3].name,
        ll: hasPoint ? [lng, lat] : REGIONS[q.ccn3].ll,
        via: "named",
      };
    }
  }

  if (!hasPoint) return null;

  const near = nearestKnownCity(lng, lat);
  if (near) {
    return {
      name: near.name,
      ccn3: near.ccn3,
      country: REGIONS[near.ccn3]?.name || "",
      ll: near.ll,
      via: "gazetteer",
    };
  }

  if (!config.liveCity.geocode) return null;

  // ~2 decimals is a few kilometres: fine enough to name a town, coarse enough
  // that panning around one does not miss the cache on every frame.
  const key = `${lat.toFixed(2)},${lng.toFixed(2)}`;
  const hit = placeCache.get(key);
  if (hit && Date.now() - hit.at < PLACE_TTL_MS) return hit.place;

  requests++;
  const found = await reverseGeocode(lat, lng);
  const ccn3 = found ? CCN3_BY_CCA2.get(found.cca2) : null;
  const place =
    found && ccn3
      ? { name: found.name, ccn3, country: REGIONS[ccn3].name, ll: [lng, lat], via: found.via }
      : null;
  remember(placeCache, key, { at: Date.now(), place });
  return place;
}

/* ------------------------------------------------------------- live news -- */

const GOOGLE_NEWS = "https://news.google.com/rss/search";

/**
 * Google indexes social posts alongside the press. A card has to name a
 * newsroom, and "facebook.com" is not one.
 */
const NOT_A_NEWSROOM = /(^|\.)(facebook|instagram|twitter|x|tiktok|reddit|linkedin|threads)\.com$/i;
const GDELT = "https://api.gdeltproject.org/api/v2/doc/doc";

/** "20260827T101500Z" → ISO 8601 */
function gdeltDate(s) {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(String(s || ""));
  return m ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z` : "";
}

/**
 * Google News, scoped to the place and read in the country's own edition — the
 * point of the map is the local press, so a German town is asked for in German.
 */
async function fromGoogleNews(place) {
  const region = REGIONS[place.ccn3];
  const cca2 = region?.cca2 || "US";
  const lang = langForCountry(cca2) || "en";
  const url =
    `${GOOGLE_NEWS}?` +
    new URLSearchParams({
      q: place.name,
      hl: `${lang}-${cca2}`,
      gl: cca2,
      ceid: `${cca2}:${lang}`,
    });

  const res = await fetchText(url, { timeoutMs: config.ingest.timeoutMs });
  if (!res.ok || !res.text) return [];
  const parsed = parseFeed(res.text, res.contentType);

  const out = [];
  for (const raw of parsed.items || []) {
    if (out.length >= config.liveCity.perPlace) break;
    const publisher = raw.sourceName || "";
    const title = splitTitle(raw.title, publisher);
    if (!title || !raw.link) continue;
    if (NOT_A_NEWSROOM.test(hostOfUrl(raw.sourceUrl || raw.link))) continue;
    out.push({
      title,
      link: raw.link,
      guid: raw.guid,
      summary: "",
      content: "",
      published: raw.published,
      image: "",
      categories: [],
      author: "",
      lang,
      src: publisher || "Google News",
      srcHome: raw.sourceUrl || "",
      sourceKey: region?.name || cca2,
      forceCcn3: place.ccn3,
      catalogLang: lang,
      feedLang: lang,
      feedUrl: url,
      plugin: "city-live",
      viaIndex: "Google News",
    });
  }
  return out;
}

/**
 * GDELT indexes worldwide coverage by full text, so it finds the English-language
 * reporting about a town that no local RSS feed would ever surface.
 */
async function fromGdelt(place) {
  const url =
    `${GDELT}?` +
    new URLSearchParams({
      query: `"${place.name}" sourcelang:eng`,
      mode: "ArtList",
      maxrecords: String(Math.min(25, config.liveCity.perPlace * 2)),
      format: "json",
      sort: "datedesc",
      timespan: "7d",
    });

  const res = await fetchText(url, { headers: { Accept: "application/json" }, timeoutMs: 12000 });
  if (!res.ok || !res.text) return [];
  let articles = [];
  try {
    articles = JSON.parse(res.text).articles || [];
  } catch {
    return [];
  }

  const region = REGIONS[place.ccn3];
  const out = [];
  for (const a of articles) {
    if (out.length >= config.liveCity.perPlace) break;
    if (!a.title || !a.url) continue;
    if (NOT_A_NEWSROOM.test(String(a.domain || ""))) continue;
    out.push({
      title: a.title,
      link: a.url,
      guid: a.url,
      summary: "",
      content: "",
      published: gdeltDate(a.seendate),
      image: a.socialimage || "",
      categories: [],
      author: "",
      lang: "en",
      src: a.domain || "GDELT",
      srcHome: a.domain ? `https://${a.domain}/` : "",
      sourceKey: region?.name || "",
      forceCcn3: place.ccn3,
      catalogLang: "en",
      feedLang: "en",
      feedUrl: url,
      plugin: "city-live",
      viaIndex: "GDELT",
    });
  }
  return out;
}

/**
 * The live local press of one place, cached and folded into the store so that
 * every other endpoint — the article panel, translation, search — sees these
 * stories exactly like ingested ones. The next ingest cycle rewrites the
 * country and they fall away on their own.
 *
 * @param {{name:string, ccn3:string, ll:[number,number]}} place
 * @returns {Promise<object[]>} store-shaped articles, newest first
 */
export async function liveNewsFor(place) {
  if (!config.plugins.liveCity || !place?.name || !REGIONS[place.ccn3]) return [];

  const key = `${place.ccn3}:${deaccent(place.name)}`;
  const hit = newsCache.get(key);
  if (hit && Date.now() - hit.at < NEWS_TTL_MS) {
    served++;
    return hit.articles;
  }

  requests++;
  const [google, gdelt] = await Promise.all([
    fromGoogleNews(place).catch(() => []),
    fromGdelt(place).catch(() => []),
  ]);

  const now = Date.now();
  // A small town publishes little, so the window is the generous one the ingest
  // uses for quiet countries. The card always states the real age.
  const maxAgeHours = Math.max(config.ingest.maxAgeHours, config.liveCity.maxAgeHours);
  const seen = new Set();
  const articles = [];

  for (const raw of [...google, ...gdelt]) {
    const a = normalizeItem(raw, now, { maxAgeHours });
    if (!a || seen.has(a.id)) continue;
    seen.add(a.id);
    // The query *was* the place, so that is where the story is pinned — the
    // gazetteer has no coordinates for a town it has never heard of.
    articles.push({ ...a, city: place.name, srcCity: a.srcCity || "", ll: place.ll });
  }

  articles.sort((x, y) => new Date(y.publishedAt) - new Date(x.publishedAt));
  remember(newsCache, key, { at: Date.now(), articles });
  if (articles.length) store.addArticles(place.ccn3, REGIONS[place.ccn3].name, articles);
  return articles;
}
