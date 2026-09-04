import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(__dirname, "..");

const bool = (v, d = false) => (v === undefined ? d : /^(1|true|yes|on)$/i.test(String(v)));
const num = (v, d) => (v === undefined || v === "" || Number.isNaN(Number(v)) ? d : Number(v));

/**
 * Which translation backend to use. Explicit names win; "auto" (the default)
 * prefers a paid key when one is configured and otherwise lands on "free" — a
 * chain of key-less public services — so translation works without any setup.
 */
function translateProvider() {
  const want = (process.env.TRANSLATE_PROVIDER || "auto").toLowerCase();
  if (want !== "auto") return want;
  if (process.env.DEEPL_KEY) return "deepl";
  if (process.env.LIBRETRANSLATE_KEY || process.env.LIBRETRANSLATE_URL) return "libretranslate";
  return "free";
}

/**
 * Public LibreTranslate instances that serve the API without a key. They are
 * volunteer-run and go up and down, which is why there is a list and why the
 * chain falls through to MyMemory. Source: the project's own mirror list,
 * https://docs.libretranslate.com/community/mirrors/
 */
const LIBRE_MIRRORS = ["https://translate.fedilab.app", "https://translate.cutie.dating"];

export const config = {
  port: num(process.env.PORT, 8787),
  host: process.env.HOST || "0.0.0.0",

  ingest: {
    intervalMin: num(process.env.INGEST_INTERVAL_MIN, 15),
    concurrency: num(process.env.INGEST_CONCURRENCY, 12),
    timeoutMs: num(process.env.FEED_TIMEOUT_MS, 15000),
    maxPerCountry: num(process.env.MAX_ARTICLES_PER_COUNTRY, 200),
    maxAgeHours: num(process.env.MAX_ARTICLE_AGE_H, 72),
    /**
     * Countries whose press produced nothing inside the normal window get a
     * longer one, so a quiet or thinly-indexed country still appears on the
     * map. The card always states the real age, so nothing is passed off as
     * fresh. 0 disables the second look.
     */
    quietCountryAgeHours: num(process.env.QUIET_COUNTRY_AGE_H, 336),
    onBoot: bool(process.env.INGEST_ON_BOOT, true),
    routeGlobalFeeds: bool(process.env.ROUTE_GLOBAL_FEEDS, true),
    userAgent:
      process.env.FEED_USER_AGENT ||
      "Mozilla/5.0 (compatible; GlobalNewsBot/1.0; +https://github.com/Thomas9494/Global-News.World)",
  },

  plugins: {
    rss: bool(process.env.PLUGIN_RSS, true),
    cityPress: bool(process.env.PLUGIN_CITY_PRESS, true),
    googleNews: bool(process.env.PLUGIN_GOOGLE_NEWS, true),
    opml: bool(process.env.PLUGIN_OPML, true),
    gdelt: bool(process.env.PLUGIN_GDELT, false),
    /**
     * On-demand news for a place the ingest has nothing for. Not an ingest
     * plugin — it answers a reader zooming in, see lib/citylive.js.
     */
    liveCity: bool(process.env.PLUGIN_LIVE_CITY, true),
    newsapi: bool(process.env.PLUGIN_NEWSAPI, false) && !!process.env.NEWSAPI_KEY,
    gnews: bool(process.env.PLUGIN_GNEWS, false) && !!process.env.GNEWS_KEY,
  },

  googleNews: {
    /** "gaps" — only countries without a curated outlet; "all" — every country. */
    scope: (process.env.GOOGLE_NEWS_SCOPE || "gaps").toLowerCase(),
    /** Also pull a place-scoped feed for each capital. */
    capitals: bool(process.env.GOOGLE_NEWS_CAPITALS, true),
    perFeed: num(process.env.GOOGLE_NEWS_PER_FEED, 12),
    concurrency: num(process.env.GOOGLE_NEWS_CONCURRENCY, 6),
    /** Hard ceiling on requests per cycle, so a wide scope cannot run away. */
    maxRequests: num(process.env.GOOGLE_NEWS_MAX_REQUESTS, 420),
  },

  cityPress: {
    /** Items taken per local outlet — city desks publish a lot. */
    perFeed: num(process.env.CITY_PRESS_PER_FEED, 10),
  },

  /**
   * On-demand news for any place on earth, fetched when a reader zooms into a
   * town the ingest has nothing for. See server/lib/citylive.js.
   */
  liveCity: {
    /** Stories taken per index (Google News, GDELT) per place. */
    perPlace: num(process.env.LIVE_CITY_PER_PLACE, 12),
    /**
     * A small town publishes little. Google's index for one is mostly weeks
     * old, so the window is far wider than the ingest's — the card always
     * states the real age, and a month-old story about the place beats nothing
     * about the place.
     */
    maxAgeHours: num(process.env.LIVE_CITY_AGE_H, 720),
    /** Turn a map point into a place name via the key-less reverse geocoders. */
    geocode: bool(process.env.LIVE_CITY_GEOCODE, true),
  },

  opml: {
    /** A local OPML file and/or a remote one; both optional. */
    file: process.env.OPML_FILE || "data/feeds.opml",
    url: process.env.OPML_URL || "",
  },
  keys: {
    newsapi: process.env.NEWSAPI_KEY || "",
    gnews: process.env.GNEWS_KEY || "",
  },

  translate: {
    /**
     * "auto" picks the best provider whose credentials are actually present,
     * and falls back to the free chain — services that translate without a
     * signup, so a fresh clone can read foreign press out of the box.
     */
    provider: translateProvider(),
    target: (process.env.TRANSLATE_TARGET || "en").toLowerCase(),
    libreUrl: process.env.LIBRETRANSLATE_URL || "https://libretranslate.com",
    libreKey: process.env.LIBRETRANSLATE_KEY || "",
    /** Key-less LibreTranslate instances the free chain tries before MyMemory. */
    libreMirrors: (process.env.LIBRETRANSLATE_MIRRORS || LIBRE_MIRRORS.join(","))
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    timeoutMs: num(process.env.TRANSLATE_TIMEOUT_MS, 20000),
    deeplKey: process.env.DEEPL_KEY || "",
    deeplUrl: process.env.DEEPL_URL || "https://api-free.deepl.com",
    myMemoryUrl: process.env.MYMEMORY_URL || "https://api.mymemory.translated.net",
    /**
     * Handing MyMemory an address lifts the anonymous 5 000 characters a day to
     * 50 000. There is no registration and no verification — the address is
     * simply sent with the request, so it is a setting, not a credential.
     */
    myMemoryEmail: process.env.MYMEMORY_EMAIL || "",
    myMemoryKey: process.env.MYMEMORY_KEY || "",
    budgetChars: num(process.env.TRANSLATE_BUDGET_CHARS, 200000),
  },

  paths: {
    data: join(ROOT, "data"),
    catalog: join(ROOT, "server/catalog"),
    store: join(ROOT, "data/store.json"),
    report: join(ROOT, "data/feed-report.json"),
    public: join(ROOT, "public"),
  },
};
