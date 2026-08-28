/*
 * Global News — world map client.
 *
 * The markup and stylesheet in index.html are the design, unchanged. This file
 * replaces the design's inline demo data with the live API:
 *
 *   GET  /api/bootstrap        regions, articles per country, reader language
 *   GET  /api/article/:id      one article + a translation into the reader's language
 *   POST /api/translate        batch translation for headline previews
 *   /sources.js                the outlet catalog as window.NEWS_SOURCES
 *
 * Cards deliberately show each story in the language its newsroom published it
 * in. The translation lives in the article panel, pre-set to the language the
 * reader most likely understands.
 */

/* ---- state filled from /api/bootstrap ---- */
let CATS = ["All"];
let LANGS = {};      // code → native name  ("nl" → "Nederlands")
let LANGEN = {};     // code → english name ("nl" → "Dutch")
let NEWS = {};       // ccn3 → { name, total, articles[] }
let REGION = {};     // ccn3 → { ll, z, min }
let WORLD = { center: [10, 25], zoom: 1.6 };
let CITIES = [];      // places the reader can zoom into
let CITY_ZOOM = 7.6;  // from this zoom level on, the map reads city-local
let READER = { lang: "en", langName: "English", via: "default", explicit: false };
let TRANSLATE = { enabled: false, provider: "none", targets: [] };

const LANG_KEY = "globalnews.lang";

/* ---- viewport (live, so cards stay placed after a resize) ---- */
const W = () => innerWidth;
const H = () => innerHeight;

const cardsLayer = document.getElementById("cards");
const markerLayer = document.getElementById("markers");
const hint = document.getElementById("hint");
const mqMobile = matchMedia("(max-width:640px)");
const msheet = document.getElementById("msheet");
const mhead = document.getElementById("mhead");
const mstrip = document.getElementById("mstrip");

/**
 * The hint tells the reader how to zoom. A phone has no mouse wheel, so on a
 * touch device it has to describe the gesture that device actually has.
 */
if (matchMedia("(pointer:coarse)").matches) {
  const hintText = document.getElementById("hinttext");
  if (hintText) {
    hintText.textContent =
      "Pinch to zoom in and out. Once you're close enough to a country, the " +
      "latest stories from its local newspapers pop up — no country " +
      "restrictions, translated on tap.";
  }
}

/**
 * Mobile bottom sheet: drag-to-dismiss.
 *
 * The sheet is opened from a dozen places by toggling .open, so rather than
 * route every one of them through a helper we mirror that class onto <body>.
 * CSS uses it to move the hint out from under the sheet.
 */
new MutationObserver(() =>
  document.body.classList.toggle("msheet-open", msheet.classList.contains("open"))
).observe(msheet, { attributes: true, attributeFilter: ["class"] });

(() => {
  const grab = document.getElementById("mgrabwrap");
  if (!grab) return;

  const CLOSE_AFTER_PX = 60; // past this the sheet is dismissed, not sprung back
  let startY = 0;
  let dy = 0;
  let dragging = false;

  const move = (y) => {
    // Downward only — dragging up must not tear the sheet off its edge.
    dy = Math.max(0, y - startY);
    msheet.style.transform = `translateY(${dy}px)`;
  };

  const end = () => {
    if (!dragging) return;
    dragging = false;
    msheet.classList.remove("dragging");
    msheet.style.transform = "";
    if (dy > CLOSE_AFTER_PX) msheet.classList.remove("open");
    dy = 0;
  };

  grab.addEventListener("touchstart", (e) => {
    if (!msheet.classList.contains("open")) return;
    dragging = true;
    dy = 0;
    startY = e.touches[0].clientY;
    msheet.classList.add("dragging");
  }, { passive: true });

  grab.addEventListener("touchmove", (e) => {
    if (!dragging) return;
    e.preventDefault(); // we own this gesture; don't let the page scroll too
    move(e.touches[0].clientY);
  }, { passive: false });

  grab.addEventListener("touchend", end, { passive: true });
  grab.addEventListener("touchcancel", end, { passive: true });

  // A plain tap on the handle closes it, and keyboards get the same affordance.
  grab.addEventListener("click", () => msheet.classList.remove("open"));
  grab.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      msheet.classList.remove("open");
    }
  });
})();

let countries = [];
let focusedId = null;
let activeCat = "All";
let query = "";
let regionIds = [];
let map = null;

/**
 * Topic mode. A search for a subject or keyword must not move the map — it
 * surfaces every matching story worldwide instead, pinned where it happened.
 * While this is set, country focus is suspended.
 */
let topic = null; // { q, articles: [], total: number }

/**
 * City focus. Once the reader is close enough to a town, the map stops showing
 * the country and shows that town: stories about it, plus stories from the
 * newsrooms based there. Zurich gets the NZZ, Lucerne the Luzerner Zeitung.
 */
let cityFocus = null; // { name, ccn3, ll }

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

/* ---------------------------------------------------------------- images -- */
/**
 * Feeds do not always ship an image. Rather than invent a stock photo, draw a
 * quiet branded tile carrying the outlet's name, so the card keeps its shape
 * and the reader still sees where the story comes from.
 */
const PLACEHOLDER_STOPS = [
  ["#e8f0fe", "#cddffb"],
  ["#e6f4f1", "#c8e6e0"],
  ["#eef2f7", "#d8e2ee"],
  ["#f0eefb", "#dcd8f4"],
];
function placeholderImg(a) {
  const seed = [...String(a.id || a.src || "")].reduce((n, ch) => (n * 31 + ch.charCodeAt(0)) >>> 0, 7);
  const [c1, c2] = PLACEHOLDER_STOPS[seed % PLACEHOLDER_STOPS.length];
  const label = String(a.src || "").slice(0, 28);
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="280" viewBox="0 0 480 280">` +
    `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">` +
    `<stop offset="0" stop-color="${c1}"/><stop offset="1" stop-color="${c2}"/></linearGradient></defs>` +
    `<rect width="480" height="280" fill="url(#g)"/>` +
    `<text x="28" y="152" font-family="Inter, sans-serif" font-size="26" font-weight="700" ` +
    `fill="rgba(15,23,42,.42)">${esc(label)}</text></svg>`;
  return "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
}
const cardImage = (a) => (a.img ? a.img : placeholderImg(a));

