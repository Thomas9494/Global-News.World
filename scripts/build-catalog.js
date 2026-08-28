#!/usr/bin/env node
/**
 * Builds server/catalog/countries.json from the `world-countries` dataset.
 *
 * Every country gets a map region descriptor { name, ll, z, min } matching the
 * shape the frontend design expects. Zoom levels are derived from land area:
 *
 *   z   = 11.694 - 1.1036 * log10(area_km2)      (fitted to the design values)
 *   min = 0.8 * z                                (the design's focus threshold)
 *
 * The ten regions that were hand-tuned in the design keep their exact values so
 * the map behaves identically to the reference implementation.
 */
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const countries = JSON.parse(
  readFileSync(join(ROOT, "node_modules/world-countries/countries.json"), "utf8")
);

/** Hand-tuned values taken verbatim from the design. */
const DESIGN_REGIONS = {
  "756": { ll: [8.23, 46.8], z: 6.6, min: 5.2 },
  "764": { ll: [100.99, 15.87], z: 5.4, min: 4.2 },
  "276": { ll: [10.45, 51.16], z: 5.6, min: 4.6 },
  "392": { ll: [138.25, 36.2], z: 5.0, min: 4.0 },
  "840": { ll: [-98.58, 39.83], z: 4.0, min: 3.2 },
  "826": { ll: [-2.9, 54.0], z: 5.2, min: 4.3 },
  "076": { ll: [-51.93, -14.24], z: 4.0, min: 3.2 },
  "250": { ll: [2.21, 46.23], z: 5.5, min: 4.5 },
  "528": { ll: [5.29, 52.13], z: 6.8, min: 5.4 },
  "344": { ll: [114.17, 22.3], z: 9.8, min: 7.8 },
};

/** sources.json keys that are not a single country. */
const GROUP_KEYS = new Set(["Global", "EU", "Africa (regional)", "Latin America (regional)"]);

/** sources.json / feed spellings that differ from world-countries common names. */
const NAME_ALIASES = {
  "United States": "United States",
  Czechia: "Czechia",
  "South Korea": "South Korea",
  Turkey: "Türkiye",
  "Turkiye": "Türkiye",
  Russia: "Russia",
  "United Arab Emirates": "United Arab Emirates",
  "Hong Kong": "Hong Kong",
};

/**
 * Bounding box and mainland centre, read from the country outlines that ship
 * with world-countries.
 *
 * The box is what lets the map answer "which country am I looking at?" — asking
 * which centroid is nearest gets it wrong for any city near a border, because a
 * small neighbour's centre is often closer than your own country's.
 *
 * The centre comes from the largest landmass, so France is not dragged into the
 * Atlantic by its overseas départements.
 */
function geometryFor(cca3) {
  const path = join(ROOT, `node_modules/world-countries/data/${cca3.toLowerCase()}.geo.json`);
  if (!existsSync(path)) return null;

  let doc;
  try {
    doc = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }

  /** @type {number[][][]} every outer ring in the country */
  const rings = [];
  for (const feature of doc.features || []) {
    const g = feature.geometry;
    if (!g) continue;
    if (g.type === "Polygon") rings.push(g.coordinates[0]);
    else if (g.type === "MultiPolygon") for (const poly of g.coordinates) rings.push(poly[0]);
  }
  if (!rings.length) return null;

  let minLng = 180, minLat = 90, maxLng = -180, maxLat = -90;
  let biggest = null;
  let biggestArea = -1;

  for (const ring of rings) {
    // shoelace area, in degrees² — only ever compared against itself
    let area = 0;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      area += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
    }
    area = Math.abs(area / 2);
    if (area > biggestArea) {
      biggestArea = area;
      biggest = ring;
    }
    for (const [lng, lat] of ring) {
      if (lng < minLng) minLng = lng;
      if (lng > maxLng) maxLng = lng;
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
    }
  }

  // centroid of the largest ring
  let cx = 0, cy = 0, a2 = 0;
  for (let i = 0, j = biggest.length - 1; i < biggest.length; j = i++) {
    const f = biggest[j][0] * biggest[i][1] - biggest[i][0] * biggest[j][1];
    a2 += f;
    cx += (biggest[j][0] + biggest[i][0]) * f;
    cy += (biggest[j][1] + biggest[i][1]) * f;
  }
  const centre = a2 ? [cx / (3 * a2), cy / (3 * a2)] : null;

  const round2 = (n) => Number(n.toFixed(2));
  const full = [minLng, minLat, maxLng, maxLat];

  // A country with territory either side of the antimeridian — the United
  // States with the Aleutians, Russia with Chukotka, New Zealand, Fiji — gets a
  // box spanning the whole globe, which would match every point on earth. Fall
  // back to the box around its main landmass, which is the part a reader is
  // almost certainly looking at.
  let box = full;
  if (maxLng - minLng > 180) {
    let a = 180, b = 90, c2 = -180, d = -90;
    for (const [lng, lat] of biggest) {
      if (lng < a) a = lng;
      if (lng > c2) c2 = lng;
      if (lat < b) b = lat;
      if (lat > d) d = lat;
    }
    box = c2 - a > 180 ? null : [a, b, c2, d];
  }

  return {
    bbox: box ? box.map(round2) : null,
    fullBbox: full.map(round2),
    centre: centre ? centre.map(round2) : null,
  };
}

