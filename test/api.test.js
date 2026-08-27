import test, { before, after } from "node:test";
import assert from "node:assert/strict";

import { createApp } from "../server/app.js";
import * as store from "../server/lib/store.js";
import { normalizeItem } from "../server/ingest.js";

/**
 * Boots the real app on an ephemeral port against a store seeded with a few
 * articles, then exercises every endpoint the frontend depends on.
 */
let base;
let server;

const raw = (over = {}) => ({
  title: "Bundesrat einigt sich auf Kompromiss mit der EU",
  link: "https://demo.example/ch/1",
  summary: "Nach monatelangen Verhandlungen liegt in Bern ein Kompromiss auf dem Tisch.",
  content: "Erster Absatz zum Abkommen. Zweiter Absatz mit weiteren Details zur Schutzklausel.",
  published: new Date().toISOString(),
  image: "https://img.example/ch.jpg",
  categories: ["Politik"],
  src: "SRF News",
  srcHome: "https://www.srf.ch/news",
  sourceKey: "Switzerland",
  catalogLang: "de",
  feedLang: "de-CH",
  plugin: "rss",
  ...over,
});

before(async () => {
  store.reset();

  const ch = [
    normalizeItem(raw()),
    normalizeItem(
      raw({
        link: "https://demo.example/ch/2",
        title: "Zürcher Beiz gewinnt Preis für das beste Fondue",
        summary: "Eine Quartierbeiz in Zürich setzt sich gegen 120 Mitbewerber durch.",
        categories: ["Lifestyle"],
        src: "20 Minuten",
      })
    ),
  ];
  const th = [
    normalizeItem(
      raw({
        link: "https://demo.example/th/1",
        title: "Parliament votes on new election law as protesters gather in Bangkok",
        summary: "Thousands rally outside parliament in Bangkok.",
        categories: ["Politics"],
        src: "Bangkok Post",
        sourceKey: "Thailand",
        catalogLang: "en",
        feedLang: "en",
      })
    ),
  ];

  ch.push(
    normalizeItem(
      raw({
        link: "https://demo.example/ch/3",
        title: "Stadtrat beschliesst neues Budget",
        summary: "Der Stadtrat hat entschieden.",
        categories: ["Politik"],
        src: "Luzerner Zeitung",
      })
    )
  );
  store.setCountry("756", "Switzerland", ch);
  store.setCountry("764", "Thailand", th);
  store.setFeedHealth("https://ok.example/feed", {
    plugin: "rss", sourceKey: "Switzerland", outlet: "SRF News",
    url: "https://ok.example/feed", ok: true, skipped: false, status: 200, items: 12, ms: 90, error: null,
  });
  store.setFeedHealth("https://bad.example/feed", {
    plugin: "rss", sourceKey: "Thailand", outlet: "Dead Outlet",
    url: "https://bad.example/feed", ok: false, skipped: false, status: 404, items: 0, ms: 40, error: "HTTP 404",
  });
  store.finishIngest();

  server = createApp().listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server?.close();
  store.reset();
});

const get = async (path, headers = {}) => {
  const res = await fetch(base + path, { headers });
  return { status: res.status, body: await res.json() };
};

test("GET /api/bootstrap returns everything the map needs to draw", async () => {
  const { status, body } = await get("/api/bootstrap");
  assert.equal(status, 200);
  assert.deepEqual(body.categories.slice(0, 3), ["All", "Politics", "Business"]);
  assert.equal(body.categoryCounts.All, 4);
  assert.equal(body.categoryCounts.Politics, 3);
  assert.equal(body.news["756"].name, "Switzerland");
  assert.equal(body.news["756"].articles.length, 3);
  assert.deepEqual(body.regions["756"], { ll: [8.23, 46.8], z: 6.6, min: 5.2 });
  assert.deepEqual(body.world, { center: [10, 25], zoom: 1.6 });
  assert.ok(body.reader.lang);
  assert.equal(body.langNames.nl, "Nederlands");

  // articles travel in their original language, never pre-translated
  const a = body.news["756"].articles[0];
  assert.ok(a.orig.title);
  assert.equal(a.read, undefined);
});

test("a visitor from the Netherlands is offered Dutch", async () => {
  const { body } = await get("/api/bootstrap", { "cf-ipcountry": "NL" });
  assert.equal(body.reader.lang, "nl");
  assert.equal(body.reader.langName, "Nederlands");
  assert.equal(body.reader.country, "NL");
});

test("GET /api/me explains how the language was chosen", async () => {
  const { body } = await get("/api/me", { "cf-ipcountry": "BR" });
  assert.equal(body.lang, "pt");
  assert.equal(body.via, "cf-ipcountry");
  assert.ok("provider" in body.translation);
});