/* ------------------------------------------------------------- news cards -- */
function newsCardEl(id, a, i) {
  const el = document.createElement("div");
  el.className = "newscard";
  el.style.animationDelay = i * 90 + "ms";
  const c = a.orig;
  el.innerHTML = `<img src="${esc(cardImage(a))}" alt="" loading="lazy"><div class="body">
    <div class="src">${esc(a.src)}<span class="lang">${esc(a.lang.toUpperCase())}</span><span class="tag">${esc(a.time)}</span></div>
    <h3>${esc(c.title)}</h3><p>${esc(c.teaser)}</p></div>`;
  const img = el.querySelector("img");
  img.onerror = () => {
    img.onerror = null;
    img.src = placeholderImg(a);
  };
  el.onclick = () => openPanel(id, a);
  return el;
}

function renderSheet(id) {
  const arts = filteredArticles(id);
  const srcs = (window.NEWS_SOURCES && NEWS_SOURCES[NEWS[id].name]) || [];
  mhead.innerHTML =
    `<b>${esc(NEWS[id].name)}</b><span class="mcnt">${arts.length} stories live</span>` +
    (srcs.length ? `<button class="msrc" id="msrcbtn">◉ ${srcs.length} sources</button>` : "");
  const sb = document.getElementById("msrcbtn");
  if (sb) sb.onclick = () => openSources(NEWS[id].name);
  mstrip.innerHTML = "";
  if (!arts.length) {
    const n = document.createElement("div");
    n.className = "mnone";
    n.textContent = "No stories match this filter — adjust search or category.";
    mstrip.appendChild(n);
  }
  arts.forEach((a, i) => mstrip.appendChild(newsCardEl(id, a, i)));
  mstrip.scrollLeft = 0;
  msheet.classList.add("open");
}

function project(ll) {
  const p = map.project(ll);
  return [p.x, p.y];
}

/* ------------------------------------------------------------------- map -- */
function initMap() {
  map = new maplibregl.Map({
    container: "map",
    style: "https://tiles.openfreemap.org/styles/positron",
    center: WORLD.center,
    zoom: WORLD.zoom,
    minZoom: 1.1,
    maxZoom: 15,
  });

  map.on("load", () => {
    // recolor: green-toned land, white ocean/background, blue lakes
    const style = map.getStyle();
    let waterLayer = null;
    (style.layers || []).forEach((l) => {
      const id = l.id.toLowerCase();
      try {
        if (l.type === "background") {
          map.setPaintProperty(l.id, "background-color", "#dcead0");
        } else if (l.type === "fill" && id.includes("water") && !id.includes("way")) {
          if (!waterLayer) waterLayer = l;
          map.setPaintProperty(l.id, "fill-color", "#ffffff");
        } else if (
          l.type === "fill" &&
          (id.includes("landcover") || id.includes("park") || id.includes("grass") || id.includes("wood") || id.includes("forest"))
        ) {
          map.setPaintProperty(l.id, "fill-color", "#c3ddb2");
        } else if (l.type === "fill" && (id.includes("landuse") || id.includes("residential"))) {
          map.setPaintProperty(l.id, "fill-color", "#d3e5c4");
        } else if (l.type === "line" && (id.includes("boundary") || id.includes("admin")) && !id.includes("disputed")) {
          map.setPaintProperty(l.id, "line-color", "#5c6b7a");
          map.setPaintProperty(l.id, "line-width", ["interpolate", ["linear"], ["zoom"], 1, 0.6, 4, 1.0, 8, 1.5]);
          map.setPaintProperty(l.id, "line-opacity", 0.95);
        }
      } catch (e) {}
    });
    if (waterLayer) {
      // lakes & rivers stay blue on top of the white ocean
      try {
        map.addLayer(
          {
            id: "lakes-blue",
            type: "fill",
            source: waterLayer.source,
            "source-layer": waterLayer["source-layer"],
            filter: ["!=", ["get", "class"], "ocean"],
            paint: { "fill-color": "#a8cdf0" },
          },
          waterLayer.id
        );
        map.moveLayer("lakes-blue");
        map.moveLayer(waterLayer.id, "lakes-blue");
      } catch (e) {}
    }
    drawRegionMarkers();
    onView();
  });

  let viewTimer = null;
  map.on("move", () => {
    positionMarkers();
    positionCityDots();
    if (topic) positionTopicCards();
    else if (cityFocus) positionCityCards();
    else if (focusedId) positionCards(focusedId);
    if (map.getZoom() > 2.2) hint.classList.add("hide");
    clearTimeout(viewTimer);
    viewTimer = setTimeout(onView, 120);
  });

  document.getElementById("zin").onclick = () => map.zoomIn({ duration: 350 });
  document.getElementById("zout").onclick = () => map.zoomOut({ duration: 350 });
  document.getElementById("zreset").onclick = () =>
    map.flyTo({ center: WORLD.center, zoom: WORLD.zoom, duration: 1400 });

  addEventListener("resize", () => {
    measureMarkers(); // pill widths change with orientation / text scaling
    positionMarkers();
    if (topic) renderTopicCards();
    else if (cityFocus) renderCityCards();
    else if (focusedId) renderCards(focusedId);
  });
}

function drawRegionMarkers() {
  markerLayer.querySelectorAll(".mdot").forEach((e) => e.remove());
  regionIds.forEach((id) => {
    if (!REGION[id]) return;
    const el = document.createElement("div");
    el.className = "mdot";
    el.dataset.rid = id;
    el.innerHTML = `<span class="d"></span>${esc(NEWS[id].name)}`;
    el.onclick = () => zoomTo(id);
    markerLayer.appendChild(el);
  });
  measureMarkers();
  positionMarkers();
}

/**
 * One batched read of the pill sizes. positionMarkers runs on every map move,
 * so it must do its overlap maths from cached numbers and never touch layout.
 */
function measureMarkers() {
  markerLayer.querySelectorAll(".mdot").forEach((el) => {
    el._w = el.offsetWidth;
    el._h = el.offsetHeight;
  });
}

/** Breathing room so surviving pills don't sit edge to edge. */
const PILL_GAP = 4;

