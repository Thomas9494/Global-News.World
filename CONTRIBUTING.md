# Contributing to Global News

**Everyone is welcome here, and you do not have to be a programmer.**

Global News is a map of what the world is reading about itself. Building that well needs
more than code: it needs people who know a country's media landscape, people who speak
the languages, people who care about how it looks and reads, and people who will simply
tell us when something is broken. Every one of those is a real contribution, and every
one of them is credited the same way.

Find yourself below and start there.

---

## Pick your lane

### 🌍 You know a country's press

**This is the single most valuable thing you can do**, and it needs no code.

57 countries are curated by hand; the rest of the world reaches the map through open
indexes, which is coverage but not the same as knowing a country's press. Where we do
have curated outlets it is often two or three deep and skewed towards the
English-language edition. If you know which papers people in your country actually read
— including the regional ones, the independent ones and the ones in your own language —
you know something this project cannot get anywhere else.

**A couple of UN member states still have no live news at all**, because their press is
barely indexed online — **Eritrea and Micronesia**, and on a quiet day one or two
Caribbean microstates. One working feed closes one of those gaps permanently.

**The bigger gap is local.** 440 towns currently have their own press on the map; there
are thousands more. A city paper is the most useful thing you can add, because it is the
layer nobody else aggregates.

**A national outlet** goes in [`data/sources.json`](data/sources.json), under its country:

```jsonc
{ "m": "Outlet name", "l": "SW", "r": "https://outlet.example/feed", "w": "https://outlet.example/" }
```

`m` outlet name · `l` language tag · `r` RSS/Atom URL (`""` if there is none) · `w` homepage

**A local paper** goes in [`data/city-sources.json`](data/city-sources.json), under its
country *and its town*. The town has to exist in
[`data/cities.json`](data/cities.json) — if it does not, add it there first with its
coordinates, which is what lets the map zoom to it:

```jsonc
{ "Switzerland": { "Chur": [ { "m": "Bündner Tagblatt", "l": "DE", "r": "…", "w": "…" } ] } }
```

**A whole spreadsheet** of them can be imported at once. Every feed is fetched before it
is written, so nothing enters the catalog that does not actually answer, and the
rejections land in `data/city-sources-rejected.json` with a reason:

```bash
npm run import:media -- your-media-list.xlsx
```

The sheet needs the columns `Land`, `ISO`, `Stadt`, `Medium`, `Sprache`, `Website` and
`RSS-Feed-URL` (English headings work too).

Then check it and open a pull request saying, in a sentence, what the outlet is:

```bash
npm run check:feeds -- --country=Kenya
```

**What makes a good source:** a real newsroom with a masthead; a feed that updates at
least daily; something a person in that country would recognise. Mix broadsheet and
tabloid, national and regional, state and independent — the point of this project is
that you can see them next to each other.

**What we will decline:** content farms and pure aggregators, feeds that are only
headlines with no link, sites that require a login to read anything, and anything whose
purpose is to push a single line rather than report. State broadcasters are welcome —
labelled as what they are.

### 🗣️ You speak a language we handle badly

- **Topic classification** lives in [`server/lib/categorize.js`](server/lib/categorize.js)
  as plain keyword lists. It is decent in English, German, French, Spanish, Italian and
  Portuguese, and weak everywhere else. Adding twenty words in Thai, Bengali, Persian,
  Tagalog or Ukrainian measurably improves the map. No algorithms involved — it is a list.
- **Language identification** is in [`server/lib/lang.js`](server/lib/lang.js): fifteen
  stop-words per language. If your language is misdetected, that is the file.
- **Place names** are in [`data/cities.json`](data/cities.json) — 491 places, every
  national capital among them. The `aliases` block maps what newsrooms actually write
  (*Luzern*, *Київ*, *المنامة*, *Ulan Bator*) to the map's label. A capital that a local
  feed spells differently is invisible until someone adds that spelling, so missing
  cities and missing spellings are both worth a pull request.
- **Translation quality** — if the machine translation into your language is producing
  nonsense for news copy, tell us in an issue with an example. It shapes which providers
  we recommend.

### 🎨 You design

The interface came from a finished design and `public/index.html` reproduces it exactly.
That is a starting point, not a ceiling. Places it is genuinely weak:

- the mobile bottom sheet does very little with the space it has
- there is no dark mode
- topic-search results tile onto a grid; a smarter layout could keep them nearer the
  places they came from
- accessibility has not had a serious pass — focus order, contrast, screen-reader labels,
  reduced-motion beyond the one media query

Mock it up, open an issue with a picture, and we will talk before anyone writes code.

### 💻 You write code

The stack is deliberately boring so that it stays approachable: Node, Express, vanilla
JavaScript, no build step, no framework, three runtime dependencies. If you can read
JavaScript you can read all of it in an afternoon.

Good places to start:

- `good first issue` on the tracker
- **write a plugin** — a national wire API, newsroom Mastodon or Bluesky accounts, news
  sitemaps. The contract is four functions; see [README](README.md#writing-a-news-plugin).
- **the roadmap** in the README
- **fix a dead feed** — run `npm run check:feeds -- --failures`, find the outlet's current
  URL, send the one-line change

Ground rules: keep the dependency count near zero; keep `public/index.html` matching the
design unless the change is deliberate and discussed; add a test with behaviour changes;
match the surrounding style (Prettier defaults, 110 columns, comments that explain *why*).

### 📊 You work with data

- The topic classifier could be evaluated properly instead of by eye. A labelled sample
  and a precision/recall number would be a real contribution.
- Country routing for worldwide wire copy is a scored heuristic
  ([`server/lib/geo.js`](server/lib/geo.js)) and nobody has measured how often it is wrong.
- Duplicate detection is exact-match on normalised headlines; near-duplicate detection
  across outlets and languages is an open problem here.

### 🧭 You just use it

Bug reports are contributions. Tell us the country, what you searched, what you expected
and what you got. If a headline landed in the wrong country or the wrong topic, that is
exactly the kind of report that makes this better — paste the headline.

### 📝 You write

The README is long; the code comments are honest but uneven. Tutorials, a
self-hosting guide, translations of the README, or an explainer for people who want to
run this for a newsroom or a classroom — all welcome.

---

## Working on it

```bash
git clone https://github.com/Thomas9494/Global-News.World.git
cd Global-News.World
npm install
npm run build:catalog
npm run ingest          # real feeds, ~80 s
npm start               # http://localhost:8787
npm test                # 124 tests, no network needed
```

`npm test` must pass before you open a pull request. `npm run check:feeds` talks to the
outside world, so it is not part of the suite and does not need to be green — outlets go
down on their own schedule.

### Pull requests

Small and focused beats large and comprehensive. Title says what changed. Description
says why. If it changes behaviour, it comes with a test. If it changes the interface,
it comes with a screenshot.

You keep the copyright on what you write; contributions are under the
[MIT licence](LICENSE), same as the rest.

---

## The one principle

**No invented content, ever.**

There is no sample data in this repository and there must never be. If the feeds are
down, the map is empty and `/api/health` explains why — that is correct behaviour, not a
bug to paper over with a placeholder story. If a translation provider is not configured,
the panel says so and shows the original rather than pretending. If country routing is
not confident, the article is dropped rather than guessed into place.

A reader has to be able to trust that everything on this map is something a real
newsroom actually published. Nothing is worth breaking that.

---

## Conduct

Be decent to each other. The full text is in
[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

One thing specific to this project: the catalog spans countries at war with each other
and outlets that despise each other. Argue about whether a source belongs — that is a
legitimate, useful argument — but keep it about the source. Political fights between
contributors are out of scope, and moderated as such.
