<div align="center">

<img src="public/assets/global-news-logo.svg" alt="Global News" width="260">

**An interactive world map of live local news — read what a country reads about itself.**

[Why this exists](#why-this-exists) · [How it works](#how-it-works) · [Quick start](#quick-start) · [API](#http-api) · [Write a plugin](#writing-a-news-plugin) · [Contributing](CONTRIBUTING.md)

![license](https://img.shields.io/badge/license-MIT-0052cc) ![node](https://img.shields.io/badge/node-%E2%89%A520.6-0d9488) ![countries](https://img.shields.io/badge/countries-192%2F194%20UN%20members-0052cc) ![outlets](https://img.shields.io/badge/outlets-1034-0d9488) ![cities](https://img.shields.io/badge/cities-440%20live-0052cc) ![tests](https://img.shields.io/badge/tests-124-0d9488)

</div>

---

## Why this exists

Most people read the news through a single national lens. You learn what *your* country
thinks about a place — rarely what the place thinks about itself.

Global News is a world map you can zoom into. Get close enough to a country and the
latest stories from that country's own newsrooms pop up around it, in the language
they were published in, with a translation one click away in whatever language you
actually read.

Two everyday reasons that shaped every design decision:

**Before you travel.** You booked two weeks in Thailand, Kenya or Portugal. What is
actually going on there right now? Not the two paragraphs your national broadcaster ran
last month — the transport strike, the storm warning, the election, the new rules at the
border, the thing everyone in the country is talking about this week. Zoom in, read the
local press, in your language.

**When one story has many sides.** A conflict, a trade dispute, a climate summit, a
sporting scandal. Search the topic and the map stops moving: every matching story from
every country surfaces at once, so you can read the Ukrainian, the Russian, the German
and the Indian account of the same week side by side. The differences are the point.

Coverage is deliberately broad and English-first in its *reach* — the catalog favours
outlets that publish an English edition, and everything else is machine-translated on
demand — because the goal is that a reader anywhere can get to a local perspective
anywhere.

### The goal: a neutral view, not a national one

Whichever country you happen to live in, your picture of the world arrives pre-filtered:
its editors decide which countries are worth a correspondent, which stories lead, and
which framing is the obvious one. That filter is invisible precisely because it is the
only one you see.

Global News exists to remove it. Not by replacing one outlet's judgement with another's,
but by putting the sources next to each other and letting you go straight to the ground:

- **Zoom into any country** and read what its own newsrooms are reporting — not what
  yours reports about it.
- **Zoom further into any city** — Zurich, Lucerne, Lagos, Osaka — and the map narrows
  to that city's own press and the stories about it. Local news is where a place is most
  itself, and it is the layer that never crosses a border.
- **Search a topic** and the map holds still while every country's version of that story
  appears at once. Compare them yourself.

Nothing here re-writes, ranks or scores the news for you, and no algorithm decides what
you should think. Every card names its outlet, states its language, and links to the
original. The neutrality is structural: you are not being shown one country's view of the
world, you are being shown many, and which of them you trust is your call.

> **This is a reading tool, not a truth machine.** Every card names its outlet and
> links to the original. Some sources in the catalog are state-owned, some are partisan,
> some are excellent. Seeing them next to each other is the feature. Judgement stays
> with the reader.

---

## What it does

| | |
|---|---|
| 🗺️ **Zoom-to-read** | Get within range of a country and its live stories fan out around it, pinned to the city they are about. |
| 🏙️ **Zoom again for the local paper** | Close in on Zurich and you get the NZZ and the Tages-Anzeiger; on Lucerne, the Lucerne press; on Lagos, Osaka or Kigali, theirs. A city shows stories written *about* it and stories written *there*. |
| 🌍 **192 of 194 UN member states** | 1 034 curated outlets — 377 national, 657 local in 335 towns — plus open key-less indexes for the rest. Every capital on earth is in the gazetteer. |
| 🗣️ **Published language on the card** | Headlines stay in Thai, Ukrainian, Portuguese or German. That is what local reporting looks like. |
| 🔤 **Translated when you open it** | The article panel opens in the language you read. Your language is inferred from where you are — a visitor from the Netherlands gets Dutch — and you can override it. |
| 🔎 **One search box, three intents** | A country flies you there. A town flies you there. A topic or keyword keeps the map still and shows every matching story worldwide. |
| 🏷️ **13 topic filters** | Politics, Business, Sports, Culture, Digital, Science, Health, Lifestyle, Society, Entertainment, Opinion, Video, Regional. |
| 🔌 **Plugin-based ingest** | RSS/Atom/RDF/JSON Feed, OPML lists and Google News editions out of the box; GDELT, NewsAPI and GNews optional. Adding a source type is one file. |
| 📊 **Honest health reporting** | `npm run check:feeds` and `GET /api/health` tell you exactly which outlets responded and which are down, by name. |

**There is no sample data anywhere in this repository.** Every headline you see came
out of a real feed minutes ago. Start it with no network and you get an empty map and an
explanation, not a demo.

---

## How it works

```
                 ┌─────────────────────────────────────────────┐
   data/         │  sources.json       377 national outlets     │
   catalog       │  city-sources.json  657 local outlets, 335   │
                 │                     towns, 188 countries     │
                 │  cities.json        573 places + 523 names   │
                 │  outlet-cities.json where each newsroom sits │
                 └────────────────────┬────────────────────────┘
                                      │
  ┌───────────────────────────────────▼───────────────────────────────────┐
  │  INGEST  (every 15 min, server/ingest.js)                             │
  │                                                                       │
  │   plugins ─▶ normalise ─▶ locate ─▶ classify ─▶ dedupe ─▶ cap ─▶ store│
  │   rss        strip html   country   13 topics   url +    fair   memory│
  │   city-press charset fix  + city    keyword     headline share  + json│
  │   opml       dates        + where   scoring              per     snap │
  │   google-news             the paper                      city         │
  │   gdelt/…                 sits                                        │
  └───────────────────────────────────┬───────────────────────────────────┘
                                      │
  ┌───────────────────────────────────▼───────────────────────────────────┐
  │  HTTP API  (server/routes/api.js)                                     │
  │   /api/bootstrap   the whole map in one ~250 kB gzipped payload       │
  │   /api/article/:id full text + translation into the reader's language │
  │   /api/search      country · place · topic routing                    │
  │   /api/city        one town's own press                               │
  │   /api/health      per-outlet status                                  │
  └───────────────────────────────────┬───────────────────────────────────┘
                                      │
  ┌───────────────────────────────────▼───────────────────────────────────┐
  │  CLIENT  (public/index.html + app.js)                                 │
  │   MapLibre GL · OpenFreeMap tiles · no framework, no build step       │
  └───────────────────────────────────────────────────────────────────────┘
```

### The pipeline, in detail

**Collect.** Each enabled plugin fetches its endpoints in parallel (12 at a time by
default) and returns raw items plus one health record per endpoint. The RSS plugin
handles RSS 2.0, RSS 1.0/RDF, Atom and JSON Feed, and decodes whatever charset the
server declares — a good number of national outlets still ship `windows-1251` or
`iso-8859-1`.

**Normalise.** HTML is stripped, entities decoded, dates parsed from the half-dozen
formats feeds emit, images pulled from `media:content` / `enclosure` / `itunes:image` /
inline `<img>`. Anything without a title or a link is dropped.

**Locate.** An article from a national outlet belongs to that outlet's country. An
article from a worldwide wire — Reuters, BBC World, allAfrica, EFE América — is routed
to the country it is *about*, by matching country names, demonyms and 491 places
(including native spellings: *Luzern* → Lucerne, *Київ* → Kyiv, *المنامة* → Manama).
Routing is conservative: no confident match, no article.

Then the article gets **two** places, which is what makes the city zoom work:

- the place the story is *about*, taken from the headline
- the place the newsroom *sits*, from [`data/outlet-cities.json`](data/outlet-cities.json)
  and from the masthead itself — *Luzerner Zeitung* names its own city, *NZZ* does not
  and is listed

A story with neither sits at the country centroid.

**Know which country you are over.** The map decides the focused country from the
country outlines that ship with `world-countries`, not from whichever centre is nearest.
Nearest-centre is the wrong question: over Munich, Austria's centre is closer than
Germany's, and over Lagos, Benin's, Togo's and Niger's all beat Nigeria's. Where two
outlines overlap, the nearest known town settles it. If the reader is over a country but
still zoomed too far out for it, the map shows nothing rather than a neighbour.

**Share out fairly.** A country is capped at 200 stories, but Zurich publishes far more
than Chur and would otherwise take every slot. So the cap is filled by round-robin over
the towns — the newest story from each place, then the next — which is what makes zooming
into a small town find anything at all.

**Classify.** A weighted keyword scorer across the languages the feeds actually publish
in, reading the feed's own category (weight 6), the URL path (4), the headline (3) and
the summary (1). Word-boundary aware and accent-insensitive, so *war* does not fire on
*warm*. Unmatched general news lands in *Society*.

**De-duplicate.** By canonical URL first — tracking parameters stripped — then by
normalised headline within a country, because the same wire story reaches the map
through several outlets.

**Translate.** Not here. Articles are stored exactly as published; translation happens
per request, in the reader's language, and is cached. See below.

### Reader language

The map shows local reporting in the local language. The *translation* is personal, so it
is resolved per request, strongest signal first:

1. an explicit choice (`?lang=nl`, remembered in `localStorage`)
2. a CDN geo header — `cf-ipcountry`, `x-vercel-ip-country`, `cloudfront-viewer-country`, …
3. an optional IP lookup (`GEOIP_PROVIDER=ipapi`, **off by default**)
4. the browser's `Accept-Language`
5. `TRANSLATE_TARGET`, else English

A visitor from the Netherlands is offered Dutch; from Brazil, Portuguese; from Japan,
Japanese. No IP address is stored — the lookup yields a country code that lives for the
duration of the request, and the result is cached by country, not by person.

Translation itself is pluggable and **disabled by default**, because it needs a service
you control:

```bash
TRANSLATE_PROVIDER=libretranslate   # self-hosted or a public instance
TRANSLATE_PROVIDER=deepl            # DEEPL_KEY=…
TRANSLATE_PROVIDER=none             # default: everything stays as published
```

With no provider the panel says so and shows the original — it never silently pretends
a translation happened.

### Reaching every country

56 hand-curated countries leave most of the world blank, so two open, key-less indexes
fill the rest. They run **after** the curated feeds and only where something is missing:

| | |
|---|---|
| **Google News editions** | A public RSS edition exists for every country and language, and a search feed can be scoped to a place — which is how every capital on earth becomes zoomable. |
| **GDELT DOC 2.0** | A second key-less index, off by default because some networks block it. |
| **OPML** | Your own subscription list. Export from any feed reader, point `OPML_FILE` at it. |
| **A spreadsheet** | `npm run import:media -- list.xlsx` reads a city-level media list, checks every feed, and writes the ones that answer into `data/city-sources.json`. |

An index is not a source, and the map never pretends otherwise: every card names the
newsroom that wrote the story, taken from the feed's own `<source>` element.

**Country editions are checked before they are believed.** For a small country Google
fills its national edition with the international wire, and pinning *"Trump signs an
order"* to Rwanda would be simply false. So an item survives only if:

- the publisher's domain says it sits in that country (`.co.ke` → Kenya), **or**
- the story itself is about that country, by the same routing used for the wires

For place-scoped feeds the headline has to name the place, otherwise the story is kept
as country news rather than pinned to a town it may have nothing to do with.

**Where this gets to:** **192 of 194 UN member states** and around 228 territories carry
live news, across **440 towns and cities**. The handful that do not — Eritrea and
Micronesia, and on a quiet day one or two Caribbean microstates — have little or no
indexed online press. They are a standing invitation: if you know an outlet there,
[add it](CONTRIBUTING.md).

---

## Quick start

```bash
git clone https://github.com/Thomas9494/Global-News.World.git
cd Global-News.World
npm install
npm run build:catalog     # derives country centroids and zoom levels
npm run ingest            # first fetch — about 80 s for 358 outlets
npm start                 # http://localhost:8787
```

`npm start` runs the ingest scheduler itself, so in normal use `npm run ingest` is only
needed to fill the map before the first cycle finishes.

Requires **Node ≥ 20.6**. Three runtime dependencies: `express`, `fast-xml-parser`,
`compression` (plus `world-countries` as build data). No build step, no bundler, no
framework.

### Configuration

Copy `.env.example` to `.env`. Everything has a working default; the knobs that matter:

| Variable | Default | What it does |
|---|---|---|
| `PORT` | `8787` | HTTP port |
| `INGEST_INTERVAL_MIN` | `15` | Minutes between ingest cycles; `0` disables the scheduler |
| `INGEST_CONCURRENCY` | `12` | Parallel feed fetches — be kind to small outlets |
| `MAX_ARTICLE_AGE_H` | `72` | Drop anything older; `0` keeps everything |
| `MAX_ARTICLES_PER_COUNTRY` | `120` | Store cap per country |
| `ROUTE_GLOBAL_FEEDS` | `true` | Route worldwide wire copy to the country it is about |
| `QUIET_COUNTRY_AGE_H` | `336` | Longer window for countries that would otherwise be blank; the card still states the real age |
| `PLUGIN_GOOGLE_NEWS` | `true` | Open, key-less coverage for countries and capitals with no curated outlet |
| `GOOGLE_NEWS_SCOPE` | `gaps` | `gaps` = only uncovered countries · `all` = every country |
| `PLUGIN_OPML` | `true` | Import feeds from an OPML subscription list |
| `PLUGIN_CITY_PRESS` | `true` | Local outlets keyed by the town they publish in |
| `TRANSLATE_PROVIDER` | `none` | `none` · `libretranslate` · `deepl` |
| `TRANSLATE_TARGET` | `en` | Fallback reading language |
| `GEOIP_PROVIDER` | *(unset)* | `ipapi` or `ip-api` — only needed without a CDN geo header |
| `PLUGIN_GDELT` | `false` | Free, key-less worldwide coverage for countries with no curated outlet |
| `INGEST_TOKEN` | *(unset)* | Enables `POST /api/ingest`; without it the endpoint is closed |

### Commands

```bash
npm start              # server + scheduler
npm run dev            # same, with --watch
npm run ingest         # one cycle, then exit  (good for cron)
npm run check:feeds    # health-check every outlet, write data/feed-report.json
npm run check:feeds -- --failures          # only what is broken
npm run check:feeds -- --country=Kenya     # one country
npm run build:catalog  # regenerate server/catalog/countries.json
npm run import:media -- list.xlsx          # import a city media list from a spreadsheet
npm test               # 84 tests: pipeline, API and frontend
```

---

## HTTP API

| Endpoint | Purpose |
|---|---|
| `GET /api/bootstrap` | Everything the map needs to draw: regions, cards per country, topic counts, reader language. ~250 kB gzipped. |
| `GET /api/news?country=&cat=&q=&lang=&city=&limit=` | Filtered card list. |
| `GET /api/article/:id?to=nl` | One article with full body, plus a translation into the reader's language. |
| `POST /api/translate` | `{ ids: [...], to: "nl" }` — batch translation for headline previews. |
| `GET /api/search?q=` | Returns `type: "country" \| "place" \| "topic"` and what to do with it. |
| `GET /api/city?name=Lucerne` | One town's own press: stories about it, plus stories from newsrooms based there. |
| `GET /api/places?q=` | Town lookup from the gazetteer. |
| `GET /api/sources[?country=]` | The outlet catalog, keyed by the country names the map uses. |
| `GET /api/countries` | Which countries currently have coverage. |
| `GET /api/me` | The reading language this visitor gets, and how that was decided. |
| `GET /api/health` | Per-outlet status, failures by name, translation cache stats. |
| `GET /api/plugins` · `GET /api/config` | Registry and effective settings. |
| `POST /api/ingest` | Manual cycle. Requires `INGEST_TOKEN` and the `x-ingest-token` header. |
| `GET /sources.js` | The catalog as `window.NEWS_SOURCES`, for the page. |

<details>
<summary>An article, in full</summary>

```jsonc
{
  "id": "1g7bsws",
  "url": "https://www.srf.ch/news/…",
  "src": "SRF News",
  "ccn3": "756",
  "country": "Switzerland",
  "cat": "Politics",
  "lang": "de",
  "city": "Bern",                // the place the story is about
  "srcCity": "Zurich",           // the place the newsroom sits
  "ll": [7.44, 46.95],
  "img": "https://…/picture.jpg",
  "publishedAt": "2026-08-28T09:15:00.000Z",
  "time": "12 min ago",
  "routedFrom": null,            // set when a worldwide wire was routed here
  "orig": {                      // exactly as published
    "title": "Bundesrat einigt sich auf Kompromiss mit der EU",
    "teaser": "Nach monatelangen Verhandlungen …",
    "lede":   "Nach monatelangen Verhandlungen liegt …",
    "body":   ["Der Bundesrat hat am Mittwoch …", "…"]
  },
  "reader":      { "lang": "nl", "langName": "Nederlands", "via": "cf-ipcountry" },
  "translation": { "lang": "nl", "title": "Bondsraad bereikt …", "provider": "libretranslate", "cached": false }
}
```
</details>

---

## Writing a news plugin

A plugin is one file in `server/plugins/` exporting four things:

```js
export default {
  id: "my-source",
  label: "My national wire",
  enabled: () => Boolean(process.env.PLUGIN_MY_SOURCE),

  async collect({ sources, coverGaps, onProgress }) {
    return {
      items: [ /* raw articles — see below */ ],
      health: [ /* one record per endpoint you touched */ ],
    };
  },
};
```

Register it in `server/plugins/index.js` and you are done — locating, classifying,
de-duplicating, translating and serving all happen downstream.

<details>
<summary>The two shapes</summary>

```js
// an item
{
  title, link, summary, content, published,   // strings
  image, author, lang,                         // strings, may be ""
  categories: [],                              // the feed's own labels
  src: "Outlet name",                          // shown on the card
  srcHome: "https://outlet.example/",
  sourceKey: "Kenya",                          // a country name, or a group like "Global"
  forceCcn3: "404",                            // optional: skip country detection
  plugin: "my-source",
}

// a health record
{
  plugin, sourceKey, outlet, url,
  ok: true, skipped: false, status: 200,
  items: 25, ms: 340, error: null,
}
```

`sourceKey` decides where the article lands. A country name pins it to that country; a
group key (`Global`, `EU`, `Africa (regional)`, `Latin America (regional)`) hands it to
the router, which reads the headline and works out which country it is about.
</details>

**Shipped:** `rss` (RSS 2.0 / RSS 1.0 / Atom / JSON Feed), `opml`, `google-news`,
`gdelt`, `newsapi`, `gnews`.

**Ideas that would be genuinely useful:** national wire APIs, Mastodon and Bluesky
accounts of newsrooms, news sitemaps, public-broadcaster APIs, government press-release
feeds, community radio, and — most of all — a plugin for a country nobody has covered yet.

## Adding a news source

You do not need to write code.

For a **national** outlet, add an object to the right country in
[`data/sources.json`](data/sources.json):

```jsonc
{ "m": "Outlet name", "l": "EN", "r": "https://outlet.example/feed", "w": "https://outlet.example/" }
```

`m` outlet · `l` language tag · `r` feed URL (empty if there is none) · `w` homepage.

Then check it actually works:

```bash
npm run check:feeds -- --country=Kenya
```

For a **local** paper, add it to [`data/city-sources.json`](data/city-sources.json) under
its country and town — the town must exist in
[`data/cities.json`](data/cities.json), which is what puts it on the map:

```jsonc
{ "Switzerland": { "Chur": [ { "m": "Bündner Tagblatt", "l": "DE", "r": "…", "w": "…" } ] } }
```

Have a whole spreadsheet of them? Import it in one go — every feed is checked before it
is written, and the ones that fail are listed with a reason:

```bash
npm run import:media -- your-media-list.xlsx
```

If it returns items, open a pull request. See [CONTRIBUTING.md](CONTRIBUTING.md) for what
makes a good source.

---

## Project layout

```
data/            sources.json        national outlets, by country
                 city-sources.json   local outlets, by country and town
                 cities.json         573 places + 523 native spellings
                 outlet-cities.json  which city each newsroom sits in
server/
  ingest.js      the pipeline
  app.js         express app          index.js  entry point + scheduler
  config.js      every env var in one place
  plugins/       rss · citypress · opml · googlenews · gdelt · newsapi · gnews
  lib/           feedparser · http · text · lang · categorize · geo
                 geoip · translate · articletranslate · store
  routes/api.js  the HTTP API
  catalog/       generated — do not edit by hand
public/          index.html (the design) · app.js (the client) · assets/
scripts/         build-catalog · ingest-once · check-feeds · import-media-list
                 lib/xlsx.mjs  a dependency-free .xlsx reader
test/            pipeline · api · client (jsdom) · coverage
```

`public/index.html` is the design's markup and stylesheet, byte for byte. All client
behaviour lives in `public/app.js`.

---

## Testing

```bash
npm test
```

124 tests, no network required:

- **pipeline** — parsers for all four feed formats, charset decoding, entity-heavy feeds, date shapes, language identification, topic classification, place resolution, de-duplication, reader-language detection
- **api** — every endpoint, including all three search intents, city filtering and the sources contract
- **coverage** — that every country has a region, every UN member has its capital in the gazetteer, every alias and every city in the catalog points at a real place, that a country's cap leaves room for its small towns, and that every plugin honours the contract
- **client** — the real `index.html` and `app.js` in a DOM with a stubbed map: chips, country focus, **city focus**, card layout, city dots, the article panel and its translation toggle, the sources panel, search routing, zoom controls

Feed health is checked separately, because it depends on the outside world:

```bash
npm run check:feeds
```

Current state of the curated catalog: **~74 % of fetchable endpoints return items.** The
rest are outlets behind a WAF that refuses bots, feeds that have moved, and a handful
documented as licensed-only with no public feed. The report names every one of them.

---

## Deploying

Any Node host works. Behind a CDN, forward the client IP and the geo header so reader
language detection works.

```dockerfile
FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
RUN npm run build:catalog
EXPOSE 8787
CMD ["node", "server/index.js"]
```

For a serverless or read-only deployment, run `npm run ingest` on a cron and serve the
snapshot; set `INGEST_INTERVAL_MIN=0` so the web process does not fetch anything itself.

---

## Good citizenship

This project reads public feeds that outlets publish *for* reading. It behaves
accordingly:

- one honest User-Agent that says what it is and links here
- 12 parallel requests, one pass every 15 minutes
- headline, teaser and the summary the feed itself provides — never a scraped full text
- every card names its outlet and links to the original
- outlets that block bots stay blocked; there is no evasion in this codebase, and pull
  requests adding any will be declined

If you run an outlet in the catalog and want out, open an issue and it comes out.

---

## Roadmap

- [ ] Reader-language headlines on the cards, on request (batch translation exists; the toggle does not)
- [ ] Curated outlets for the last countries still without any
- [ ] Neighbourhood-level zoom in the largest cities
- [ ] Cluster cards when several stories share a city
- [ ] "Same story, other countries" — link routed duplicates across borders
- [ ] Saved topics and a lightweight digest
- [ ] Offline/PWA mode for travelling
- [ ] Full-text extraction where the outlet's licence allows it
- [ ] More languages in the topic classifier — it is weakest outside Europe

Pick one, or bring your own. See [CONTRIBUTING.md](CONTRIBUTING.md).

---

## Credits

Map tiles by [OpenFreeMap](https://openfreemap.org/) from
[OpenStreetMap](https://www.openstreetmap.org/copyright) data · rendering by
[MapLibre GL](https://maplibre.org/) · country data from
[world-countries](https://github.com/mledoze/countries) · type set in
[Inter](https://rsms.me/inter/).

News content belongs to the outlets that published it and is shown as headline, teaser
and link, as feeds are intended to be used.

## Licence

[MIT](LICENSE) — the code. The news is not ours to license.