function positionMarkers() {
  if (!map) return;
  const z = map.getZoom();
  const hideAll = z > 2.8;

  /**
   * A phone shows the same ~190 pills as a desktop in a third of the width, so
   * they pile into an unreadable heap. Thin them by overlap, keeping whichever
   * country has the most stories — the reader loses the label, never the news,
   * since the country is still reachable by tapping the map or searching.
   */
  const thin = mqMobile.matches && !hideAll;
  const placed = [];

  let pills = [...markerLayer.querySelectorAll(".mdot")];
  if (thin) {
    pills.sort(
      (a, b) => (NEWS[b.dataset.rid]?.total || 0) - (NEWS[a.dataset.rid]?.total || 0)
    );
  }

  pills.forEach((el) => {
    const region = REGION[el.dataset.rid];
    if (!region) return;
    const [x, y] = project(region.ll);
    el.style.left = x + "px";
    el.style.top = y + "px";

    let hide = hideAll;
    if (thin) {
      // .mdot is translate(-50%,-50%), so its box straddles the projected point.
      const w = (el._w || 0) / 2 + PILL_GAP;
      const h = (el._h || 0) / 2 + PILL_GAP;
      const box = { l: x - w, r: x + w, t: y - h, b: y + h };
      if (placed.some((p) => box.l < p.r && box.r > p.l && box.t < p.b && box.b > p.t)) {
        hide = true;
      } else {
        placed.push(box);
      }
    }

    el.style.opacity = hide ? 0 : 1;
    el.style.pointerEvents = hide ? "none" : "auto";
  });
}

function renderCityDots() {
  markerLayer.querySelectorAll(".cdot").forEach((e) => e.remove());
  if (!focusedId) return;
  const seen = {};
  filteredArticles(focusedId).forEach((a) => {
    // the place the story is about, else the town its newsroom sits in — both
    // are worth a dot, because both are somewhere the reader can zoom into
    const place = a.city || a.srcCity;
    if (place && a.ll && !seen[place]) {
      seen[place] = 1;
      const el = document.createElement("div");
      el.className = "cdot";
      el.dataset.ll = a.ll.join(",");
      el.innerHTML = `<span class="l">${esc(place)}</span><span class="d"></span>`;
      el.onclick = () => openPanel(focusedId, a);
      markerLayer.appendChild(el);
    }
  });
  positionCityDots();
}

function positionCityDots() {
  if (!map) return;
  markerLayer.querySelectorAll(".cdot").forEach((el) => {
    const [x, y] = project(el.dataset.ll.split(",").map(Number));
    el.style.left = x + "px";
    el.style.top = y + "px";
  });
}

function onView() {
  if (topic) return;

  // close in → the town wins over the country
  const near = cityInView();
  if (near) {
    setCityFocus(near);
    return;
  }
  if (cityFocus) {
    // leaving a town: its cards and its dot go with it
    cityFocus = null;
    focusedId = null;
    cardsLayer.innerHTML = "";
    markerLayer.querySelectorAll(".cdot").forEach((e) => e.remove());
  }

  const z = map.getZoom();

  // Which country the reader is over, regardless of how far out they are.
  const over = countryUnderView(regionIds);

  if (over) {
    // Standing over a country: show it, or — if the reader is still too far out
    // for it — show nothing. Never a neighbour. A card headed "Niger" while the
    // reader is looking at Lagos is worse than an empty map.
    setFocus(z >= REGION[over].min ? over : null);
    return;
  }

  // Over open water, or over a country we have no outline for: the design's
  // original rule, the nearest country centre still on screen.
  const focusable = regionIds.filter((id) => REGION[id] && z >= REGION[id].min);
  setFocus(nearestCountryOnScreen(focusable));
}

function setCityFocus(city) {
  if (cityFocus && cityFocus.name === city.name) {
    positionCityCards();
    return;
  }
  cityFocus = city;
  focusedId = city.ccn3;
  hint.classList.add("hide");
  renderCityCards();
}

function setFocus(id) {
  if (topic || cityFocus) return;
  if (id === focusedId) {
    if (id) positionCards(id);
    return;
  }
  focusedId = id;
  cardsLayer.innerHTML = "";
  renderCityDots();
  if (id) renderCards(id);
  else msheet.classList.remove("open");
}

function zoomTo(id) {
  const r = REGION[id];
  if (!r) return;
  map.flyTo({ center: r.ll, zoom: r.z, duration: 1600, essential: true });
}
function zoomToPlace(ll, z) {
  map.flyTo({ center: ll, zoom: z || 4.6, duration: 1600, essential: true });
}

/* --------------------------------------------------------------- filters -- */
function searchable(a, name) {
  let s = `${a.src} ${name} ${a.cat} ${a.city || ""} ${a.orig.title} ${a.orig.teaser}`;
  if (a.translationPreview) s += " " + a.translationPreview;
  return s.toLowerCase();
}

function filteredArticles(id) {
  const q = query.trim().toLowerCase();
  if (!NEWS[id]) return [];
  return NEWS[id].articles.filter(
    (a) =>
      (activeCat === "All" || a.cat === activeCat) &&
      (!q || searchable(a, NEWS[id].name).includes(q))
  );
}

/** A town's own news: written about it, or written by a newsroom based there. */
function isLocalTo(a, city) {
  return a.city === city || a.srcCity === city;
}

function cityArticles(city) {
  const q = query.trim().toLowerCase();
  const group = NEWS[city.ccn3];
  if (!group) return [];
  return group.articles.filter(
    (a) =>
      isLocalTo(a, city.name) &&
      (activeCat === "All" || a.cat === activeCat) &&
      (!q || searchable(a, group.name).includes(q))
  );
}

/** Great-circle-ish distance in degrees, good enough for picking a neighbour. */
function degreesBetween(lng1, lat1, lng2, lat2) {
  const dx = (lng1 - lng2) * Math.cos(((lat1 + lat2) / 2) * (Math.PI / 180));
  return Math.hypot(dx, lat1 - lat2);
}

/**
 * The country whose outline the reader is standing over.
 *
 * Nearest-centre is the wrong question: over Munich, Austria's centre is closer
 * than Germany's; over Lagos, Benin's, Togo's and Niger's all beat Nigeria's.
 * So ask which countries' bounding boxes contain the point, and let the nearest
 * known town settle it — towns are dense and unambiguous where borders are not.
 *
 * @param {string[]} candidates ccn3 codes worth considering at this zoom
 */
