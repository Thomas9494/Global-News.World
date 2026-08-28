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
 * Phone-viewport behaviour test.
 *
 * client.test.js pins matchMedia to matches:false, so everything it drives runs
 * as a desktop. The mobile branches — the pinch wording in the hint and the
 * overlap thinning that stops ~190 country pills piling into an unreadable heap
 * on a 390px screen — need a DOM that reports a narrow, coarse-pointer viewport,
 * which is what this file provides.
 */

let server;
let base;
let dom;
let win;

const article = (over = {}) =>
  normalizeItem({
    title: "Bundesrat einigt sich auf Kompromiss",
    link: "https://demo.example/a/1",
    summary: "Ein Kompromiss liegt auf dem Tisch.",
    published: new Date().toISOString(),
    categories: ["Politik"],
    src: "SRF News",
    srcHome: "https://www.srf.ch/news",
    sourceKey: "Switzerland",
    catalogLang: "de",
    feedLang: "de-CH",
    plugin: "rss",
    ...over,
  });

/** Countries whose centres sit close together, with very different story counts. */
function seed() {
  store.reset();
  // Switzerland, Austria and Liechtenstein are neighbours: at world zoom their
  // pills land within a few pixels of each other, which is exactly the pile-up.
  store.setCountry("756", "Switzerland", [
    article(),
    article({ link: "https://demo.example/a/2", title: "Zweite Geschichte" }),
    article({ link: "https://demo.example/a/3", title: "Dritte Geschichte" }),
  ]);
  store.setCountry("040", "Austria", [
    article({ link: "https://demo.example/b/1", sourceKey: "Austria", src: "ORF" }),
  ]);
  store.setCountry("438", "Liechtenstein", [
    article({ link: "https://demo.example/c/1", sourceKey: "Liechtenstein", src: "Vaterland" }),
  ]);
}

function makeMapStub(w) {
  const listeners = {};
  let zoom = 1.6;
  let center = [10, 25];
  const map = {
    on(evt, fn) { (listeners[evt] ||= []).push(fn); },
    fire(evt) { (listeners[evt] || []).forEach((f) => f()); },
    getZoom: () => zoom,
    getCenter: () => ({ lng: center[0], lat: center[1] }),
    getStyle: () => ({ layers: [] }),
    setPaintProperty() {}, addLayer() {}, moveLayer() {},
    project([lng, lat]) {
      const scale = 256 * Math.pow(2, zoom);
      return {
        x: w.innerWidth / 2 + ((lng - center[0]) / 360) * scale,
        y: w.innerHeight / 2 - ((lat - center[1]) / 180) * scale,
      };
    },
    flyTo(o) {
      if (o.center) center = o.center;
      if (typeof o.zoom === "number") zoom = o.zoom;
      map.fire("move");
    },
    zoomIn() { zoom += 1; map.fire("move"); },
    zoomOut() { zoom -= 1; map.fire("move"); },
  };
  w.maplibregl = { Map: function Map() { return map; } };
  w.__map = map;
}

const flush = (ms = 40) => new Promise((r) => setTimeout(r, ms));

