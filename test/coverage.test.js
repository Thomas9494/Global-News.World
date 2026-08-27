import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { deflateRawSync, crc32 } from "node:zlib";

import { config } from "../server/config.js";
import {
  REGIONS,
  CITIES,
  ccn3ForHostname,
  outletCity,
  cityLocation,
  citiesForArticles,
  detectCity,
  resolveCity,
} from "../server/lib/geo.js";
import { splitTitle } from "../server/plugins/googlenews.js";
import { parseOpml } from "../server/plugins/opml.js";
import { PLUGINS, pluginInfo } from "../server/plugins/index.js";
import { normalizeItem, capFairlyByCity } from "../server/ingest.js";
import { loadCitySources, cityTargets } from "../server/plugins/citypress.js";
import { readWorkbook, rowsToObjects } from "../scripts/lib/xlsx.mjs";

const countries = JSON.parse(
  readFileSync(join(config.paths.data, "../node_modules/world-countries/countries.json"), "utf8")
);
const gazetteer = JSON.parse(readFileSync(join(config.paths.data, "cities.json"), "utf8"));

/* ---------------------------------------------------- worldwide coverage -- */

test("every country on earth has a map region", () => {
  const withCcn3 = countries.filter((c) => c.ccn3);
  const missing = withCcn3.filter((c) => !REGIONS[c.ccn3]);
  assert.equal(missing.length, 0, `missing regions: ${missing.map((c) => c.name.common).join(", ")}`);
  assert.ok(Object.keys(REGIONS).length >= 245);
});

test("every region has usable coordinates and zoom levels", () => {
  for (const [ccn3, r] of Object.entries(REGIONS)) {
    assert.ok(Array.isArray(r.ll) && r.ll.length === 2, `${r.name} has no centre`);
    const [lng, lat] = r.ll;
    assert.ok(lng >= -180 && lng <= 180, `${r.name} longitude out of range: ${lng}`);
    assert.ok(lat >= -90 && lat <= 90, `${r.name} latitude out of range: ${lat}`);
    assert.ok(r.z > 1 && r.z <= 11, `${r.name} zoom out of range: ${r.z}`);
    assert.ok(r.min < r.z, `${r.name} focus threshold must be below its zoom`);
    assert.ok(r.cca2 || ccn3, "region keeps its alpha-2 code");
  }
});

test("every UN member state has its capital in the gazetteer", () => {
  const names = new Set(CITIES.map((c) => c.name.toLowerCase()));
  const aliases = new Set(Object.keys(gazetteer.aliases));
  const missing = countries
    .filter((c) => c.unMember && c.capital?.[0])
    .filter((c) => !names.has(c.capital[0].toLowerCase()) && !aliases.has(c.capital[0].toLowerCase()));
  assert.equal(missing.length, 0, `capitals missing: ${missing.map((c) => c.capital[0]).join(", ")}`);
});

test("every UN member state has at least one place on the map", () => {
  const byCountry = new Set(CITIES.map((c) => c.ccn3));
  const missing = countries.filter((c) => c.unMember && !byCountry.has(c.ccn3));
  assert.equal(missing.length, 0, `countries with no place: ${missing.map((c) => c.name.common).join(", ")}`);
});

test("capitals are flagged and locatable", () => {
  const capitals = CITIES.filter((c) => c.capital);
  assert.ok(capitals.length >= 190, `only ${capitals.length} capitals`);
  for (const c of capitals.slice(0, 40)) {
    assert.deepEqual(cityLocation(c.name, c.ccn3), c.ll);
  }
});

test("city aliases all point at a real place", () => {
  const names = new Set(CITIES.map((c) => c.name.toLowerCase()));
  for (const [alias, canonical] of Object.entries(gazetteer.aliases)) {
    assert.ok(names.has(canonical.toLowerCase()), `alias "${alias}" points at unknown city "${canonical}"`);
  }
});

test("native capital spellings resolve", () => {
  assert.equal(detectCity("Новости из Минска сегодня", "112")?.city, "Minsk");
  assert.equal(detectCity("أخبار المنامة اليوم", "048")?.city, "Manama");
  assert.equal(detectCity("Nouvelles d'Alger", "012")?.city, "Algiers");
  assert.equal(detectCity("Nyheter fra Ulan Bator", "496")?.city, "Ulaanbaatar");
});

/* ------------------------------------------------------------ localities -- */

