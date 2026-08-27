import { fetchText, mapLimit } from "../lib/http.js";
import { parseFeed } from "../lib/feedparser.js";
import { langFromCatalog } from "../lib/lang.js";
import { config } from "../config.js";

/**
 * The core plugin: every outlet in data/sources.json that publishes a
 * machine-readable feed. Handles RSS 2.0, RSS 1.0 (RDF), Atom and JSON Feed.
 *
 * This is where the great majority of articles come from — it is the reason
 * the map shows local reporting rather than one global wire.
 */
const plugin = {
  id: "rss",
  label: "RSS / Atom / RDF / JSON Feed",
  enabled: () => config.plugins.rss,

  /** Feed entries that are documented in the catalog but not fetchable. */
  describeSkipped(url) {
    if (!url) return "no feed published (licensed / API only)";
    if (/\s/.test(url)) return "catalog entry points at a feed index, not a feed";
    if (!/^https?:\/\//i.test(url)) return "not an http(s) url";
    return null;
  },

  /**
   * @param {{sources: Record<string, Array>, onProgress?: Function}} ctx
   * @returns {Promise<{items: Array, health: Array}>}
   */
  async collect({ sources, onProgress }) {
    const targets = [];
    const health = [];

    for (const [sourceKey, outlets] of Object.entries(sources)) {
      for (const outlet of outlets) {
        const skip = this.describeSkipped(outlet.r);
        if (skip) {
          health.push({
            plugin: this.id,
            sourceKey,
            outlet: outlet.m,
            url: outlet.r || outlet.w || "",
            ok: false,
            skipped: true,
            status: 0,
            items: 0,
            ms: 0,
            error: skip,
          });
          continue;
        }
        targets.push({ sourceKey, outlet });
      }
    }

    let done = 0;
    const results = await mapLimit(targets, config.ingest.concurrency, async ({ sourceKey, outlet }) => {
      const res = await fetchText(outlet.r);
      let parsed = { format: "", meta: {}, items: [] };
      let error = res.error || null;

      if (res.ok && res.text) {
        const looksLikeHtml = /^\s*(<!doctype html|<html)/i.test(res.text);
        parsed = looksLikeHtml ? parsed : parseFeed(res.text, res.contentType);
        if (looksLikeHtml) error = "endpoint returns a web page, not a feed";
        else if (parsed.error) error = `parse: ${parsed.error}`;
        else if (!parsed.items.length) error = `feed parsed but is empty (format: ${parsed.format || "unknown"})`;
      } else if (!error) {
        error = `HTTP ${res.status}`;
      }

      const record = {
        plugin: this.id,
        sourceKey,
        outlet: outlet.m,
        url: outlet.r,
        ok: !!parsed.items.length,
        skipped: false,
        status: res.status,
        format: parsed.format || "",
        items: parsed.items.length,
        ms: res.ms,
        bytes: res.bytes,
        error: parsed.items.length ? null : error,
      };

      onProgress?.(++done, targets.length, record);

      const items = parsed.items
        .filter((i) => i.title && i.link)
        .map((i) => ({
          ...i,
          src: outlet.m,
          srcHome: outlet.w || parsed.meta.link || "",
          sourceKey,
          catalogLang: langFromCatalog(outlet.l),
          feedLang: parsed.meta.language || "",
          feedUrl: outlet.r,
          plugin: this.id,
        }));

      return { record, items };
    });

    const items = [];
    for (const r of results) {
      if (!r || r.error) continue;
      health.push(r.record);
      items.push(...r.items);
    }
    return { items, health };
  },
};

export default plugin;