function countryUnderView(candidates) {
  if (!candidates.length) return null;
  const c = map.getCenter();

  const inside = candidates.filter((id) => {
    const b = REGION[id]?.bbox;
    return b && c.lng >= b[0] && c.lng <= b[2] && c.lat >= b[1] && c.lat <= b[3];
  });
  if (!inside.length) return null;
  if (inside.length === 1) return inside[0];

  // boxes overlap here — the closest town decides
  const allowed = new Set(inside);
  let best = null;
  let bestD = Infinity;
  for (const city of CITIES) {
    if (!allowed.has(city.ccn3)) continue;
    const d = degreesBetween(city.ll[0], city.ll[1], c.lng, c.lat);
    if (d < bestD) {
      bestD = d;
      best = city.ccn3;
    }
  }
  if (best) return best;

  for (const id of inside) {
    const d = degreesBetween(REGION[id].ll[0], REGION[id].ll[1], c.lng, c.lat);
    if (d < bestD) {
      bestD = d;
      best = id;
    }
  }
  return best;
}

/** The design's original rule: the nearest country centre still on screen. */
function nearestCountryOnScreen(candidates) {
  let target = null;
  let best = 1e18;
  for (const id of candidates) {
    const [x, y] = project(REGION[id].ll);
    const dx = x - W() / 2;
    const dy = y - H() / 2;
    const d2 = dx * dx + dy * dy;
    if (Math.sqrt(d2) < Math.min(W(), H()) * 0.6 && d2 < best) {
      best = d2;
      target = id;
    }
  }
  return target;
}

/** The town nearest the middle of the screen, if the reader is close enough. */
function cityInView() {
  if (!map || map.getZoom() < CITY_ZOOM) return null;
  const limit = Math.min(W(), H()) * 0.42;
  let best = null;
  let bestD = Infinity;
  for (const c of CITIES) {
    const [x, y] = project(c.ll);
    const d = Math.hypot(x - W() / 2, y - H() / 2);
    if (d < limit && d < bestD) {
      bestD = d;
      best = c;
    }
  }
  return best;
}

function cardCapacity() {
  const ch = 210,
    gap = 22,
    topPad = 108,
    botPad = 40;
  return 2 * Math.max(1, Math.floor((H() - topPad - botPad + gap) / (ch + gap)));
}

function renderCards(id) {
  cardsLayer.innerHTML = "";
  if (mqMobile.matches) {
    renderSheet(id);
    return;
  }
  msheet.classList.remove("open");
  const arts = filteredArticles(id);
  const tag = document.createElement("div");
  tag.className = "countrytag";
  tag.innerHTML = `${esc(NEWS[id].name)} <span>· ${arts.length} stories live</span>`;
  cardsLayer.appendChild(tag);
  const srcs = (window.NEWS_SOURCES && NEWS_SOURCES[NEWS[id].name]) || [];
  if (srcs.length) {
    const sc = document.createElement("button");
    sc.className = "srcchip";
    sc.innerHTML = `◉ ${srcs.length} verified sources`;
    sc.onclick = () => openSources(NEWS[id].name);
    cardsLayer.appendChild(sc);
  }
  if (!arts.length) {
    const n = document.createElement("div");
    n.className = "noresult";
    n.textContent = "No stories match this filter — adjust search or category.";
    cardsLayer.appendChild(n);
  }
  const cap = cardCapacity();
  const shown = arts.slice(0, Math.min(6, cap));
  shown.forEach((a, i) => cardsLayer.appendChild(newsCardEl(id, a, i)));
  const rest = arts.length - shown.length;
  if (rest > 0) {
    const more = document.createElement("button");
    more.className = "morechip";
    more.textContent = `+${rest} more stories`;
    more.onclick = () => openPanel(id, arts[shown.length]);
    cardsLayer.appendChild(more);
  }
  positionCards(id);
  renderCityDots();
}

function positionCards(id) {
  if (mqMobile.matches || !REGION[id]) return;
  let [cx, cy] = project(REGION[id].ll);
  // when the country's centre is off screen, hang the cards off the view centre
  if (cx < -200 || cx > W() + 200 || cy < -200 || cy > H() + 200) {
    cx = W() / 2;
    cy = H() / 2;
  }
  layoutAround(cx, cy);
}

/** Places the cards in two columns either side of a point on the map. */
function layoutAround(cx, cy) {
  const els = [...cardsLayer.querySelectorAll(".newscard")];
  const tag = cardsLayer.querySelector(".countrytag");
  const nores = cardsLayer.querySelector(".noresult");
  if (tag) {
    tag.style.left = cx - tag.offsetWidth / 2 + "px";
    tag.style.top = cy - 16 + "px";
  }
  const sc = cardsLayer.querySelector(".srcchip");
  if (sc) {
    sc.style.left = cx - sc.offsetWidth / 2 + "px";
    sc.style.top = cy + 22 + "px";
  }
  if (nores) {
    nores.style.left = cx - nores.offsetWidth / 2 + "px";
    nores.style.top = cy + 28 + "px";
  }
  const cw = 250,
    ch = 210,
    gap = 22,
    topPad = 108,
    botPad = 40;
  const perCol = Math.max(1, Math.floor((H() - topPad - botPad + gap) / (ch + gap)));
  const rightEdge = W() - cw - 84; // keep clear of fixed zoom controls
  const railEdge = 16;
  const spread = Math.min(W() * 0.26, 380);
  const leftX = Math.max(railEdge, Math.min(cx - cw - spread, rightEdge));
  const rightX = Math.max(railEdge, Math.min(cx + spread, rightEdge));
  const nL = Math.ceil(els.length / 2),
    nR = Math.floor(els.length / 2);
  els.forEach((el, i) => {
    const col = i % 2,
      row = Math.floor(i / 2);
    const n = col === 0 ? nL : nR;
    const colH = n * ch + (n - 1) * gap;
    const start = Math.max(topPad, Math.min(cy - colH / 2, H() - botPad - colH));
    const x = col === 0 ? leftX : rightX;
    const y = start + row * (ch + gap) + (col === 1 ? 26 : 0); // slight stagger on the right column
    el.style.left = Math.max(16, Math.min(x, rightEdge)) + "px";
    el.style.top = Math.max(topPad, Math.min(y, H() - botPad - ch)) + "px";
    el.style.zIndex = 20 + i;
  });
  const more = cardsLayer.querySelector(".morechip");
  if (more) {
    more.style.left = cx - more.offsetWidth / 2 + "px";
    more.style.top = Math.min(cy + 64, H() - botPad) + "px";
  }
  void perCol;
}

