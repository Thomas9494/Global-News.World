import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(__dirname, "..");

const bool = (v, d = false) => (v === undefined ? d : /^(1|true|yes|on)$/i.test(String(v)));
const num = (v, d) => (v === undefined || v === "" || Number.isNaN(Number(v)) ? d : Number(v));

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
      "Mozilla/5.0 (compatible; GlobalNewsBot/1.0; +https://github.com/global-news)",
  },

  plugins: {
    rss: bool(process.env.PLUGIN_RSS, true),
    cityPress: bool(process.env.PLUGIN_CITY_PRESS, true),
    googleNews: bool(process.env.PLUGIN_GOOGLE_NEWS, true),
    opml: bool(process.env.PLUGIN_OPML, true),
    gdelt: bool(process.env.PLUGIN_GDELT, false),
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
    provider: (process.env.TRANSLATE_PROVIDER || "none").toLowerCase(),
    target: (process.env.TRANSLATE_TARGET || "en").toLowerCase(),
    libreUrl: process.env.LIBRETRANSLATE_URL || "https://libretranslate.com",
    libreKey: process.env.LIBRETRANSLATE_KEY || "",
    deeplKey: process.env.DEEPL_KEY || "",
    deeplUrl: process.env.DEEPL_URL || "https://api-free.deepl.com",
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