test("GET /api/news filters by country, category and query", async () => {
  assert.equal((await get("/api/news")).body.total, 4);
  assert.equal((await get("/api/news?country=756")).body.total, 3);
  assert.equal((await get("/api/news?cat=Lifestyle")).body.total, 1);
  assert.equal((await get("/api/news?q=fondue")).body.total, 1);
  assert.equal((await get("/api/news?lang=en")).body.total, 1);
  assert.equal((await get("/api/news?q=nothingmatchesthis")).body.total, 0);
});

test("GET /api/article/:id returns the article and a translation slot", async () => {
  const { body: boot } = await get("/api/bootstrap");
  const id = boot.news["756"].articles[0].id;

  const { status, body } = await get(`/api/article/${id}?to=nl`);
  assert.equal(status, 200);
  assert.equal(body.ccn3, "756");
  assert.equal(body.country, "Switzerland");
  assert.ok(body.orig.title);
  assert.equal(body.reader.lang, "nl");
  // no provider is configured in tests: the original comes back, flagged
  assert.equal(body.translation.lang, "nl");
  assert.match(body.translation.reason, /translation provider/);

  assert.equal((await get("/api/article/does-not-exist")).status, 404);
});

test("an article already in the reader's language needs no translation", async () => {
  const { body: boot } = await get("/api/bootstrap");
  const id = boot.news["764"].articles[0].id;
  const { body } = await get(`/api/article/${id}?to=en`);
  assert.equal(body.lang, "en");
  assert.equal(body.translation, null);
});

test("POST /api/translate answers for a batch of ids", async () => {
  const { body: boot } = await get("/api/bootstrap");
  const ids = boot.news["756"].articles.map((a) => a.id);
  const res = await fetch(base + "/api/translate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ids, to: "nl" }),
  });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.lang, "nl");
  assert.equal(Object.keys(body.translations).length, 3);

  const bad = await fetch(base + "/api/translate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  assert.equal(bad.status, 400);
});

/* -------------------------------------------------------------- search -- */

test("searching a country name asks the map to fly there", async () => {
  const { body } = await get("/api/search?q=Switzerland");
  assert.equal(body.type, "country");
  assert.equal(body.country.ccn3, "756");
  assert.equal(body.country.live, true);
});

test("searching a town asks the map to fly to the town", async () => {
  const { body } = await get("/api/search?q=Lucerne");
  assert.equal(body.type, "place");
  assert.equal(body.place.name, "Lucerne");
  assert.equal(body.place.country, "Switzerland");
  assert.deepEqual(body.place.ll, [8.31, 47.05]);
});

test("a town is found by the name its own press uses", async () => {
  // German, French and native spellings all have to reach the same place
  for (const q of ["Luzern", "Lucerne", "Lucerna"]) {
    const { body } = await get(`/api/search?q=${encodeURIComponent(q)}`);
    assert.equal(body.type, "place", `"${q}" should resolve to a place`);
    assert.equal(body.place.name, "Lucerne");
  }
  const zurich = await get("/api/search?q=" + encodeURIComponent("Zürich"));
  assert.equal(zurich.body.place.name, "Zurich");

  const places = (await get("/api/places?q=Luzern")).body.places;
  assert.ok(places.some((p) => p.name === "Lucerne"));
});

test("the bundle tells the client which places can be zoomed into", async () => {
  const { body } = await get("/api/bootstrap");
  const names = body.cities.map((c) => c.name).sort();
  assert.ok(names.includes("Bern"), `expected Bern in ${names}`);
  assert.ok(names.includes("Zurich"));
  assert.ok(names.includes("Lucerne"), "the Luzerner Zeitung's home city is focusable");
  assert.ok(names.includes("Bangkok"));
  assert.equal(typeof body.cityZoom, "number");
  for (const c of body.cities) {
    assert.ok(Array.isArray(c.ll) && c.ll.length === 2);
    assert.ok(c.ccn3);
  }
});

test("cards carry the newsroom's home city so a city zoom can filter on it", async () => {
  const { body } = await get("/api/bootstrap");
  const arts = body.news["756"].articles;
  const lu = arts.find((a) => a.src === "Luzerner Zeitung");
  assert.equal(lu.srcCity, "Lucerne");
  const srf = arts.find((a) => a.src === "SRF News");
  assert.equal(srf.srcCity, "Zurich");
  assert.equal(srf.city, "Bern", "the headline's own place is separate from the newsroom's");
});

test("GET /api/city returns a town's own press", async () => {
  const { status, body } = await get("/api/city?name=Lucerne");
  assert.equal(status, 200);
  assert.equal(body.city, "Lucerne");
  assert.equal(body.country, "Switzerland");
  assert.deepEqual(body.ll, [8.31, 47.05]);
  assert.equal(body.total, 1);
  assert.deepEqual(body.localOutlets, ["Luzerner Zeitung"]);

  const zurich = await get("/api/city?name=Zurich");
  assert.ok(zurich.body.total >= 2, "Zurich has several newsrooms");
  assert.ok(zurich.body.localOutlets.includes("SRF News"));

  const bern = await get("/api/city?name=Bern");
  assert.ok(bern.body.total >= 1, "a story about Bern counts as Bern news");

  assert.equal((await get("/api/city")).status, 400);
  assert.equal((await get("/api/city?name=Nowhereville")).body.total, 0);
});