/* ----------------------------------------------------------- city focus -- */
/**
 * The local press of one town, laid out the way the country view lays out a
 * country: cards on either side of the place, dots on the map.
 */
function renderCityCards() {
  if (!cityFocus) return;
  cardsLayer.innerHTML = "";
  markerLayer.querySelectorAll(".cdot").forEach((e) => e.remove());

  const arts = cityArticles(cityFocus);
  const country = NEWS[cityFocus.ccn3]?.name || "";

  if (mqMobile.matches) {
    mhead.innerHTML =
      `<b>${esc(cityFocus.name)}</b><span class="mcnt">${arts.length} local ${arts.length === 1 ? "story" : "stories"}</span>`;
    mstrip.innerHTML = "";
    if (!arts.length) {
      const n = document.createElement("div");
      n.className = "mnone";
      n.textContent = `Nothing local from ${cityFocus.name} right now — zoom out for ${country}.`;
      mstrip.appendChild(n);
    }
    arts.forEach((a, i) => mstrip.appendChild(newsCardEl(cityFocus.ccn3, a, i)));
    mstrip.scrollLeft = 0;
    msheet.classList.add("open");
    return;
  }
  msheet.classList.remove("open");

  const tag = document.createElement("div");
  tag.className = "countrytag";
  tag.innerHTML = `${esc(cityFocus.name)} <span>· ${arts.length} local ${arts.length === 1 ? "story" : "stories"}</span>`;
  cardsLayer.appendChild(tag);

  // which newsrooms in this town are on screen
  const outlets = [...new Set(arts.filter((a) => a.srcCity === cityFocus.name).map((a) => a.src))];
  if (outlets.length) {
    const sc = document.createElement("button");
    sc.className = "srcchip";
    sc.innerHTML = `◉ ${outlets.length} local ${outlets.length === 1 ? "newsroom" : "newsrooms"}`;
    sc.title = outlets.join(" · ");
    sc.onclick = () => openSources(country);
    cardsLayer.appendChild(sc);
  }

  if (!arts.length) {
    const n = document.createElement("div");
    n.className = "noresult";
    n.textContent = `Nothing local from ${cityFocus.name} right now — zoom out for ${country}.`;
    cardsLayer.appendChild(n);
  }

  const shown = arts.slice(0, Math.min(6, cardCapacity()));
  shown.forEach((a, i) => cardsLayer.appendChild(newsCardEl(cityFocus.ccn3, a, i)));

  const rest = arts.length - shown.length;
  if (rest > 0) {
    const next = arts[shown.length];
    const more = document.createElement("button");
    more.className = "morechip";
    more.textContent = `+${rest} more from ${cityFocus.name}`;
    more.onclick = () => openPanel(cityFocus.ccn3, next);
    cardsLayer.appendChild(more);
  }

  const dot = document.createElement("div");
  dot.className = "cdot";
  dot.dataset.ll = cityFocus.ll.join(",");
  dot.innerHTML = `<span class="l">${esc(cityFocus.name)}</span><span class="d"></span>`;
  markerLayer.appendChild(dot);

  positionCityCards();
  positionCityDots();
}

/** Same two-column arrangement the country view uses, anchored on the town. */
function positionCityCards() {
  if (!cityFocus || mqMobile.matches || !map) return;
  const [cx, cy] = project(cityFocus.ll);
  layoutAround(cx, cy);
}

/* --------------------------------------------------------- topic results -- */
/**
 * Renders a worldwide result set: one card per matching story, pinned to the
 * place it is about. Cards are laid out on a coarse grid so they never cover
 * each other, and the count is capped to what the viewport can show without
 * turning into a wall of paper.
 */
function topicCapacity() {
  const cols = Math.max(1, Math.floor((W() - 32) / 272));
  const rows = Math.max(1, Math.floor((H() - 148) / 232));
  return Math.max(3, Math.min(cols * rows, 18));
}

function renderTopicCards() {
  if (!topic) return;
  cardsLayer.innerHTML = "";
  markerLayer.querySelectorAll(".cdot").forEach((e) => e.remove());

  const arts = topic.articles.filter((a) => activeCat === "All" || a.cat === activeCat);

  if (mqMobile.matches) {
    mhead.innerHTML = `<b>${esc(topic.q)}</b><span class="mcnt">${arts.length} stories worldwide</span>`;
    mstrip.innerHTML = "";
    if (!arts.length) {
      const n = document.createElement("div");
      n.className = "mnone";
      n.textContent = "No stories match this search — try another word or clear the filter.";
      mstrip.appendChild(n);
    }
    arts.forEach((a, i) => mstrip.appendChild(newsCardEl(a.ccn3, a, i)));
    mstrip.scrollLeft = 0;
    msheet.classList.add("open");
    return;
  }
  msheet.classList.remove("open");

  const tag = document.createElement("div");
  tag.className = "countrytag";
  tag.innerHTML = `${esc(topic.q)} <span>· ${arts.length} of ${topic.total} stories worldwide</span>`;
  cardsLayer.appendChild(tag);

  if (!arts.length) {
    const n = document.createElement("div");
    n.className = "noresult";
    n.textContent = "No stories match this search — try another word or clear the filter.";
    cardsLayer.appendChild(n);
  }

  const shown = arts.slice(0, topicCapacity());
  shown.forEach((a, i) => {
    const el = newsCardEl(a.ccn3, a, i);
    el.dataset.ll = (a.ll || REGION[a.ccn3]?.ll || [0, 0]).join(",");
    cardsLayer.appendChild(el);

    // a pulsing dot marks where the story is from
    const dot = document.createElement("div");
    dot.className = "cdot";
    dot.dataset.ll = el.dataset.ll;
    dot.innerHTML = `<span class="l">${esc(a.city || a.country || NEWS[a.ccn3]?.name || "")}</span><span class="d"></span>`;
    dot.onclick = () => openPanel(a.ccn3, a);
    markerLayer.appendChild(dot);
  });

  const rest = arts.length - shown.length;
  if (rest > 0) {
    const next = arts[shown.length];
    const more = document.createElement("button");
    more.className = "morechip";
    more.textContent = `+${rest} more stories`;
    more.onclick = () => openPanel(next.ccn3, next);
    cardsLayer.appendChild(more);
  }

  positionTopicCards();
  positionCityDots();
}

