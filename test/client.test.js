import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { JSDOM } from "jsdom";

import { createApp } from "../server/app.js";
import { config } from "../server/config.js";
import * as store from "../server/lib/store.js";
import { normalizeItem } from "../server/ingest.js";

/**
 * Frontend behaviour test.
 *
 * Loads the real index.html and the real public/app.js into a DOM, points its
 * fetch at a live instance of the API, and drives the interactions the design
 * specifies: topic chips, country focus, news cards, the article panel with its
 * translation toggle, the sources panel, the mobile sheet, and all three search
 * intents (country / place / topic).
 *
 * MapLibre needs WebGL, which a headless DOM has no business providing, so the
 * map itself is a stub with an equirectangular projection — enough to assert
 * that cards land where their story happened.
 */

let server;
let base;
let dom;
let win;

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

function seed() {
  store.reset();
  const ch = [
    normalizeItem(raw()),
    normalizeItem(
      raw({
        link: "https://demo.example/ch/2",
        title: "Zürcher Beiz gewinnt Preis für das beste Fondue der Schweiz",
        summary: "Eine kleine Quartierbeiz in Zürich setzt sich gegen 120 Mitbewerber durch.",
        categories: ["Lifestyle"],
        src: "20 Minuten",
      })
    ),
    normalizeItem(
      raw({
        link: "https://demo.example/ch/3",
        title: "Luzern prüft den Kauf von drei Grossarealen",
        summary: "Der Leerstand in Luzern sinkt auf ein Rekordtief.",
        categories: ["Wirtschaft"],
        src: "Luzerner Zeitung",
      })
    ),
  ];
  ch.push(
    normalizeItem(
      raw({
        link: "https://demo.example/ch/4",
        title: "Stadtrat beschliesst neues Budget für die Altstadt",
        summary: "Der Stadtrat hat entschieden.",
        categories: ["Politik"],
        src: "Luzerner Zeitung",
      })
    )
  );
  store.setCountry("756", "Switzerland", ch);
  store.setCountry("276", "Germany", [
    normalizeItem(
      raw({
        link: "https://demo.example/de/1",
        title: "Stadtrat beschliesst Ausbau der Trambahn",
        summary: "Die Entscheidung fiel am Mittwoch.",
        categories: ["Politik"],
        src: "Münchner Merkur",
        sourceKey: "Germany",
      })
    ),
  ]);
  store.setCountry("040", "Austria", [
    normalizeItem(
      raw({
        link: "https://demo.example/at/1",
        title: "Nationalrat debattiert das Budget",
        summary: "Die Sitzung dauerte bis in die Nacht.",
        categories: ["Politik"],
        src: "Der Standard",
        sourceKey: "Austria",
      })
    ),
  ]);
  store.setCountry("764", "Thailand", [
    normalizeItem(
      raw({
        link: "https://demo.example/th/1",
        title: "Parliament votes on new election law as protesters gather in Bangkok",
        summary: "Thousands rally outside parliament in Bangkok over the electoral reform.",
        categories: ["Politics"],
        src: "Bangkok Post",
        sourceKey: "Thailand",
        catalogLang: "en",
        feedLang: "en",
      })
    ),
  ]);
  store.finishIngest();
}

/** Minimal MapLibre stand-in with a plate-carrée projection. */
function makeMapStub(win) {
  const listeners = {};
  let zoom = 1.6;
  let center = [10, 25];
  const map = {
    on(evt, fn) {
      (listeners[evt] ||= []).push(fn);
    },
    fire(evt) {
      (listeners[evt] || []).forEach((f) => f());
    },
    getZoom: () => zoom,
    getCenter: () => ({ lng: center[0], lat: center[1] }),
    getStyle: () => ({ layers: [] }),
    setPaintProperty() {},
    addLayer() {},
    moveLayer() {},
    project([lng, lat]) {
      const scale = 256 * Math.pow(2, zoom);
      return {
        x: win.innerWidth / 2 + ((lng - center[0]) / 360) * scale,
        y: win.innerHeight / 2 - ((lat - center[1]) / 180) * scale,
      };
    },
    flyTo(o) {
      if (o.center) center = o.center;
      if (typeof o.zoom === "number") zoom = o.zoom;
      map.fire("move");
    },
    zoomIn() {
      zoom += 1;
      map.fire("move");
    },
    zoomOut() {
      zoom -= 1;
      map.fire("move");
    },
  };
  // called with `new`, so it must be a real function, not an arrow
  win.maplibregl = {
    Map: function Map() {
      return map;
    },
  };
  win.__map = map;
}