before(async () => {
  seed();
  server = createApp().listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}`;

  const html = readFileSync(join(config.paths.public, "index.html"), "utf8")
    .replace(/<script src="https:\/\/unpkg[^>]*><\/script>/, "")
    .replace(/<script src="app\.js"><\/script>/, "");

  dom = new JSDOM(html, { url: base + "/", runScripts: "dangerously", pretendToBeVisual: true });
  win = dom.window;

  // iPhone-sized, touch input.
  Object.defineProperty(win, "innerWidth", { value: 390, configurable: true });
  Object.defineProperty(win, "innerHeight", { value: 844, configurable: true });
  win.matchMedia = (q) => ({
    matches: /max-width:\s*640px/.test(q) || /pointer:\s*coarse/.test(q),
    media: q,
    addEventListener() {}, removeEventListener() {},
    addListener() {}, removeListener() {},
  });
  win.fetch = (url, opts) => fetch(new URL(url, base).toString(), opts);
  win.scrollTo = () => {};
  win.HTMLElement.prototype.scrollTo = () => {};
  win.HTMLElement.prototype.scrollIntoView = () => {};
  makeMapStub(win);

  const sourcesJs = await (await fetch(base + "/sources.js")).text();
  win.eval(sourcesJs);

  // jsdom lays nothing out, so pills would measure 0x0 and never collide.
  // Give every .mdot the size a real phone renders it at.
  Object.defineProperty(win.HTMLElement.prototype, "offsetWidth", {
    configurable: true,
    get() { return this.classList?.contains("mdot") ? 104 : 0; },
  });
  Object.defineProperty(win.HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get() { return this.classList?.contains("mdot") ? 24 : 0; },
  });

  win.eval(readFileSync(join(config.paths.public, "app.js"), "utf8"));
  await flush(250);
  win.__map.fire("load");
  await flush(60);
});

after(() => {
  dom?.window?.close();
  server?.close();
  store.reset();
});

const $ = (sel) => win.document.querySelector(sel);
const pills = () => [...win.document.querySelectorAll("#markers .mdot")];
const shown = (el) => el.style.opacity !== "0";

/**
 * jsdom's getComputedStyle ignores @media entirely and will not expand var()
 * inside calc(), so it reports desktop values on a phone viewport. These
 * helpers walk the CSSOM instead and apply the phone media queries by hand —
 * which is what we actually want to assert: that the rule is written, since a
 * one-character edit is all it takes to reintroduce the zoom bug.
 */
const PHONE_WIDTH = 390;

/** Media queries that a 390px phone matches. */
const phoneMatches = (condition) => {
  const max = /max-width:\s*(\d+)px/.exec(condition);
  if (max) return PHONE_WIDTH <= Number(max[1]);
  if (/hover:\s*none|pointer:\s*coarse/.test(condition)) return true;
  if (/hover:\s*hover|pointer:\s*fine|prefers-reduced-motion/.test(condition)) return false;
  return false;
};

/** Every style rule that applies on a phone, outermost first. */
function phoneRules() {
  const out = [];
  const walk = (rules) => {
    for (const rule of rules) {
      if (rule.media) {
        if (phoneMatches(rule.conditionText || rule.media.mediaText)) walk(rule.cssRules);
      } else if (rule.selectorText) {
        out.push(rule);
      }
    }
  };
  for (const sheet of win.document.styleSheets) walk(sheet.cssRules);
  return out;
}

/**
 * Last value `property` gets on `selector` through the phone cascade.
 * Only getPropertyValue is used: jsdom's CSSStyleDeclaration is neither
 * iterable nor indexable by .item() in this version.
 */
function declaredValue(selector, property) {
  const want = selector.replace(/\s+/g, " ").trim();
  let value = "";
  for (const rule of phoneRules()) {
    const hit = rule.selectorText
      .split(",")
      .some((s) => s.replace(/\s+/g, " ").trim() === want);
    if (!hit) continue;
    const v = rule.style.getPropertyValue(property).trim();
    if (v) value = v;
  }
  return value;
}

/** Resolves an element's font-size through the phone cascade. */
function effectiveFontSize(el) {
  let size = "16px"; // browser default for inputs is ~13.33px, but body sets none
  for (const rule of phoneRules()) {
    const value = rule.style.getPropertyValue("font-size").trim();
    if (!value) continue;
    try {
      if (el.matches(rule.selectorText)) size = value;
    } catch {
      /* selector jsdom cannot parse — ignore */
    }
  }
  return size;
}

/** Raw text of a media block, for asserting a rule exists at all. */
function mediaBlock(condition) {
  const norm = (s) => s.replace(/\s+/g, "");
  for (const sheet of win.document.styleSheets) {
    for (const rule of sheet.cssRules) {
      const text = rule.conditionText || rule.media?.mediaText || "";
      if (rule.cssRules && norm(text) === norm(condition)) {
        return [...rule.cssRules].map((r) => r.cssText).join("\n");
      }
    }
  }
  return null;
}

test("the hint describes the gesture a touch device actually has", () => {
  const text = $("#hinttext").textContent;
  assert.match(text, /Pinch to zoom/, "should tell the reader to pinch");
  assert.doesNotMatch(text, /mouse wheel/, "a phone has no mouse wheel");
  assert.match(text, /translated on tap/, "and taps, not clicks");
});

test("the search placeholder is the short one that fits a phone field", () => {
  const input = $("#q");
  assert.equal(input.placeholder, "Search a country or topic");
  // The long copy is kept so a rotation back to a wide viewport restores it.
  assert.equal(
    input.dataset.placeholderNarrow,
    "Search a country or topic",
    "the short string stays available on the element"
  );
  assert.ok(
    input.placeholder.length < 30,
    `placeholder must fit ~155px of field, got ${input.placeholder.length} chars`
  );
});

/**
 * The single most important guard in this file.
 *
 * iOS Safari force-zooms the entire page when a focused form field is smaller
 * than 16px, and it stays zoomed after the keyboard closes. That one detail
 * produced a whole day of reports that read like unrelated layout bugs:
 * "content too big", "cut off on both sides", "not centered", sideways
 * scrolling. It is a one-character edit away from coming back.
 */
test("no form control is small enough to make iOS zoom the page", () => {
  const controls = [...win.document.querySelectorAll("input, select, textarea")];
  assert.ok(controls.length > 0, "there should be form controls to check");

  const tooSmall = controls
    .map((el) => ({
      id: el.id || el.tagName.toLowerCase(),
      size: parseFloat(effectiveFontSize(el)),
    }))
    .filter((c) => !(c.size >= 16));

  assert.deepEqual(
    tooSmall,
    [],
    "every control must be >= 16px at a phone viewport, or Safari zooms the page"
  );
});

test("the news strip centres a card rather than pinning it left", () => {
  assert.equal(
    declaredValue(".mstrip .newscard", "scroll-snap-align"),
    "center",
    "a card must snap centred"
  );

  // The inline padding has to come from the card width so the first and last
  // card can reach the middle too. A fixed inset is what pushed it off-centre.
  const padding =
    declaredValue(".mstrip", "padding-left") || declaredValue(".mstrip", "padding");
  assert.match(
    padding,
    /calc/,
    `inline padding must be derived from the card width, got "${padding}"`
  );
  assert.doesNotMatch(padding, /\b16px\b/, "a fixed 16px inset is the old bug");
});

test("the dropdown list is budgeted off its container, not a second hard number", () => {
  const maxHeight = declaredValue(".dropdown .dlist", "max-height");

  // The two caps used to be set independently (380 vs 370) with the ~31px
  // header unaccounted for, so the last row was silently clipped on a phone.
  assert.match(
    maxHeight,
    /calc/,
    `.dlist must derive its cap from .dropdown, got "${maxHeight}"`
  );
  assert.equal(
    declaredValue(".dropdown .dlist", "overflow-x"),
    "hidden",
    "a lone overflow-y:auto computes overflow-x to auto — pin it"
  );
});

test("touch devices are not left in a stuck :hover state", () => {
  // :hover latches after a tap on iOS, so the movement/fill rules need undoing.
  const rules = mediaBlock("(hover:none)");
  assert.ok(rules, "there must be a (hover:none) block");
  assert.match(rules, /\.tab:hover/, "chip highlight must be neutralised");
  assert.match(rules, /\.newscard:hover/, "card lift must be neutralised");
});

test("the back gesture closes an open panel instead of leaving the site", async () => {
  const panel = $("#panel");
  const startLength = win.history.length;

  // Opening a panel is what pushes the entry the back gesture will consume.
  panel.classList.add("open");
  win.eval("syncOverlayHistory()");
  assert.ok(
    win.history.length > startLength,
    "opening a panel should add a history entry to spend on back"
  );

  win.history.back();
  await flush(60); // popstate is async in jsdom

  assert.equal(
    panel.classList.contains("open"),
    false,
    "back closes the panel rather than navigating away"
  );
});

test("closing a panel by its button gives the history entry back", async () => {
  const panel = $("#panel");
  panel.classList.add("open");
  win.eval("syncOverlayHistory()");
  const withPanel = win.history.length;

  $("#p-close").dispatchEvent(new win.Event("click", { bubbles: true }));
  await flush(60);

  assert.equal(panel.classList.contains("open"), false, "panel closes");
  assert.equal(
    win.history.length,
    withPanel,
    "no entry is stranded — a second back must not be needed to leave"
  );
});

test("country pills are rendered for every country with news", () => {
  assert.equal(pills().length, 3, "Switzerland, Austria, Liechtenstein");
});

test("pills that would overlap are thinned, the busiest country surviving", () => {
  const visible = pills().filter(shown);

  assert.ok(visible.length >= 1, "at least one pill survives");
  assert.ok(
    visible.length < pills().length,
    `neighbouring pills should not all be drawn on a 390px screen ` +
      `(got ${visible.length} of ${pills().length})`
  );

  // Switzerland has 3 stories against its neighbours' 1, so it wins the space.
  const ch = pills().find((p) => p.dataset.rid === "756");
  assert.ok(shown(ch), "Switzerland keeps its label");
});

test("every pill stays reachable once the map is zoomed past the pill layer", () => {
  win.__map.flyTo({ center: [8.23, 46.8], zoom: 6.6 });
  assert.ok(
    pills().every((p) => !shown(p)),
    "above the zoom threshold the whole layer fades, thinning or not"
  );
  win.__map.flyTo({ center: [10, 25], zoom: 1.6 });
});
