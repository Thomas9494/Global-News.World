import { fetchText, mapLimit } from "../lib/http.js";
import { config } from "../config.js";
import { REGIONS } from "../lib/geo.js";

/**
 * GNews.io top headlines. Optional: PLUGIN_GNEWS=true and GNEWS_KEY=…
 * Off by default; the curated RSS list is the primary source.
 */
const COUNTRIES = new Set(
  "au br ca cn eg fr de gr hk in ie il it jp nl no pk pe ph pt ro ru sg es se ch tw ua gb us".split(" ")
);

const plugin = {
  id: "gnews",
  label: "GNews.io top headlines",
  enabled: () => config.plugins.gnews,

  async collect({ coverGaps = [], onProgress } = {}) {
    const targets = coverGaps
      .map((ccn3) => ({ ccn3, cca2: REGIONS[ccn3]?.cca2?.toLowerCase(), name: REGIONS[ccn3]?.name }))
      .filter((t) => t.cca2 && COUNTRIES.has(t.cca2));

    const items = [];
    const health = [];
    let done = 0;

    await mapLimit(targets, 2, async (t) => {
      const url =
        `https://gnews.io/api/v4/top-headlines?country=${t.cca2}&lang=en&max=20` +
        `&apikey=${encodeURIComponent(config.keys.gnews)}`;
      const res = await fetchText(url, { headers: { Accept: "application/json" } });
      let articles = [];
      let error = res.error || (res.ok ? null : `HTTP ${res.status}`);
      if (res.ok && res.text) {
        try {
          articles = JSON.parse(res.text).articles || [];
        } catch {
          error = "invalid JSON response";
        }
      }

      const record = {
        plugin: this.id,
        sourceKey: t.name,
        outlet: `GNews · ${t.name}`,
        // never leak the API key into the health report
        url: url.replace(/apikey=[^&]+/, "apikey=***"),
        ok: articles.length > 0,
        skipped: false,
        status: res.status,
        format: "gnews-json",
        items: articles.length,
        ms: res.ms,
        error: articles.length ? null : error,
      };
      health.push(record);
      onProgress?.(++done, targets.length, record);

      for (const a of articles) {
        if (!a.title || !a.url) continue;
        items.push({
          title: a.title,
          link: a.url,
          guid: a.url,
          summary: a.description || "",
          content: a.content || a.description || "",
          published: a.publishedAt || "",
          image: a.image || "",
          categories: [],
          author: "",
          lang: "en",
          src: a.source?.name || "GNews",
          srcHome: a.source?.url || "",
          sourceKey: t.name,
          forceCcn3: t.ccn3,
          catalogLang: "en",
          feedLang: "en",
          feedUrl: "https://gnews.io/api/v4/top-headlines",
          plugin: this.id,
        });
      }
    });

    return { items, health };
  },
};

export default plugin;
