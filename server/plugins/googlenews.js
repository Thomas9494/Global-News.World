import { fetchText, mapLimit } from "../lib/http.js";
import { parseFeed } from "../lib/feedparser.js";
import { config } from "../config.js";
import { REGIONS, CITIES, ccn3ForHostname, detectCity, routeCountry } from "../lib/geo.js";
import { langForCountry } from "../lib/geoip.js";

/**
 * Google News RSS — the open, key-less edition feeds.
 *
 * This is what makes the map global rather than a map of the 56 countries whose
 * press we have curated by hand. Google publishes a plain RSS edition for every
 * country and language, plus a search feed that can be scoped to a place, which
 * gives us:
 *
 *   • a headline feed for every country on earth
 *   • a local feed for every capital, so any capital can be zoomed into
 *
 * Every item names the publisher that actually wrote it (`<source url>`), and
 * that is what appears on the card — Google is the index, not the source. The
 * curated outlets in data/sources.json always take precedence; this plugin is
 * there to fill the gaps.
 *
 * Endpoints (documented public feeds, no key, no scraping):
 *   https://news.google.com/rss?hl=<lang>-<CC>&gl=<CC>&ceid=<CC>:<lang>
 *   https://news.google.com/rss/search?q=<place>&hl=…&gl=…&ceid=…
 */

const BASE = "https://news.google.com/rss";

function edition(cca2, lang) {
  return { hl: `${lang}-${cca2}`, gl: cca2, ceid: `${cca2}:${lang}` };
}

function countryUrl(cca2, lang) {
  return `${BASE}?${new URLSearchParams(edition(cca2, lang))}`;
}

function placeUrl(place, cca2, lang) {
  return `${BASE}/search?${new URLSearchParams({ q: place, ...edition(cca2, lang) })}`;
}

/**
 * Google appends the publisher to the headline: "Headline - the-star.co.ke".
 * The publisher belongs in the byline, not the headline.
 */
export function splitTitle(title, publisher) {
  const t = String(title || "").trim();
  if (!publisher) return t;
  const suffix = ` - ${publisher}`;
  return t.endsWith(suffix) ? t.slice(0, -suffix.length).trim() : t;
}

/**
 * The description of a Google News item is a list of links to related coverage,
 * not a teaser. Rendering it as one would be misleading, so it is dropped.
 */
function usableSummary() {
  return "";
}

