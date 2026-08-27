import { fetchText, mapLimit } from "../lib/http.js";
import { config } from "../config.js";
import { REGIONS } from "../lib/geo.js";

/**
 * GDELT DOC 2.0 — a free, key-less index of worldwide news coverage.
 *
 * Used to fill the gaps: countries that have no curated outlet in
 * data/sources.json still get real, attributed local reporting on the map.
 * Enable with PLUGIN_GDELT=true.
 *
 * Docs: https://blog.gdeltproject.org/gdelt-doc-2-0-api-debuts/
 */
const ENDPOINT = "https://api.gdeltproject.org/api/v2/doc/doc";

/** GDELT uses FIPS-ish country codes; ISO alpha-2 covers the overwhelming majority. */
function query(cca2) {
  const params = new URLSearchParams({
    query: `sourcecountry:${cca2} sourcelang:eng`,
    mode: "ArtList",
    maxrecords: "25",
    format: "json",
    sort: "datedesc",
    timespan: "1d",
  });
  return `${ENDPOINT}?${params}`;
}

/** "20260827T101500Z" → ISO 8601 */
function gdeltDate(s) {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(String(s || ""));
  return m ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z` : "";
}

const plugin = {
  id: "gdelt",
  label: "GDELT DOC 2.0 (worldwide coverage, no API key)",
  enabled: () => config.plugins.gdelt,

  /**
   * @param {{countries?: string[]}} ctx  ccn3 codes to cover; defaults to every
   *   country that has no curated feed of its own.
   */
  async collect({ coverGaps = [], onProgress } = {}) {
    const targets = coverGaps
      .map((ccn3) => ({ ccn3, cca2: REGIONS[ccn3]?.cca2, name: REGIONS[ccn3]?.name }))
      .filter((t) => t.cca2);

    const items = [];
    const health = [];
    let done = 0;

    await mapLimit(targets, Math.min(4, config.ingest.concurrency), async (t) => {
      const url = query(t.cca2);
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
        outlet: `GDELT · ${t.name}`,
        url,
        ok: articles.length > 0,
        skipped: false,
        status: res.status,
        format: "gdelt-json",
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
          summary: "",
          content: "",
          published: gdeltDate(a.seendate),
          image: a.socialimage || "",
          categories: [],
          author: "",
          lang: "en",
          src: a.domain || "GDELT",
          srcHome: a.domain ? `https://${a.domain}/` : "",
          sourceKey: t.name,
          forceCcn3: t.ccn3,
          catalogLang: "en",
          feedLang: "en",
          feedUrl: url,
          plugin: this.id,
        });
      }
    });

    return { items, health };
  },
};

export default plugin;