function positionTopicCards() {
  if (!topic || mqMobile.matches || !map) return;
  const cw = 250,
    ch = 210,
    cellW = 266,
    cellH = 226,
    topPad = 108,
    botPad = 24,
    sidePad = 16;

  const cols = Math.max(1, Math.floor((W() - 2 * sidePad) / cellW));
  const rows = Math.max(1, Math.floor((H() - topPad - botPad) / cellH));
  const taken = new Set();

  const cells = [...cardsLayer.querySelectorAll(".newscard")].map((el) => {
    const [x, y] = project(el.dataset.ll.split(",").map(Number));
    return { el, x, y };
  });
  // place the leftmost stories first so the layout reads west to east
  cells.sort((a, b) => a.x - b.x || a.y - b.y);

  for (const c of cells) {
    const wantCol = Math.min(cols - 1, Math.max(0, Math.round((c.x - sidePad - cw / 2) / cellW)));
    const wantRow = Math.min(rows - 1, Math.max(0, Math.round((c.y - topPad - ch / 2) / cellH)));
    let col = wantCol,
      row = wantRow;

    // spiral outwards until a free cell is found
    outer: for (let ring = 0; ring < Math.max(cols, rows) + 1; ring++) {
      for (let dr = -ring; dr <= ring; dr++) {
        for (let dc = -ring; dc <= ring; dc++) {
          if (Math.max(Math.abs(dr), Math.abs(dc)) !== ring) continue;
          const r = wantRow + dr,
            k = wantCol + dc;
          if (r < 0 || r >= rows || k < 0 || k >= cols) continue;
          if (taken.has(r + ":" + k)) continue;
          row = r;
          col = k;
          break outer;
        }
      }
    }
    taken.add(row + ":" + col);
    c.el.style.left = sidePad + col * cellW + "px";
    c.el.style.top = topPad + row * cellH + "px";
    c.el.style.zIndex = 20 + row;
  }

  const tag = cardsLayer.querySelector(".countrytag");
  if (tag) {
    tag.style.left = W() / 2 - tag.offsetWidth / 2 + "px";
    tag.style.top = topPad - 34 + "px";
  }
  const nores = cardsLayer.querySelector(".noresult");
  if (nores) {
    nores.style.left = W() / 2 - nores.offsetWidth / 2 + "px";
    nores.style.top = H() / 2 + "px";
  }
  const more = cardsLayer.querySelector(".morechip");
  if (more) {
    more.style.left = W() / 2 - more.offsetWidth / 2 + "px";
    more.style.top = H() - botPad - 40 + "px";
  }
}

function exitTopic() {
  if (!topic) return;
  topic = null;
  cityFocus = null;
  cardsLayer.innerHTML = "";
  markerLayer.querySelectorAll(".cdot").forEach((e) => e.remove());
  focusedId = null;
  onView();
}

/**
 * Routes what the reader typed:
 *   a country  -> fly there
 *   a town     -> fly there
 *   anything else (a subject, an outlet, a keyword) -> show the stories, keep the map still
 */
async function runSearch(raw) {
  const q = String(raw || "").trim();
  if (!q) {
    exitTopic();
    return;
  }
  let data;
  try {
    const res = await fetch(`/api/search?q=${encodeURIComponent(q)}&limit=60`);
    data = await res.json();
  } catch (err) {
    console.error("[global-news] search failed", err);
    return;
  }

  closeDrop();

  if (data.type === "country" && data.country) {
    exitTopic();
    query = "";
    if (REGION[data.country.ccn3]) zoomTo(data.country.ccn3);
    else zoomToPlace(data.country.ll, Math.max(3.4, data.country.z - 0.6));
    return;
  }
  if (data.type === "place" && data.place) {
    exitTopic();
    query = "";
    // make sure the town is one the map can focus, even if nothing local ran today
    if (!CITIES.some((c) => c.name === data.place.name)) {
      CITIES.push({ name: data.place.name, ccn3: data.place.ccn3, ll: data.place.ll });
    }
    zoomToPlace(data.place.ll, data.place.capital ? 8.2 : 8.8);
    return;
  }

  // topic / keyword: never move the map, show what matches
  query = "";
  focusedId = null;
  cityFocus = null;
  msheet.classList.remove("open");
  hint.classList.add("hide");
  topic = { q, articles: data.articles || [], total: data.total || (data.articles || []).length };
  renderTopicCards();
}

/* ------------------------------------------------------------- topic dock -- */
const chipsEl = document.getElementById("chips");

function selectCat(c) {
  activeCat = c;
  [...chipsEl.children].forEach((x) => x.classList.toggle("active", x.dataset.cat === c));
  refresh();
}

function buildChips() {
  chipsEl.innerHTML = "";
  CATS.forEach((c) => {
    const b = document.createElement("button");
    b.className = "tab";
    b.dataset.cat = c;
    b.title = c;
    b.innerHTML = `<span class="tlbl">${esc(c)}</span>`;
    b.onclick = () => {
      selectCat(c);
      chipsEl.scrollTo({ left: b.offsetLeft - chipsEl.clientWidth / 2 + b.offsetWidth / 2, behavior: "smooth" });
    };
    chipsEl.appendChild(b);
  });
  selectCat("All");
}

// horizontal drag-scroll for the filter row
{
  let down = false,
    startX = 0,
    startL = 0,
    moved = false;
  chipsEl.addEventListener("pointerdown", (e) => {
    down = true;
    moved = false;
    startX = e.clientX;
    startL = chipsEl.scrollLeft;
  });
  addEventListener("pointermove", (e) => {
    if (!down) return;
    const dx = e.clientX - startX;
    if (Math.abs(dx) > 4) {
      moved = true;
      chipsEl.classList.add("dragging");
    }
    if (moved) chipsEl.scrollLeft = startL - dx;
  });
  addEventListener("pointerup", () => {
    down = false;
    setTimeout(() => chipsEl.classList.remove("dragging"), 0);
  });
  chipsEl.addEventListener(
    "wheel",
    (e) => {
      if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
        e.preventDefault();
        chipsEl.scrollLeft += e.deltaY;
      }
    },
    { passive: false }
  );
}

/* -------------------------------------------------- search + country list -- */
const qEl = document.getElementById("q");
const qClear = document.getElementById("qclear");
const dropdown = document.getElementById("dropdown");
const dlist = document.getElementById("dlist");