test("a publisher's country domain identifies where it sits", () => {
  assert.equal(ccn3ForHostname("https://www.the-star.co.ke"), "404");
  assert.equal(ccn3ForHostname("https://www.nzz.ch"), "756");
  assert.equal(ccn3ForHostname("news.mn"), "496");
  // generic domains say nothing
  assert.equal(ccn3ForHostname("https://apnews.com"), null);
  assert.equal(ccn3ForHostname("https://example.io"), null);
  assert.equal(ccn3ForHostname("https://blog.me"), null);
  assert.equal(ccn3ForHostname(""), null);
});

test("newsrooms resolve to the city they sit in", () => {
  assert.equal(outletCity("NZZ – Aktuell", "756"), "Zurich");
  assert.equal(outletCity("Luzerner Zeitung", "756"), "Lucerne");
  assert.equal(outletCity("Zentralplus (Luzern/Zug)", "756"), "Lucerne");
  assert.equal(outletCity("Basler Zeitung", "756"), "Basel");
  assert.equal(outletCity("Toronto Star", "124"), "Toronto");
  assert.equal(outletCity("Bangkok Post", "764"), "Bangkok");
  assert.equal(outletCity("Süddeutsche Zeitung", "276"), "Munich");
  // the same masthead name means different cities in different countries
  assert.equal(outletCity("The Nation - Top Stories", "586"), "Lahore");
  assert.equal(outletCity("Latest Nigeria News", "566"), "");
  assert.equal(outletCity("Some Unknown Blog", "756"), "");
});

test("an article carries its newsroom's city, and is pinned there", () => {
  const a = normalizeItem({
    title: "Stadtrat beschliesst neues Budget",
    link: "https://www.luzernerzeitung.ch/a/1",
    summary: "Der Stadtrat hat entschieden.",
    published: new Date().toISOString(),
    src: "Luzerner Zeitung",
    sourceKey: "Switzerland",
    catalogLang: "de",
    plugin: "rss",
  });
  assert.equal(a.srcCity, "Lucerne");
  assert.deepEqual(a.ll, cityLocation("Lucerne", "756"));
  assert.equal(a.city, "", "no city named in the headline");
});

test("a place named in the headline beats the newsroom's own city", () => {
  const a = normalizeItem({
    title: "Grossbrand in Zürich",
    link: "https://www.luzernerzeitung.ch/a/2",
    summary: "In Zürich brannte es.",
    published: new Date().toISOString(),
    src: "Luzerner Zeitung",
    sourceKey: "Switzerland",
    catalogLang: "de",
    plugin: "rss",
  });
  assert.equal(a.city, "Zurich");
  assert.equal(a.srcCity, "Lucerne");
});

test("a place-scoped plugin can supply the city", () => {
  const a = normalizeItem({
    title: "New bus corridor approved",
    link: "https://example.rw/a/1",
    summary: "",
    published: new Date().toISOString(),
    src: "The New Times",
    sourceKey: "Rwanda",
    forceCcn3: "646",
    forceCity: "Kigali",
    plugin: "google-news",
  });
  assert.equal(a.city, "Kigali");
  assert.deepEqual(a.ll, cityLocation("Kigali", "646"));
});

test("citiesForArticles lists every place the map can focus", () => {
  const cities = citiesForArticles([
    { city: "Zurich", srcCity: "Zurich" },
    { city: "", srcCity: "Lucerne" },
    { city: "Bangkok", srcCity: "" },
    { city: "Nowhere-at-all", srcCity: "" },
  ]);
  const names = cities.map((c) => c.name).sort();
  assert.deepEqual(names, ["Bangkok", "Lucerne", "Zurich"]);
  for (const c of cities) assert.ok(Array.isArray(c.ll) && c.ccn3);
});

/* --------------------------------------------------------------- plugins -- */

test("the registry exposes the open plugins and their state", () => {
  const ids = PLUGINS.map((p) => p.id);
  assert.deepEqual(ids, ["rss", "city-press", "opml", "google-news", "gdelt", "newsapi", "gnews"]);
  const info = pluginInfo();
  // the key-less ones carry the map by default
  assert.equal(info.find((p) => p.id === "rss").enabled, true);
  assert.equal(info.find((p) => p.id === "google-news").enabled, true);
  assert.equal(info.find((p) => p.id === "opml").enabled, true);
  assert.equal(info.find((p) => p.id === "city-press").enabled, true);
  // the keyed ones stay off until configured
  assert.equal(info.find((p) => p.id === "newsapi").enabled, false);
  assert.equal(info.find((p) => p.id === "gnews").enabled, false);
});

test("every plugin honours the same contract", () => {
  for (const p of PLUGINS) {
    assert.equal(typeof p.id, "string");
    assert.equal(typeof p.label, "string");
    assert.equal(typeof p.enabled, "function");
    assert.equal(typeof p.collect, "function");
  }
});

