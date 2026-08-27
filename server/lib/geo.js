import { readFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "../config.js";

/**
 * Place resolution for the map layer.
 *
 *  - `detectCity`   picks the city dot an article is pinned to (design: `a.city` / `a.ll`).
 *  - `routeCountry` assigns an article from a worldwide wire (Reuters, BBC World,
 *    allAfrica, EFE América …) to the country it is actually about, so those
 *    feeds enrich the map instead of piling up in one bucket.
 *
 * Both work on plain text with word-boundary matching. Routing is deliberately
 * conservative: an ambiguous name alone is never enough.
 */

const catalog = JSON.parse(readFileSync(join(config.paths.catalog, "countries.json"), "utf8"));
const gazetteer = JSON.parse(readFileSync(join(config.paths.data, "cities.json"), "utf8"));
const outletCities = JSON.parse(readFileSync(join(config.paths.data, "outlet-cities.json"), "utf8"));

export const REGIONS = catalog.regions;
export const COUNTRY_BY_NAME = catalog.byName;
export const SOURCE_KEY_TO_CCN3 = catalog.sourceKeyToCcn3;
export const TLD_TO_CCN3 = catalog.tldToCcn3 || {};

/**
 * Which country a publisher sits in, judged by its domain.
 * A ".co.ke" masthead is Kenyan; ".com" says nothing and returns null.
 * Generic-use ccTLDs (.io, .tv, .me …) are excluded when the catalog is built.
 */
export function ccn3ForHostname(hostname) {
  const host = String(hostname || "")
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .split("/")[0]
    .split(":")[0];
  const tld = host.split(".").pop();
  return TLD_TO_CCN3[tld] || null;
}

/** [name, ccn3, lng, lat, isCapital] → objects, indexed by country. */
export const CITIES = gazetteer.cities.map(([name, ccn3, lng, lat, capital]) => ({
  name,
  ccn3,
  ll: [lng, lat],
  capital: !!capital,
}));

/**
 * Native and historic spellings ("Luzern" → "Lucerne", "Київ" → "Kyiv").
 * Feeds publish in their own language, the map labels stay consistent.
 */
const CITY_ALIASES = gazetteer.aliases || {};
const cityByName = new Map(CITIES.map((c) => [c.name.toLowerCase(), c]));

/** Every string that should resolve to a given city, per country. */
const citiesByCountry = new Map();
for (const c of CITIES) {
  if (!citiesByCountry.has(c.ccn3)) citiesByCountry.set(c.ccn3, []);
  citiesByCountry.get(c.ccn3).push({ ...c, match: c.name });
}
for (const [alias, canonical] of Object.entries(CITY_ALIASES)) {
  const city = cityByName.get(canonical.toLowerCase());
  if (!city) continue;
  citiesByCountry.get(city.ccn3)?.push({ ...city, match: alias });
}

/** Flat list of every city string (canonical + alias) for worldwide routing. */
const ALL_CITY_MATCHES = [...citiesByCountry.values()].flat();

/**
 * Which city a newsroom sits in.
 *
 * Zooming the map onto a city has to show that city's own press, so every
 * article carries the home city of the outlet that published it. Two ways to
 * know it: the curated overrides in data/outlet-cities.json ("NZZ" → Zurich),
 * and the outlet's own name, which for local papers usually says it outright
 * ("Luzerner Zeitung", "Toronto Star", "Bangkok Post").
 */
const OUTLET_CITY_OVERRIDES = Object.fromEntries(
  Object.entries(outletCities).filter(([k]) => !k.startsWith("_"))
);

const outletCityCache = new Map();

export function outletCity(outletName, ccn3) {
  if (!outletName || !ccn3) return "";
  const key = ccn3 + "\u0000" + outletName;
  if (outletCityCache.has(key)) return outletCityCache.get(key);

  const name = deaccent(outletName);
  let city = "";

  // 1. curated override, longest match wins ("the news international" over "the news")
  const overrides = OUTLET_CITY_OVERRIDES[ccn3];
  if (overrides) {
    let best = "";
    for (const [needle, target] of Object.entries(overrides)) {
      if (needle.length > best.length && name.includes(deaccent(needle))) {
        best = needle;
        city = target;
      }
    }
  }

  // 2. the outlet's own name — "Luzerner Zeitung" contains "Luzern"
  if (!city) {
    let best = null;
    for (const c of citiesByCountry.get(ccn3) || []) {
      const m = deaccent(c.match);
      if (m.length < 3) continue;
      // the place has to start a word, so "Zuger Zeitung" matches Zug but
      // "Bergen op Zoom" does not lend its name to an unrelated outlet
      if (!new RegExp(`(^|[^\p{L}])${escapeRe(m)}`, "u").test(name)) continue;
      if (!best || m.length > deaccent(best.match).length) best = c;
    }
    city = best ? best.name : "";
  }

  // only accept a city we can actually put on the map
  if (city && !cityByName.has(city.toLowerCase())) city = "";
  outletCityCache.set(key, city);
  return city;
}

/**
 * Resolves any spelling of a place — canonical name or alias — to the gazetteer
 * entry, optionally restricted to one country.
 * @returns {{name:string, ccn3:string, ll:[number,number], capital:boolean}|null}
 */
export function resolveCity(name, ccn3) {
  const key = String(name || "").trim().toLowerCase();
  if (!key) return null;
  const direct = cityByName.get(key);
  const viaAlias = !direct && CITY_ALIASES[key] ? cityByName.get(CITY_ALIASES[key].toLowerCase()) : null;
  let hit = direct || viaAlias;

  // Same name, different country: several places are called Victoria, Hamilton
  // or St. John's. The gazetteer disambiguates them ("Victoria BC"), so when the
  // plain name belongs elsewhere, look for the qualified entry in this country.
  if (ccn3 && (!hit || hit.ccn3 !== ccn3)) {
    const local = (citiesByCountry.get(ccn3) || []).find(
      (c) => c.ccn3 === ccn3 && deaccent(c.name).startsWith(deaccent(key) + " ")
    );
    if (local) return cityByName.get(local.name.toLowerCase()) || local;
  }
  if (!hit) return null;
  if (ccn3 && hit.ccn3 !== ccn3) return null;
  return hit;
}

/** Coordinates of a named city inside a country. */
export function cityLocation(name, ccn3) {
  const c = cityByName.get(String(name || "").toLowerCase());
  return c && (!ccn3 || c.ccn3 === ccn3) ? c.ll : null;
}

/** Every city that a set of articles is anchored to, for the client's zoom logic. */
export function citiesForArticles(articles) {
  const seen = new Map();
  for (const a of articles) {
    for (const name of [a.city, a.srcCity]) {
      if (!name || seen.has(name)) continue;
      const c = cityByName.get(name.toLowerCase());
      if (c) seen.set(name, { name: c.name, ccn3: c.ccn3, ll: c.ll, capital: c.capital });
    }
  }
  return [...seen.values()];
}

/**
 * Country names that collide with common words, personal names or US states.
 * They only count towards routing when a second signal agrees.
 */
const AMBIGUOUS = new Set([
  "georgia", "jordan", "chad", "niger", "mali", "chile", "turkey", "china sea",
  "guinea", "india n", "malta", "monaco", "panama", "cuba", "peru", "eswatini",
  "dominica", "grenada", "palau", "nauru", "niue", "tonga", "samoa", "fiji",
]);

const deaccent = (s) =>
  String(s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");

const wordSet = (text) => new Set(deaccent(text).match(/[\p{L}\p{N}]+/gu) || []);

/**
 * Matches a possibly multi-word place name against normalised text.
 * Non-Latin scripts allow a short suffix so inflected forms still match
 * ("Київ" → "Києві", "Москва" → "Москве").
 */
function mentions(haystack, name) {
  const n = deaccent(name);
  if (n.length < 4) return false;
  const inflected = /[^\p{Script=Latin}\p{N}\s\p{P}]/u.test(n) ? "\\p{L}{0,3}" : "";
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRe(n)}${inflected}([^\\p{L}\\p{N}]|$)`, "u").test(
    haystack
  );
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Finds the city an article is about, restricted to one country.
 * @returns {{city:string, ll:[number,number]}|null}
 */
export function detectCity(text, ccn3) {
  const list = citiesByCountry.get(ccn3);
  if (!list || !text) return null;
  const hay = deaccent(text);
  let best = null;
  for (const c of list) {
    if (!mentions(hay, c.match)) continue;
    // Prefer the longest match: "New York" beats "York", "Mexico City" beats "Mexico".
    if (!best || c.match.length > best.match.length) best = c;
  }
  return best ? { city: best.name, ll: best.ll } : null;
}

/** Country centroid, used when no city could be identified. */
export function countryCenter(ccn3) {
  return REGIONS[ccn3]?.ll || null;
}

/**
 * Assigns free-floating wire copy to a country.
 * @param {string} text  headline + summary
 * @param {string[]} [exclude] ccn3 codes to ignore (e.g. the wire's home country)
 * @returns {{ccn3:string, score:number, via:string}|null}
 */
export function routeCountry(text, exclude = []) {
  if (!text) return null;
  const hay = deaccent(text);
  const words = wordSet(text);
  const scores = new Map();
  const via = new Map();

  const add = (ccn3, points, label) => {
    if (!ccn3 || exclude.includes(ccn3)) return;
    scores.set(ccn3, (scores.get(ccn3) || 0) + points);
    if (!via.has(ccn3) || points > 2) via.set(ccn3, label);
  };

  // Country names, official names, translations and alt spellings.
  for (const [name, ccn3] of Object.entries(COUNTRY_BY_NAME)) {
    if (name.length < 4 || !words.has(deaccent(name).split(" ")[0])) continue;
    if (!mentions(hay, name)) continue;
    add(ccn3, AMBIGUOUS.has(name) ? 1 : 3, name);
  }

  // Demonyms ("German chancellor", "Kenyan police").
  for (const [ccn3, r] of Object.entries(REGIONS)) {
    for (const d of r.demonyms || []) {
      if (d.length >= 5 && mentions(hay, d)) add(ccn3, 2, d);
    }
  }

  // Cities (including native spellings) — capitals weigh more than secondary cities.
  for (const c of ALL_CITY_MATCHES) {
    if (!mentions(hay, c.match)) continue;
    add(c.ccn3, c.capital ? 3 : 2, c.name);
  }

  let best = null;
  let bestScore = 0;
  let runnerUp = 0;
  for (const [ccn3, score] of scores) {
    if (score > bestScore) {
      runnerUp = bestScore;
      bestScore = score;
      best = ccn3;
    } else if (score > runnerUp) {
      runnerUp = score;
    }
  }
  // Require a real signal and a clear winner, otherwise leave the article out.
  if (!best || bestScore < 2 || bestScore === runnerUp) return null;
  return { ccn3: best, score: bestScore, via: via.get(best) || "" };
}

/**
 * Resolves a source group to a ccn3 code. Curated keys from data/sources.json
 * are looked up first; anything else that names a country (plugins hand us
 * country names directly) resolves through the country index. Group keys such
 * as "Global" or "EU" deliberately return null — their articles are routed
 * per story instead.
 */
export function ccn3ForSourceKey(key) {
  if (!key) return null;
  if (SOURCE_KEY_TO_CCN3[key]) return SOURCE_KEY_TO_CCN3[key];
  if (isGroupKey(key)) return null;
  return COUNTRY_BY_NAME[String(key).toLowerCase()] || null;
}

export function isGroupKey(key) {
  return catalog.groupKeys.includes(key);
}
