import { fetchText, mapLimit } from "../lib/http.js";
import { config } from "../config.js";
import { REGIONS } from "../lib/geo.js";

/**
 * NewsAPI.org top-headlines, one request per country.
 * Optional: set PLUGIN_NEWSAPI=true and NEWSAPI_KEY=… to enable.
 *
 * The free tier is developer-only and rate limited, so this plugin is off by
 * default — the RSS plugin already covers the curated outlet list.
 */
const COUNTRIES = new Set(
  ("ae ar at au be bg br ca ch cn co cu cz de eg fr gb gr hk hu id ie il in it jp kr lt lv ma mx my " +
    "ng nl no nz ph pl pt ro rs ru sa se sg si sk th tr tw ua us ve za")
    .split(" ")
);

const plugin = {
  id: "newsapi",
  label: "NewsAPI.org top headlines",
  enabled: () => config.plugins.newsapi,

  async collect({ coverGaps = [], onProgress } = {}) {
    const targets = coverGaps
      .map((ccn3) => ({ ccn3, cca2: REGIONS[ccn3]?.cca2?.toLowerCase(), name: REGIONS[ccn3]?.name }))
      .filter((t) => t.cca2 && COUNTRIES.has(t.cca2));

    const items = [];
    const health = [];
    let done = 0;

    await mapLimit(targets, 3, async (t) => {
      const url = `https://newsapi.org/v2/top-headlines?country=${t.cca2}&pageSize=25`;
      const res = await fetchText(url, {
        headers: { "X-Api-Key": config.keys.newsapi, Accept: "application/json" },
      });
      let articles = [];
      let error = res.error || (res.ok ? null : `HTTP ${res.status}`);
      if (res.ok && res.text) {
        try {
          const data = JSON.parse(res.text);
          if (data.status === "error") error = data.message || "api error";
          articles = data.articles || [];
        } catch {
          error = "invalid JSON response";
        }
      }

      const record = {
        plugin: this.id,
        sourceKey: t.name,
        outlet: `NewsAPI · ${t.name}`,
        url,
        ok: articles.length > 0,
        skipped: false,
        status: res.status,
        format: "newsapi-json",
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
          image: a.urlToImage || "",
          categories: [],
          author: a.author || "",
          lang: "",
          src: a.source?.name || "NewsAPI",
          srcHome: "",
          sourceKey: t.name,
          forceCcn3: t.ccn3,
          catalogLang: "",
          feedLang: "",
          feedUrl: url,
          plugin: this.id,
        });
      }
    });

    return { items, health };
  },
};

export default plugin;