const plugin = {
  id: "google-news",
  label: "Google News editions (open, no API key — worldwide coverage)",
  enabled: () => config.plugins.googleNews,

  /**
   * @param {{coverGaps: string[], onProgress?: Function}} ctx
   *   coverGaps — ccn3 codes with no curated outlet of their own.
   */
  async collect({ coverGaps = [], onProgress } = {}) {
    const scope = config.googleNews.scope;
    const ids = scope === "all" ? Object.keys(REGIONS) : coverGaps;

    /** @type {{url:string, ccn3:string, cca2:string, lang:string, city?:string, label:string}[]} */
    const targets = [];
    for (const ccn3 of ids) {
      const r = REGIONS[ccn3];
      if (!r?.cca2) continue;
      const lang = langForCountry(r.cca2) || "en";
      targets.push({
        url: countryUrl(r.cca2, lang),
        ccn3,
        cca2: r.cca2,
        lang,
        label: `Google News · ${r.name}`,
      });
    }

    // One local feed per capital, so every capital on the map has local news.
    if (config.googleNews.capitals) {
      const wanted = new Set(ids);
      for (const c of CITIES) {
        if (!c.capital || !wanted.has(c.ccn3)) continue;
        const r = REGIONS[c.ccn3];
        if (!r?.cca2) continue;
        const lang = langForCountry(r.cca2) || "en";
        targets.push({
          url: placeUrl(c.name, r.cca2, lang),
          ccn3: c.ccn3,
          cca2: r.cca2,
          lang,
          city: c.name,
          label: `Google News · ${c.name}`,
        });
      }
    }

    const capped = targets.slice(0, config.googleNews.maxRequests);
    const skippedForBudget = targets.length - capped.length;
    if (skippedForBudget > 0) {
      // never let a cap look like full coverage
      console.log(
        `[google-news] request budget reached: ${capped.length} of ${targets.length} feeds this cycle ` +
          `(raise GOOGLE_NEWS_MAX_REQUESTS to cover the rest)`
      );
    }

    const items = [];
    const health = [];
    let done = 0;
    let total = capped.length;

    const runPass = (batch) =>
      mapLimit(batch, config.googleNews.concurrency, async (t) => {
      const res = await fetchText(t.url, { timeoutMs: config.ingest.timeoutMs });
      let parsed = { format: "", meta: {}, items: [] };
      let error = res.error || (res.ok ? null : `HTTP ${res.status}`);
      if (res.ok && res.text) {
        parsed = parseFeed(res.text, res.contentType);
        if (parsed.error) error = `parse: ${parsed.error}`;
        else if (!parsed.items.length) error = "no items for this edition";
      }

      const record = {
        plugin: this.id,
        sourceKey: REGIONS[t.ccn3]?.name || t.cca2,
        outlet: t.label,
        url: t.url,
        ok: parsed.items.length > 0,
        skipped: false,
        status: res.status,
        format: parsed.format || "",
        items: parsed.items.length,
        ms: res.ms,
        error: parsed.items.length ? null : error,
      };

      let kept = 0;
      for (const raw of parsed.items) {
        if (kept >= config.googleNews.perFeed) break;
        // `source` carries the publisher; without it we cannot attribute, so skip
        const publisher = raw.sourceName || "";
        const title = splitTitle(raw.title, publisher);
        if (!title || !raw.link) continue;

        // --- is this actually local? ------------------------------------
        // A country edition is a national front page in name only: for small
        // countries Google fills it with the international wire. Pinning
        // "Trump signs an order" to Rwanda would be plainly wrong, so an item
        // is kept only when something ties it to the place.
        const publisherCcn3 = ccn3ForHostname(raw.sourceUrl || raw.link);
        const localPublisher = publisherCcn3 === t.ccn3;
        let city = "";

        if (t.byName) {
          const routed = routeCountry(title);
          if (!localPublisher && (!routed || routed.ccn3 !== t.ccn3)) continue;
        } else if (t.city) {
          // Place-scoped search. If the headline names the town, the story is
          // city news. If it does not but the masthead is local, it is still
          // that country's news — it just is not pinned to the town.
          const hit = detectCity(title, t.ccn3);
          if (hit && hit.city === t.city) city = t.city;
          else if (!localPublisher) continue;
        } else if (!localPublisher) {
          // a foreign masthead needs the story itself to be about this country
          if (publisherCcn3 && publisherCcn3 !== t.ccn3) continue;
          const routed = routeCountry(title);
          if (!routed || routed.ccn3 !== t.ccn3) continue;
        }
        kept++;

        items.push({
          title,
          link: raw.link,
          guid: raw.guid,
          summary: usableSummary(),
          content: "",
          published: raw.published,
          image: "",
          categories: [],
          author: "",
          lang: t.lang,
          src: publisher || "Google News",
          srcHome: raw.sourceUrl || "",
          sourceKey: REGIONS[t.ccn3]?.name || t.cca2,
          forceCcn3: t.ccn3,
          forceCity: city,
          catalogLang: t.lang,
          feedLang: t.lang,
          feedUrl: t.url,
          plugin: this.id,
          viaIndex: "Google News",
        });
      }

      // report what survived the locality check, not what Google returned
      record.items = kept;
      record.ok = kept > 0;
      if (!kept && !record.error) record.error = "nothing local to this place in the edition";
      health.push(record);
      onProgress?.(++done, total, record);
    });

    await runPass(capped);

    /**
     * Second pass. Some countries have no usable national edition and no press
     * indexed under their capital's name — small states and places whose
     * newsrooms all publish on .com domains. Searching the country's own name
     * finds them, and the same locality rules still apply.
     */
    const reached = new Set(items.map((i) => i.forceCcn3));
    const retry = [];
    for (const ccn3 of new Set(capped.map((t) => t.ccn3))) {
      if (reached.has(ccn3)) continue;
      const r = REGIONS[ccn3];
      if (!r?.cca2) continue;
      const lang = langForCountry(r.cca2) || "en";
      retry.push({
        url: placeUrl(r.name, r.cca2, lang),
        ccn3,
        cca2: r.cca2,
        lang,
        label: `Google News · "${r.name}"`,
        byName: true,
      });
    }
    if (retry.length) {
      total += retry.length;
      await runPass(retry);
    }

    return { items, health };
  },
};

export default plugin;
