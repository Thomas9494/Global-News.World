import { readFileSync, existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { XMLParser } from "fast-xml-parser";
import { fetchText, mapLimit } from "../lib/http.js";
import { parseFeed } from "../lib/feedparser.js";
import { config, ROOT } from "../config.js";
import { COUNTRY_BY_NAME } from "../lib/geo.js";

/**
 * OPML import — the format every feed reader exports.
 *
 * Point `OPML_FILE` at a subscription list (or drop one at `data/feeds.opml`)
 * and every feed in it joins the map. Grouping outlines carry the country:
 *
 *   <outline text="Kenya">
 *     <outline type="rss" text="The Standard" xmlUrl="https://…/rss" />
 *   </outline>
 *
 * A feed can also name its own country with `country="Kenya"`. Feeds with no
 * country at all are treated like a worldwide wire and routed per story.
 *
 * This exists so that anyone can contribute a whole country's press without
 * touching JSON — export from your reader, open a pull request.
 */
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@",
  isArray: (name) => name === "outline",
});

/**
 * Flattens an OPML tree into feeds, remembering the group each one sits in.
 * @returns {{title:string, url:string, country:string, lang:string}[]}
 */
export function parseOpml(xml) {
  let doc;
  try {
    doc = parser.parse(xml);
  } catch {
    return [];
  }
  const out = [];
  const walk = (nodes, group) => {
    for (const n of nodes || []) {
      const title = n["@title"] || n["@text"] || "";
      const url = n["@xmlUrl"] || n["@xmlurl"] || "";
      if (url) {
        out.push({
          title: title || url,
          url,
          country: n["@country"] || group || "",
          lang: (n["@language"] || n["@lang"] || "").slice(0, 5),
        });
      }
      if (n.outline) walk(n.outline, title || group);
    }
  };
  walk(doc?.opml?.body?.outline, "");
  return out;
}

function readLocal(file) {
  const path = isAbsolute(file) ? file : join(ROOT, file);
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

const plugin = {
  id: "opml",
  label: "OPML subscription lists (open — bring your own feeds)",
  enabled: () => config.plugins.opml,

  async collect({ onProgress } = {}) {
    const documents = [];

    const local = readLocal(config.opml.file);
    if (local) documents.push({ where: config.opml.file, xml: local });

    if (config.opml.url) {
      const res = await fetchText(config.opml.url);
      if (res.ok && res.text) documents.push({ where: config.opml.url, xml: res.text });
      else
        return {
          items: [],
          health: [
            {
              plugin: this.id,
              sourceKey: "OPML",
              outlet: "OPML source",
              url: config.opml.url,
              ok: false,
              skipped: false,
              status: res.status,
              items: 0,
              ms: res.ms,
              error: res.error || `HTTP ${res.status}`,
            },
          ],
        };
    }

    // Nothing configured is the normal case, and is not a failure.
    if (!documents.length) return { items: [], health: [] };

    const feeds = documents.flatMap((d) => parseOpml(d.xml));
    const items = [];
    const health = [];
    let done = 0;

    await mapLimit(feeds, config.ingest.concurrency, async (f) => {
      const res = await fetchText(f.url);
      let parsed = { format: "", meta: {}, items: [] };
      let error = res.error || (res.ok ? null : `HTTP ${res.status}`);
      if (res.ok && res.text) {
        if (/^\s*(<!doctype html|<html)/i.test(res.text)) error = "endpoint returns a web page, not a feed";
        else {
          parsed = parseFeed(res.text, res.contentType);
          if (parsed.error) error = `parse: ${parsed.error}`;
          else if (!parsed.items.length) error = "feed parsed but is empty";
        }
      }

      // A country named in the OPML only counts if we can place it on the map.
      const known = f.country && COUNTRY_BY_NAME[f.country.toLowerCase()] ? f.country : "Global";

      const record = {
        plugin: this.id,
        sourceKey: known,
        outlet: f.title,
        url: f.url,
        ok: parsed.items.length > 0,
        skipped: false,
        status: res.status,
        format: parsed.format || "",
        items: parsed.items.length,
        ms: res.ms,
        error: parsed.items.length ? null : error,
      };
      health.push(record);
      onProgress?.(++done, feeds.length, record);

      for (const i of parsed.items) {
        if (!i.title || !i.link) continue;
        items.push({
          ...i,
          src: f.title,
          srcHome: parsed.meta.link || "",
          sourceKey: known,
          catalogLang: f.lang,
          feedLang: parsed.meta.language || "",
          feedUrl: f.url,
          plugin: this.id,
        });
      }
    });

    return { items, health };
  },
};

export default plugin;