test("Google News headlines lose the publisher suffix", () => {
  assert.equal(splitTitle("Mombasa braces for rains - the-star.co.ke", "the-star.co.ke"), "Mombasa braces for rains");
  assert.equal(splitTitle("A headline - The Citizen", "The Citizen"), "A headline");
  // a dash that is part of the headline survives
  assert.equal(splitTitle("Budget 2026 - what changes", "The Citizen"), "Budget 2026 - what changes");
  assert.equal(splitTitle("No publisher given", ""), "No publisher given");
});

test("OPML import reads groups as countries", () => {
  const xml = `<?xml version="1.0"?>
    <opml version="2.0"><head><title>My reader</title></head><body>
      <outline text="Kenya">
        <outline type="rss" text="The Standard" xmlUrl="https://standardmedia.co.ke/rss" />
        <outline type="rss" text="Nation" xmlUrl="https://nation.africa/rss" language="en" />
      </outline>
      <outline text="Japan">
        <outline type="rss" text="NHK" xmlUrl="https://nhk.example/rss" />
      </outline>
      <outline type="rss" text="Loose feed" xmlUrl="https://loose.example/rss" country="Brazil" />
    </body></opml>`;
  const feeds = parseOpml(xml);
  assert.equal(feeds.length, 4);
  assert.deepEqual(
    feeds.map((f) => [f.title, f.country]),
    [
      ["The Standard", "Kenya"],
      ["Nation", "Kenya"],
      ["NHK", "Japan"],
      ["Loose feed", "Brazil"],
    ]
  );
  assert.equal(feeds[1].lang, "en");
  assert.deepEqual(parseOpml("not xml at all"), []);
});

/* ---------------------------------------------------------- source catalog */

test("the curated catalog is well formed", () => {
  const sources = JSON.parse(readFileSync(join(config.paths.data, "sources.json"), "utf8"));
  let outlets = 0;
  for (const [country, list] of Object.entries(sources)) {
    assert.ok(Array.isArray(list) && list.length, `${country} has no outlets`);
    for (const o of list) {
      outlets++;
      assert.equal(typeof o.m, "string");
      assert.ok(o.m.length, `${country} has an outlet with no name`);
      assert.equal(typeof o.r, "string");
      assert.equal(typeof o.w, "string");
      if (o.r) assert.ok(/^https?:\/\/|\s/.test(o.r), `${o.m} has an odd feed url: ${o.r}`);
    }
  }
  assert.ok(outlets >= 370, `only ${outlets} outlets`);
});

test("outlet-city overrides point at cities we can place", () => {
  const overrides = JSON.parse(readFileSync(join(config.paths.data, "outlet-cities.json"), "utf8"));
  const names = new Set(CITIES.map((c) => c.name.toLowerCase()));
  for (const [ccn3, map] of Object.entries(overrides)) {
    if (ccn3.startsWith("_")) continue;
    assert.ok(REGIONS[ccn3], `unknown country code ${ccn3}`);
    for (const city of Object.values(map)) {
      assert.ok(names.has(city.toLowerCase()), `${ccn3} maps an outlet to unknown city "${city}"`);
    }
  }
});

/* ------------------------------------------------------------ city press -- */