const round1 = (n) => Math.round(n * 10) / 10;
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

function zoomForArea(area) {
  if (!area || area <= 0) return 8.5;
  return clamp(round1(11.694 - 1.1036 * Math.log10(area)), 2.8, 10.5);
}

/**
 * ccTLDs that are sold as generic domains and therefore say nothing about
 * where a publisher sits. ".io" is not a British Indian Ocean Territory paper.
 */
const GENERIC_TLDS = new Set([
  "io", "tv", "me", "ai", "co", "ly", "fm", "to", "cc", "ws", "gg", "sh", "ac",
  "nu", "tk", "ml", "ga", "cf", "st", "la", "am", "dj", "cd", "sc", "vc", "ag",
  "bz", "pw", "gd", "cx", "mu", "so", "tt", "as", "im", ""
]);

const regions = {};
const byName = {};
const tldToCcn3 = {};

let withGeometry = 0;
for (const c of countries) {
  const id = c.ccn3;
  if (!id) continue;
  const name = c.name.common;
  const design = DESIGN_REGIONS[id];
  const geo = geometryFor(c.cca3);
  if (geo) withGeometry++;
  const ll = design
    ? design.ll
    : geo?.centre
      ? geo.centre
      : c.latlng && c.latlng.length === 2
        ? [round1(c.latlng[1] * 100) / 100, round1(c.latlng[0] * 100) / 100]
        : null;
  if (!ll) continue;
  const z = design ? design.z : zoomForArea(c.area);
  regions[id] = {
    name,
    cca2: c.cca2,
    ll: [Number(ll[0].toFixed(2)), Number(ll[1].toFixed(2))],
    bbox: geo?.bbox || null,
    z,
    min: design ? design.min : round1(0.8 * z),
    region: c.region || "",
    subregion: c.subregion || "",
    languages: Object.values(c.languages || {}),
    demonyms: [...new Set([c.demonyms?.eng?.m, c.demonyms?.eng?.f].filter(Boolean))],
    area: c.area || 0,
  };
  for (const tld of c.tld || []) {
    const t = tld.replace(/^\./, "").toLowerCase();
    if (t && !GENERIC_TLDS.has(t) && !tldToCcn3[t]) tldToCcn3[t] = id;
  }
  byName[name.toLowerCase()] = id;
  for (const alt of [c.name.official, ...(c.altSpellings || [])]) {
    if (alt && alt.length > 3) byName[alt.toLowerCase()] ??= id;
  }
  for (const t of Object.values(c.translations || {})) {
    if (t?.common && t.common.length > 3) byName[t.common.toLowerCase()] ??= id;
  }
}

const sources = JSON.parse(readFileSync(join(ROOT, "data/sources.json"), "utf8"));
const sourceKeyToCcn3 = {};
const unresolved = [];
for (const key of Object.keys(sources)) {
  if (GROUP_KEYS.has(key)) continue;
  const id = byName[(NAME_ALIASES[key] || key).toLowerCase()];
  if (id) sourceKeyToCcn3[key] = id;
  else unresolved.push(key);
}

const out = {
  // deliberately no timestamp: the output is committed, and a changing
  // timestamp would make every rebuild look like a change
  regions,
  byName,
  tldToCcn3,
  sourceKeyToCcn3,
  groupKeys: [...GROUP_KEYS],
};
writeFileSync(join(ROOT, "server/catalog/countries.json"), JSON.stringify(out, null, 0) + "\n");

console.log(`regions: ${Object.keys(regions).length}`);
console.log(`country tlds: ${Object.keys(tldToCcn3).length}`);
console.log(`outlines read: ${withGeometry}`);
console.log(`source keys mapped: ${Object.keys(sourceKeyToCcn3).length}`);
if (unresolved.length) console.log(`UNRESOLVED source keys: ${unresolved.join(", ")}`);