function regionThumb() {
  return `<svg width="42" height="28" viewBox="0 0 42 28"><circle cx="21" cy="14" r="5"></circle></svg>`;
}

function buildDropdown(filter) {
  const f = (filter || "").trim().toLowerCase();
  const coveredCcn3 = new Set(regionIds);
  const list = [];
  regionIds.forEach((id) => list.push({ rid: id, name: NEWS[id].name, covered: true }));
  countries.forEach((c) => {
    if (coveredCcn3.has(c.ccn3)) return;
    list.push({ name: c.name, ll: c.ll, covered: false });
  });
  const rows = list
    .filter((r) => r.name && (!f || r.name.toLowerCase().includes(f)))
    .sort((a, b) => b.covered - a.covered || a.name.localeCompare(b.name));
  dlist.innerHTML = "";
  if (!rows.length) {
    dlist.innerHTML = `<div class="dnone">No country found — the search also covers topics and outlets.</div>`;
    return;
  }
  rows.forEach((r) => {
    const n = r.rid ? NEWS[r.rid] : null;
    const nsrc = window.NEWS_SOURCES && NEWS_SOURCES[r.name] ? NEWS_SOURCES[r.name].length : 0;
    let sub = n
      ? `${n.total || n.articles.length} stories · ${[...new Set(n.articles.map((a) => LANGS[a.lang] || a.lang.toUpperCase()))]
          .slice(0, 4)
          .join(" · ")}`
      : nsrc
        ? ""
        : "No coverage yet";
    if (nsrc) sub += (sub ? " · " : "") + nsrc + " sources";
    const b = document.createElement("button");
    b.className = "drow";
    b.innerHTML = `<span class="thumb">${regionThumb()}</span>
      <span><div class="dname">${esc(r.name)}${n ? ' <span class="dlive">LIVE</span>' : ""}</div><div class="dsub">${esc(sub)}</div></span>
      <span class="dgo"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M9 6l6 6-6 6"></path></svg></span>`;
    b.onclick = () => {
      qEl.value = r.name;
      query = "";
      syncClear();
      closeDrop();
      exitTopic();
      if (r.rid) zoomTo(r.rid);
      else zoomToPlace(r.ll);
    };
    dlist.appendChild(b);
  });
}

function openDrop() {
  buildDropdown(qEl.value);
  dropdown.classList.add("open");
}
function closeDrop() {
  dropdown.classList.remove("open");
}
function syncClear() {
  qClear.classList.toggle("show", qEl.value.length > 0);
}

qEl.addEventListener("focus", openDrop);
qEl.addEventListener("input", () => {
  query = qEl.value;
  syncClear();
  if (topic && !qEl.value.trim()) exitTopic();
  buildDropdown(qEl.value);
  dropdown.classList.add("open");
  refresh();
});
qEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && qEl.value.trim()) runSearch(qEl.value);
  if (e.key === "Escape") {
    closeDrop();
    if (topic) {
      qEl.value = "";
      syncClear();
      exitTopic();
    }
  }
});
qClear.onclick = () => {
  qEl.value = "";
  query = "";
  syncClear();
  exitTopic();
  buildDropdown("");
  refresh();
  qEl.focus();
};
document.getElementById("qdrop").onclick = () => {
  dropdown.classList.contains("open") ? closeDrop() : openDrop();
};
document.addEventListener("click", (e) => {
  if (!e.target.closest(".searchbox")) closeDrop();
});
addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
    e.preventDefault();
    qEl.focus();
  }
});

function refresh() {
  if (topic) renderTopicCards();
  else if (cityFocus) renderCityCards();
  else if (focusedId) renderCards(focusedId);
  else renderCityDots();
}

/* -------------------------------------------------------- sources panel -- */
const spanel = document.getElementById("spanel");

function openSources(name) {
  const srcs = (window.NEWS_SOURCES && NEWS_SOURCES[name]) || [];
  document.getElementById("s-title").textContent = "Sources — " + name;
  document.getElementById("s-count").textContent = srcs.length + " outlets";
  document.getElementById("s-list").innerHTML = srcs
    .map((s) => {
      const link = s.r || s.w;
      return `<div class="srcrow">
      <div class="sm"><b>${esc(s.m)}</b><span>${s.r ? "RSS feed" : s.w ? "Website" : "Licensed / API only"}</span></div>
      ${s.l ? `<span class="sl">${esc(s.l)}</span>` : ""}
      ${link ? `<a class="slink" href="${esc(link)}" target="_blank" rel="noopener">${s.r ? "RSS" : "Web"}</a>` : ""}
    </div>`;
    })
    .join("");
  panel.classList.remove("open");
  spanel.classList.add("open");
  spanel.querySelector(".pscroll").scrollTop = 0;
}
document.getElementById("s-close").onclick = () => spanel.classList.remove("open");
addEventListener("keydown", (e) => {
  if (e.key === "Escape") spanel.classList.remove("open");
});

/* ------------------------------------- article panel + reader translation -- */
const panel = document.getElementById("panel");
const ptrans = document.getElementById("ptrans");
const tRead = document.getElementById("t-de");
const tOrig = document.getElementById("t-orig");
const tTarget = document.getElementById("t-target");

let curArticle = null;
let curCountry = null;
let curMode = "read"; // "read" = reader's language, "orig" = as published
let curTranslation = null;
let panelToken = 0;

function readerLangName(code) {
  return LANGS[code] || code.toUpperCase();
}

/** Fills the target-language selector from what the server can actually do. */
function buildTargetOptions() {
  const targets = TRANSLATE.targets && TRANSLATE.targets.length ? TRANSLATE.targets : [READER.lang];
  const seen = new Set();
  tTarget.innerHTML = "";
  for (const code of [READER.lang, ...targets]) {
    if (seen.has(code)) continue;
    seen.add(code);
    const o = document.createElement("option");
    o.value = code;
    o.textContent = `→ ${readerLangName(code)}${LANGEN[code] ? ` (${LANGEN[code]})` : ""}`;
    if (code === READER.lang) o.selected = true;
    tTarget.appendChild(o);
  }
  if (!TRANSLATE.enabled) {
    const o = document.createElement("option");
    o.value = "";
    o.disabled = true;
    o.textContent = "— translation provider not configured —";
    tTarget.appendChild(o);
  }
  tTarget.disabled = !TRANSLATE.enabled;
}