test("GET /api/news?city= narrows to one town", async () => {
  assert.equal((await get("/api/news?city=Lucerne")).body.total, 1);
  assert.equal((await get("/api/news?city=Bangkok")).body.total, 1);
  assert.equal((await get("/api/news?city=Nowhereville")).body.total, 0);
});

test("searching a topic keeps the map still and returns the stories", async () => {
  const { body } = await get("/api/search?q=fondue");
  assert.equal(body.type, "topic");
  assert.equal(body.country, null);
  assert.equal(body.place, null);
  assert.equal(body.articles.length, 1);
  assert.match(body.articles[0].orig.title, /Fondue/);
  assert.equal(body.articles[0].ccn3, "756");
});

test("a category name is a topic search across every country", async () => {
  const { body } = await get("/api/search?q=Politics");
  assert.equal(body.type, "topic");
  assert.equal(body.articles.length, 3);
  assert.deepEqual([...new Set(body.articles.map((a) => a.ccn3))].sort(), ["756", "764"]);
});

test("topic results carry the coordinates the cards are pinned to", async () => {
  const { body } = await get("/api/search?q=parliament");
  assert.ok(body.articles.length >= 1);
  for (const a of body.articles) {
    assert.ok(Array.isArray(a.ll) && a.ll.length === 2);
    assert.equal(typeof a.ll[0], "number");
  }
});

test("GET /api/places looks up towns for the search box", async () => {
  const { body } = await get("/api/places?q=Bang");
  assert.ok(body.places.some((p) => p.name === "Bangkok" && p.country === "Thailand"));
  assert.equal((await get("/api/places?q=a")).body.places.length, 0);
});

/* ------------------------------------------------------ sources & health -- */

test("GET /api/sources is keyed by the country names the map uses", async () => {
  const { body } = await get("/api/sources");
  assert.ok(Array.isArray(body.Switzerland));
  assert.ok(body.Switzerland.some((s) => s.m === "SRF News"));
  // the curated key "Turkey" is re-keyed onto the map's country name
  assert.ok(body["Türkiye"], "Türkiye should be present under the map's name");
  assert.ok(!body.Turkey);

  const one = await get("/api/sources?country=Switzerland");
  assert.equal(one.body.country, "Switzerland");
  assert.ok(one.body.sources.length > 0);
});

test("GET /sources.js keeps the window.NEWS_SOURCES contract", async () => {
  const res = await fetch(base + "/sources.js");
  const text = await res.text();
  assert.match(res.headers.get("content-type"), /javascript/);
  assert.match(text, /^window\.NEWS_SOURCES=\{/);
  const scope = {};
  new Function("window", text)(scope);
  assert.ok(Array.isArray(scope.NEWS_SOURCES.Switzerland));
});

test("GET /api/health reports what worked and what did not", async () => {
  const { body } = await get("/api/health");
  assert.equal(body.status, "ok");
  assert.equal(body.endpoints.total, 2);
  assert.equal(body.endpoints.ok, 1);
  assert.equal(body.endpoints.failed, 1);
  assert.equal(body.failures[0].error, "HTTP 404");
  assert.ok(body.plugins.some((p) => p.id === "rss" && p.enabled));
});

test("GET /api/plugins lists the registry", async () => {
  const { body } = await get("/api/plugins");
  assert.deepEqual(body.plugins.map((p) => p.id).sort(), [
    "city-press",
    "gdelt",
    "gnews",
    "google-news",
    "newsapi",
    "opml",
    "rss",
  ]);
  assert.ok(body.sourceGroups.includes("Global"));
});

test("manual ingest stays closed unless a token is configured", async () => {
  const res = await fetch(base + "/api/ingest", { method: "POST" });
  assert.equal(res.status, 403);
});

test("the app serves the design page and its client", async () => {
  const page = await fetch(base + "/");
  const html = await page.text();
  assert.equal(page.status, 200);
  assert.match(html, /<title>Global News — World Map<\/title>/);
  assert.match(html, /<script src="sources\.js"><\/script>/);
  assert.match(html, /<script src="app\.js"><\/script>/);
  assert.match(html, /id="map"/);
  assert.match(html, /class="chipshell" id="chips"/);

  const js = await fetch(base + "/app.js");
  assert.equal(js.status, 200);
  assert.match(js.headers.get("content-type"), /javascript/);
});

test("unknown routes answer with JSON, not a stack trace", async () => {
  const res = await fetch(base + "/api/nope");
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { error: "not found" });
});