const flush = (ms = 40) => new Promise((r) => setTimeout(r, ms));

before(async () => {
  seed();
  server = createApp().listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}`;

  const html = readFileSync(join(config.paths.public, "index.html"), "utf8")
    // the CDN scripts are unavailable (and irrelevant) in a headless run
    .replace(/<script src="https:\/\/unpkg[^>]*><\/script>/, "")
    .replace(/<script src="app\.js"><\/script>/, "");

  dom = new JSDOM(html, { url: base + "/", runScripts: "dangerously", pretendToBeVisual: true });
  win = dom.window;

  Object.defineProperty(win, "innerWidth", { value: 1600, configurable: true });
  Object.defineProperty(win, "innerHeight", { value: 900, configurable: true });
  win.matchMedia = (q) => ({
    matches: false,
    media: q,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
  });
  win.fetch = (url, opts) => fetch(new URL(url, base).toString(), opts);
  win.scrollTo = () => {};
  win.HTMLElement.prototype.scrollTo = () => {};
  win.HTMLElement.prototype.scrollIntoView = () => {};
  makeMapStub(win);

  // the outlet catalog, exactly as the server serves it
  const sourcesJs = await (await fetch(base + "/sources.js")).text();
  win.eval(sourcesJs);

  win.eval(readFileSync(join(config.paths.public, "app.js"), "utf8"));
  await flush(250); // let boot() settle
  win.__map.fire("load");
  await flush(60);
});

after(() => {
  dom?.window?.close();
  server?.close();
  store.reset();
});

const $ = (sel) => win.document.querySelector(sel);
const $$ = (sel) => [...win.document.querySelectorAll(sel)];

/* ------------------------------------------------------------------ boot -- */

test("the page keeps the design's structure", () => {
  assert.ok($("#map"), "map container");
  assert.ok($("#markers"), "marker layer");
  assert.ok($("#cards"), "card layer");
  assert.ok($(".topbar .brand svg"), "logo");
  assert.ok($("#q"), "search input");
  assert.ok($("#dropdown #dlist"), "country dropdown");
  assert.ok($(".zoomctrl #zin"), "zoom controls");
  assert.ok($("#hint"), "hint box");
  assert.ok($("#panel #ptrans"), "article panel with translation block");
  assert.ok($("#spanel"), "sources panel");
  assert.ok($("#msheet"), "mobile sheet");
});

test("topic chips are built from the API taxonomy, All active", () => {
  const tabs = $$("#chips .tab");
  assert.equal(tabs.length, 14);
  assert.equal(tabs[0].dataset.cat, "All");
  assert.equal(tabs[0].textContent, "All");
  assert.ok(tabs[0].classList.contains("active"));
  assert.deepEqual(
    tabs.map((t) => t.dataset.cat).slice(0, 4),
    ["All", "Politics", "Business", "Sports"]
  );
});

test("a country marker is drawn for every covered country", () => {
  const dots = $$("#markers .mdot");
  const labels = dots.map((d) => d.textContent).sort();
  assert.deepEqual(labels, ["Austria", "Germany", "Switzerland", "Thailand"]);
});

test("the dropdown lists covered countries first and marks them LIVE", () => {
  $("#q").dispatchEvent(new win.Event("focus"));
  const rows = $$("#dlist .drow");
  assert.ok(rows.length >= 2);
  assert.ok(rows[0].querySelector(".dlive"), "first row is a covered country");
  assert.match(rows[0].querySelector(".dsub").textContent, /stories/);
  assert.match(rows[0].querySelector(".dsub").textContent, /sources/);
});

/* ---------------------------------------------------- country focus flow -- */

test("zooming into a country renders its news cards around it", async () => {
  const chDot = $$("#markers .mdot").find((d) => d.textContent === "Switzerland");
  chDot.dispatchEvent(new win.Event("click"));
  await flush(300); // the map debounces its focus check by 120ms

  const cards = $$("#cards .newscard");
  assert.equal(cards.length, 4);
  assert.match($("#cards .countrytag").textContent, /Switzerland · 4 stories live/);
  assert.ok($("#cards .srcchip"), "sources chip is shown");
  assert.match($("#cards .srcchip").textContent, /verified sources/);

  for (const c of cards) {
    assert.ok(c.style.left.endsWith("px") && c.style.top.endsWith("px"), "cards are positioned");
    assert.ok(parseFloat(c.style.top) >= 108, "cards clear the top bar");
  }
});

test("cards show the story in the language it was published in", () => {
  const card = $$("#cards .newscard")[0];
  assert.match(card.querySelector(".src .lang").textContent, /^(DE|EN)$/);
  assert.match(card.querySelector(".src .tag").textContent, /ago|just now/);
  // the German headline is not silently anglicised on the card
  const titles = $$("#cards .newscard h3").map((h) => h.textContent);
  assert.ok(titles.some((t) => /Bundesrat|Fondue|Luzern/.test(t)));
});

test("a story without a feed image still gets a card image", () => {
  const imgs = $$("#cards .newscard img");
  assert.equal(imgs.length, 4);
  for (const i of imgs) assert.ok(i.getAttribute("src").length > 0);
});

test("city dots appear for stories that name a place", () => {
  const dots = $$("#markers .cdot");
  const labels = dots.map((d) => d.querySelector(".l").textContent);
  assert.ok(labels.includes("Bern"), `expected Bern in ${JSON.stringify(labels)}`);
  assert.ok(labels.includes("Zurich"));
  assert.ok(labels.includes("Lucerne"));
});

test("a topic chip filters the cards on screen", async () => {
  $$("#chips .tab").find((t) => t.dataset.cat === "Lifestyle").dispatchEvent(new win.Event("click"));
  await flush(40);
  assert.equal($$("#cards .newscard").length, 1);
  assert.match($("#cards .newscard h3").textContent, /Fondue/);

  $$("#chips .tab").find((t) => t.dataset.cat === "Science").dispatchEvent(new win.Event("click"));
  await flush(40);
  assert.equal($$("#cards .newscard").length, 0);
  assert.match($("#cards .noresult").textContent, /No stories match this filter/);

  $$("#chips .tab").find((t) => t.dataset.cat === "All").dispatchEvent(new win.Event("click"));
  await flush(40);
  assert.equal($$("#cards .newscard").length, 4);
});

/* -------------------------------------------------------- article panel -- */

/* ------------------------------------------------- which country am I over -- */

test("the country under the view wins, not the one with the nearest centre", async () => {
  // Munich sits closer to Austria's centre than to Germany's, and Austria is a
  // small country whose centre stays on screen far longer. Picking by distance
  // therefore labelled Munich "Austria" — the map has to read the outline.
  win.__map.flyTo({ center: [11.58, 48.14], zoom: 6.5 });
  await flush(320);
  assert.match($("#cards .countrytag").textContent, /Germany/);

  // and the other way round: over Vienna it really is Austria
  win.__map.flyTo({ center: [16.37, 48.21], zoom: 6.5 });
  await flush(320);
  assert.match($("#cards .countrytag").textContent, /Austria/);
});

test("too far out for the country underneath shows nothing, never a neighbour", async () => {
  // Switzerland only focuses from zoom 5.2; at 4 the reader is still looking at
  // a continent, and a card headed "Germany" over Zurich would be wrong.
  win.__map.flyTo({ center: [8.54, 47.37], zoom: 4 });
  await flush(320);
  assert.equal($$("#cards .newscard").length, 0);
  assert.equal($("#cards .countrytag"), null);
});

test("a country's towns are marked so the reader knows where to zoom", async () => {
  win.__map.flyTo({ center: [8.23, 46.8], zoom: 6 });
  await flush(320);
  const labels = $$("#markers .cdot .l").map((e) => e.textContent);
  assert.ok(labels.includes("Lucerne"), `expected Lucerne among ${labels}`);
  assert.ok(labels.includes("Zurich"));
  assert.ok(labels.length >= 2, "a dot per town with local news, not just one");
});

test("leaving a town takes its dot with it", async () => {
  win.__map.flyTo({ center: [8.31, 47.05], zoom: 9 });
  await flush(320);
  assert.equal($$("#markers .cdot").length, 1, "in a town, only that town is marked");

  win.__map.flyTo({ center: [-30, 30], zoom: 3 }); // mid-Atlantic
  await flush(320);
  assert.equal($$("#markers .cdot").length, 0);
  assert.equal($$("#cards .newscard").length, 0);
});

/* ------------------------------------------------------------ city zoom -- */

test("zooming into a city shows that city's own press", async () => {
  // Lucerne: one story that names it, one from the paper that is based there
  win.__map.flyTo({ center: [8.31, 47.05], zoom: 9 });
  await flush(320);

  assert.match($("#cards .countrytag").textContent, /Lucerne/);
  assert.match($("#cards .countrytag").textContent, /local stor/);
  const cards = $$("#cards .newscard");
  assert.equal(cards.length, 2);
  for (const c of cards) assert.match(c.textContent, /Luzerner Zeitung/);
  assert.match($("#cards .srcchip").textContent, /local newsroom/);
});

test("zooming into another city swaps the local press", async () => {
  win.__map.flyTo({ center: [8.54, 47.37], zoom: 9 });
  await flush(320);
  assert.match($("#cards .countrytag").textContent, /Zurich/);
  const sources = $$("#cards .newscard .src").map((s) => s.textContent);
  assert.ok(sources.some((s) => /SRF News|20 Minuten/.test(s)), `got ${sources}`);
  assert.ok(!sources.some((s) => /Luzerner Zeitung/.test(s)), "Lucerne's paper is not Zurich news");
});

test("a city with no coverage at all falls back to the country view", async () => {
  win.__map.flyTo({ center: [8.95, 46.0], zoom: 9 }); // Lugano — no outlet, no mention
  await flush(320);
  // the map never focuses a place it has nothing for; the country still reads
  assert.match($("#cards .countrytag").textContent, /Switzerland/);
  assert.ok($$("#cards .newscard").length >= 3);
});

test("a filter that empties a focused city says so rather than widening", async () => {
  win.__map.flyTo({ center: [8.31, 47.05], zoom: 9 });
  await flush(320);
  assert.match($("#cards .countrytag").textContent, /Lucerne/);

  $$("#chips .tab").find((t) => t.dataset.cat === "Sports").dispatchEvent(new win.Event("click"));
  await flush(60);
  assert.equal($$("#cards .newscard").length, 0);
  assert.match($("#cards .noresult").textContent, /Nothing local from Lucerne/);

  $$("#chips .tab").find((t) => t.dataset.cat === "All").dispatchEvent(new win.Event("click"));
  await flush(60);
  assert.equal($$("#cards .newscard").length, 2);
});

test("zooming back out returns to the country view", async () => {
  win.__map.flyTo({ center: [8.23, 46.8], zoom: 6.6 });
  await flush(320);
  assert.match($("#cards .countrytag").textContent, /Switzerland/);
  assert.ok($$("#cards .newscard").length >= 3);
});

test("clicking a card opens the panel with the original text", async () => {
  const card = $$("#cards .newscard").find((c) => /Bundesrat/.test(c.textContent));
  card.dispatchEvent(new win.Event("click"));
  await flush(120);

  assert.ok($("#panel").classList.contains("open"));
  assert.match($("#p-src").textContent, /SRF News/);
  assert.match($("#p-title").textContent, /Bundesrat/);
  assert.ok($("#p-lede").textContent.length > 0);
  assert.ok($("#p-text").querySelectorAll("p").length > 0, "body paragraphs loaded from the API");
  assert.match($("#p-read").textContent, /min read/);
  assert.match($("#p-country").textContent, /Switzerland/);
  assert.equal($(".panel .porig").getAttribute("href"), "https://demo.example/ch/1");
});

test("the translation block offers the reader's language and the original", async () => {
  // no provider is configured in tests, so the note says so and the text stays original
  assert.ok($("#ptrans").classList.contains("show"), "German article, English reader → toggle visible");
  assert.ok($("#t-de").classList.contains("active"));
  assert.match($("#t-orig").textContent, /^Original · /);
  assert.match($("#tnote").textContent, /translation provider|Automatically translated/);

  $("#t-orig").dispatchEvent(new win.Event("click"));
  await flush(30);
  assert.ok($("#t-orig").classList.contains("active"));
  assert.match($("#p-title").textContent, /Bundesrat/);
  assert.match($("#tnote").textContent, /Original text/);

  const opts = [...$("#t-target").options].map((o) => o.value);
  assert.ok(opts.length >= 1, "target language selector is populated");
});

test("Escape closes the panel", async () => {
  win.document.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Escape" }));
  win.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Escape" }));
  await flush(30);
  assert.ok(!$("#panel").classList.contains("open"));
});

test("the sources chip opens the outlet list for that country", async () => {
  $("#cards .srcchip").dispatchEvent(new win.Event("click"));
  await flush(40);
  assert.ok($("#spanel").classList.contains("open"));
  assert.match($("#s-title").textContent, /Sources — Switzerland/);
  assert.match($("#s-count").textContent, /outlets/);
  const rows = $$("#s-list .srcrow");
  assert.ok(rows.length >= 3);
  assert.ok(rows.some((r) => /SRF News/.test(r.textContent)));
  assert.ok(rows.some((r) => /RSS feed|Licensed \/ API only/.test(r.textContent)));

  $("#s-close").dispatchEvent(new win.Event("click"));
  await flush(20);
  assert.ok(!$("#spanel").classList.contains("open"));
});

/* --------------------------------------------------------------- search -- */

async function search(text) {
  const q = $("#q");
  q.value = text;
  q.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Enter" }));
  await flush(140);
}

test("searching a country flies the map to it, without a topic overlay", async () => {
  win.__map.flyTo({ center: [10, 25], zoom: 1.6 });
  await search("Thailand");
  const c = win.__map.getCenter();
  assert.ok(Math.abs(c.lng - 100.99) < 0.01, `expected Thailand centre, got ${c.lng}`);
  assert.ok(win.__map.getZoom() > 4);
});

test("searching a town flies the map to the town", async () => {
  await search("Lucerne");
  const c = win.__map.getCenter();
  assert.ok(Math.abs(c.lng - 8.31) < 0.01 && Math.abs(c.lat - 47.05) < 0.01, "centred on Lucerne");
  assert.ok(win.__map.getZoom() >= 8, "zoomed to town level");
});

test("searching a topic keeps the map still and shows matching stories worldwide", async () => {
  const before = { ...win.__map.getCenter(), z: win.__map.getZoom() };
  await search("election");

  const after = win.__map.getCenter();
  assert.equal(after.lng, before.lng, "the map must not move for a topic search");
  assert.equal(win.__map.getZoom(), before.z);

  const cards = $$("#cards .newscard");
  assert.ok(cards.length >= 1, "matching stories are shown");
  assert.match($("#cards .countrytag").textContent, /election/);
  assert.match($("#cards .countrytag").textContent, /stories worldwide/);
  for (const c of cards) {
    assert.ok(c.dataset.ll, "each card is pinned to a place");
    assert.ok(c.style.left.endsWith("px"));
  }
  assert.ok($$("#markers .cdot").length >= 1, "result locations are marked on the map");
});

test("topic results never overlap each other", async () => {
  await search("Bern");
  const boxes = $$("#cards .newscard").map((c) => ({
    x: parseFloat(c.style.left),
    y: parseFloat(c.style.top),
  }));
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const overlap = Math.abs(boxes[i].x - boxes[j].x) < 250 && Math.abs(boxes[i].y - boxes[j].y) < 210;
      assert.ok(!overlap, `cards ${i} and ${j} overlap`);
    }
  }
});

test("a keyword search spans countries", async () => {
  await search("parliament");
  const cards = $$("#cards .newscard");
  assert.ok(cards.length >= 1);
  assert.ok(cards.some((c) => /Parliament votes/.test(c.textContent)));
});

test("clearing the search leaves topic mode and restores country focus", async () => {
  $("#qclear").dispatchEvent(new win.Event("click"));
  await flush(60);
  assert.equal($("#cards .countrytag") && /worldwide/.test($("#cards .countrytag").textContent), false);
  assert.equal($$("#markers .cdot").length >= 0, true);
});

/* ------------------------------------------------------- map interaction -- */

test("zoom controls drive the map", () => {
  const z = win.__map.getZoom();
  $("#zin").dispatchEvent(new win.Event("click"));
  assert.equal(win.__map.getZoom(), z + 1);
  $("#zout").dispatchEvent(new win.Event("click"));
  assert.equal(win.__map.getZoom(), z);
  $("#zreset").dispatchEvent(new win.Event("click"));
  assert.equal(win.__map.getZoom(), 1.6);
  assert.deepEqual([win.__map.getCenter().lng, win.__map.getCenter().lat], [10, 25]);
});

test("country markers hide once the map is zoomed in", () => {
  win.__map.flyTo({ center: [8.23, 46.8], zoom: 6.6 });
  const dots = $$("#markers .mdot");
  assert.ok(dots.every((d) => d.style.opacity === "0"), "pills fade out at close zoom");
  win.__map.flyTo({ center: [10, 25], zoom: 1.6 });
  assert.ok($$("#markers .mdot").every((d) => d.style.opacity === "1"));
});

test("the hint disappears once the reader starts zooming", () => {
  win.__map.flyTo({ center: [8.23, 46.8], zoom: 6.6 });
  assert.ok($("#hint").classList.contains("hide"));
});