function renderPanelContent() {
  const a = curArticle;
  if (!a) return;
  const t = curTranslation;
  const showTranslation = curMode === "read" && t;
  const c = showTranslation ? t : a.orig;

  document.getElementById("p-title").textContent = c.title;
  // the teaser stands in for the lede until the full article has loaded
  document.getElementById("p-lede").textContent = c.lede || c.teaser || "";
  document.getElementById("p-text").innerHTML = (c.body || []).map((p) => `<p>${esc(p)}</p>`).join("");

  const note = document.getElementById("tnote");
  if (curMode === "read") {
    if (!t) note.textContent = `Translating from ${LANGEN[a.lang] || a.lang.toUpperCase()} to ${readerLangName(READER.lang)} …`;
    else if (t.reason)
      note.textContent = `Showing the original (${readerLangName(a.lang)}) — ${t.reason} · ${a.src}`;
    else
      note.textContent =
        `Automatically translated from ${LANGEN[a.lang] || a.lang.toUpperCase()} to ` +
        `${readerLangName(t.lang)} · Original: ${a.src}`;
  } else {
    note.textContent = `Original text (${readerLangName(a.lang)}) · ${a.src}`;
  }

  tRead.classList.toggle("active", curMode === "read");
  tOrig.classList.toggle("active", curMode === "orig");
}

/**
 * Cards travel without their body text, so opening the panel fetches the full
 * article — and, in the same round trip, its translation into the reader's
 * language.
 */
async function loadArticle(a, to, token) {
  try {
    const res = await fetch(`/api/article/${encodeURIComponent(a.id)}?to=${encodeURIComponent(to)}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (token !== panelToken) return; // a newer article was opened meanwhile
    curArticle = { ...a, ...data };
    curTranslation = data.translation || null;
    document.getElementById("p-read").textContent =
      Math.max(2, Math.round((curArticle.orig.body || []).join(" ").length / 900)) + " min read";
    ptrans.classList.toggle("show", curArticle.lang !== READER.lang);
    renderPanelContent();
  } catch (err) {
    if (token !== panelToken) return;
    curTranslation = { ...curArticle.orig, lang: to, reason: "the article service could not be reached" };
    renderPanelContent();
  }
}

function openPanel(countryId, a) {
  curArticle = a;
  curCountry = countryId;
  curMode = "read";
  curTranslation = null;
  const token = ++panelToken;

  document.getElementById("p-src").textContent = a.src;
  document.getElementById("p-time").textContent = a.time;
  const hero = document.getElementById("p-img");
  hero.src = cardImage(a);
  hero.onerror = () => {
    hero.onerror = null;
    hero.src = placeholderImg(a);
  };
  document.getElementById("p-cat").textContent = a.cat;
  document.getElementById("p-country").textContent = NEWS[countryId]?.name || a.country || "";
  document.getElementById("p-read").textContent = "";

  const link = document.querySelector(".panel .porig");
  if (link) {
    link.href = a.url || "#";
    link.target = "_blank";
    link.rel = "noopener";
    link.onclick = null;
  }

  ptrans.classList.toggle("show", a.lang !== READER.lang);
  tOrig.textContent = "Original · " + readerLangName(a.lang);

  renderPanelContent();
  panel.classList.add("open");
  panel.querySelector(".pscroll").scrollTop = 0;

  loadArticle(a, READER.lang, token);
}

tRead.onclick = () => {
  curMode = "read";
  renderPanelContent();
  if (!curTranslation && curArticle) loadArticle(curArticle, READER.lang, panelToken);
};
tOrig.onclick = () => {
  curMode = "orig";
  renderPanelContent();
};
tTarget.onchange = () => {
  const to = tTarget.value;
  if (!to) return;
  READER = { ...READER, lang: to, langName: readerLangName(to), explicit: true };
  try {
    localStorage.setItem(LANG_KEY, to);
  } catch (e) {}
  curMode = "read";
  curTranslation = null;
  renderPanelContent();
  if (curArticle) loadArticle(curArticle, to, panelToken);
};
document.getElementById("p-close").onclick = () => panel.classList.remove("open");
addEventListener("keydown", (e) => {
  if (e.key === "Escape") panel.classList.remove("open");
});

mqMobile.addEventListener("change", () => {
  if (topic) renderTopicCards();
  else if (cityFocus) renderCityCards();
  else if (focusedId) renderCards(focusedId);
  else msheet.classList.remove("open");
});

/* ---------------------------------------------------------------- boot -- */
async function boot() {
  let saved = "";
  try {
    saved = localStorage.getItem(LANG_KEY) || "";
  } catch (e) {}

  const res = await fetch("/api/bootstrap" + (saved ? `?lang=${encodeURIComponent(saved)}` : ""));
  const data = await res.json();

  CATS = data.categories || CATS;
  LANGS = data.langNames || {};
  LANGEN = data.langNamesEn || {};
  NEWS = data.news || {};
  REGION = data.regions || {};
  CITIES = data.cities || [];
  CITY_ZOOM = typeof data.cityZoom === "number" ? data.cityZoom : CITY_ZOOM;
  WORLD = data.world || WORLD;
  READER = data.reader || READER;
  TRANSLATE = data.translate || TRANSLATE;
  regionIds = Object.keys(NEWS);

  qEl.placeholder = "Pick a country or search topics, outlets …";
  buildChips();
  buildTargetOptions();
  buildDropdown();
  initMap();

  if (!regionIds.length) {
    hint.querySelector("h4").textContent = "No stories yet";
    hint.querySelector("p").textContent =
      "The first ingest cycle is still running — headlines appear here as soon as the feeds respond. See /api/health for details.";
  }

  // The dropdown lists every country, not just the covered ones.
  fetch("https://cdn.jsdelivr.net/npm/world-countries@5.1.0/countries.json")
    .then((r) => r.json())
    .then((list) => {
      countries = list
        .map((c) => ({ name: c.name.common, ccn3: c.ccn3, ll: c.latlng ? [c.latlng[1], c.latlng[0]] : null }))
        .filter((c) => c.ll);
      buildDropdown(qEl.value);
    })
    .catch(() => {});
}

boot().catch((err) => {
  console.error("[global-news] boot failed", err);
  hint.querySelector("h4").textContent = "Could not reach the news service";
  hint.querySelector("p").textContent = String(err.message || err);
});