test("the city catalog is well formed and every city is placeable", () => {
  const catalog = loadCitySources();
  const countries = Object.keys(catalog);
  assert.ok(countries.length >= 150, `only ${countries.length} countries in the city catalog`);

  const byName = new Map(Object.entries(REGIONS).map(([ccn3, r]) => [r.name, ccn3]));
  let outlets = 0;
  let cities = 0;
  for (const [country, places] of Object.entries(catalog)) {
    const ccn3 = byName.get(country);
    assert.ok(ccn3, `city catalog names an unknown country: ${country}`);
    for (const [city, list] of Object.entries(places)) {
      if (city !== "_country") {
        cities++;
        assert.ok(resolveCity(city, ccn3), `${country}/${city} is not in data/cities.json`);
      }
      assert.ok(Array.isArray(list) && list.length, `${country}/${city} has no outlets`);
      for (const o of list) {
        outlets++;
        assert.ok(o.m, `${country}/${city} has an outlet with no name`);
        assert.match(o.r, /^https?:\/\//, `${o.m} has no usable feed url`);
      }
    }
  }
  assert.ok(outlets >= 500, `only ${outlets} city outlets`);
  assert.ok(cities >= 250, `only ${cities} cities`);
});

test("cityTargets flattens the catalog one feed at a time", () => {
  const targets = cityTargets({
    Switzerland: {
      Zurich: [{ m: "NZZ", l: "DE", r: "https://nzz.example/rss", w: "https://nzz.example" }],
      _country: [{ m: "SRF", l: "DE", r: "https://srf.example/rss", w: "" }],
    },
  });
  assert.equal(targets.length, 2);
  assert.deepEqual(
    targets.map((t) => [t.country, t.city, t.outlet.m]),
    [
      ["Switzerland", "Zurich", "NZZ"],
      ["Switzerland", "", "SRF"],
    ]
  );
});

test("a city outlet pins its stories to its own town", () => {
  const a = normalizeItem({
    title: "Neues Budget beschlossen",
    link: "https://example.ch/a/1",
    summary: "",
    published: new Date().toISOString(),
    src: "Bündner Tagblatt",
    sourceKey: "Switzerland",
    forceCity: "Chur",
    plugin: "city-press",
  });
  assert.equal(a.srcCity, "Chur");
  assert.deepEqual(a.ll, cityLocation("Chur", "756"));
});

/* ------------------------------------------------- fair share per city --- */

const article = (id, city, minutesAgo) => ({
  id,
  city,
  srcCity: city,
  publishedAt: new Date(Date.now() - minutesAgo * 60000).toISOString(),
});

test("capping a country leaves room for its smaller towns", () => {
  // a loud capital and two quiet towns
  const loud = Array.from({ length: 40 }, (_, i) => article(`z${i}`, "Zurich", i));
  const quiet = [article("l1", "Lucerne", 100), article("l2", "Lucerne", 200), article("c1", "Chur", 300)];
  const capped = capFairlyByCity([...loud, ...quiet], 10);

  assert.equal(capped.length, 10);
  const places = capped.map((a) => a.city);
  assert.ok(places.includes("Lucerne"), "Lucerne must survive the cap");
  assert.ok(places.includes("Chur"), "Chur must survive the cap");
  assert.ok(places.filter((p) => p === "Zurich").length < 10, "the capital cannot take every slot");
  // still newest first
  for (let i = 1; i < capped.length; i++) {
    assert.ok(new Date(capped[i - 1].publishedAt) >= new Date(capped[i].publishedAt));
  }
});

test("capping is a no-op when a country is under its cap", () => {
  const few = [article("a", "Zurich", 1), article("b", "Bern", 2)];
  assert.deepEqual(capFairlyByCity(few, 10), few);
});

/* ------------------------------------------------------- spreadsheet io -- */

test("the xlsx reader unzips and reads a sheet", () => {
  // a minimal workbook built in memory, so the test needs no fixture file
  const files = {
    "xl/workbook.xml": `<workbook><sheets><sheet name="Feeds" r:id="rId1"/></sheets></workbook>`,
    "xl/_rels/workbook.xml.rels": `<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>`,
    "xl/sharedStrings.xml": `<sst><si><t>Land</t></si><si><t>Stadt</t></si><si><t>Schweiz</t></si><si><t>Z&#252;rich</t></si></sst>`,
    "xl/worksheets/sheet1.xml":
      `<worksheet><sheetData>` +
      `<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>` +
      `<row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2" t="s"><v>3</v></c></row>` +
      `</sheetData></worksheet>`,
  };
  const zip = buildZip(files);
  const path = join(tmpdir(), `gn-test-${process.pid}.xlsx`);
  writeFileSync(path, zip);
  try {
    const book = readWorkbook(path);
    assert.deepEqual(book.Feeds, [
      ["Land", "Stadt"],
      ["Schweiz", "Zürich"],
    ]);
    assert.deepEqual(rowsToObjects(book.Feeds), [{ Land: "Schweiz", Stadt: "Zürich" }]);
  } finally {
    unlinkSync(path);
  }
});

/**
 * Builds a tiny ZIP in memory (stored + deflated entries), so the reader can be
 * tested without checking a binary fixture into the repository.
 */
function buildZip(files) {
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const [name, text] of Object.entries(files)) {
    const raw = Buffer.from(text, "utf8");
    const data = deflateRawSync(raw);
    const nameBuf = Buffer.from(name, "utf8");
    const sum = crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt32LE(sum, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    chunks.push(local, nameBuf, data);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(8, 10);
    cd.writeUInt32LE(sum, 16);
    cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(raw.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);

    offset += local.length + nameBuf.length + data.length;
  }

  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(Object.keys(files).length, 8);
  eocd.writeUInt16LE(Object.keys(files).length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);

  return Buffer.concat([...chunks, cdBuf, eocd]);
}
