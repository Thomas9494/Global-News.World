import { XMLParser } from "fast-xml-parser";
import { stripHtml, decodeEntities, canonicalUrl } from "./text.js";

/**
 * Feed XML comes from hundreds of third parties, so the parser keeps its
 * XXE / billion-laughs guards on. The defaults are tuned for small documents
 * though: a single Guardian or El Pais feed legitimately contains thousands of
 * &amp; entities and trips `maxTotalExpansions`. What actually stops an entity
 * bomb is a shallow expansion depth and a bounded entity count, both of which
 * stay strict here — only the harmless total is raised.
 */
const PARSER_OPTIONS = {
  ignoreAttributes: false,
  attributeNamePrefix: "@",
  trimValues: true,
  parseTagValue: false,
  parseAttributeValue: false,
  htmlEntities: true,
  removeNSPrefix: false,
  maxNestedTags: 500,
  processEntities: {
    enabled: true,
    maxEntitySize: 10000,
    maxExpansionDepth: 4,
    maxEntityCount: 200,
    maxTotalExpansions: 500000,
    maxExpandedLength: 40000000,
  },
  isArray: (name) => name === "item" || name === "entry",
};

const parser = new XMLParser(PARSER_OPTIONS);

/** Last resort: leave entities untouched. stripHtml() decodes them later. */
const literalParser = new XMLParser({ ...PARSER_OPTIONS, processEntities: false });

const first = (...vals) => vals.find((v) => v !== undefined && v !== null && v !== "");

const textOf = (v) => {
  if (v === undefined || v === null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number") return String(v);
  if (Array.isArray(v)) return textOf(v[0]);
  if (typeof v === "object") return textOf(v["#text"] ?? v["@href"] ?? "");
  return "";
};

/** Detects the payload format so the right branch runs. */
export function detectFormat(text, contentType = "") {
  const head = text.slice(0, 600).trim();
  if (head.startsWith("{") || /application\/(feed\+)?json/i.test(contentType)) return "json";
  if (/<rdf:RDF|<rdf\b/i.test(head)) return "rdf";
  if (/<feed[\s>]/i.test(head)) return "atom";
  if (/<rss[\s>]/i.test(head)) return "rss";
  if (head.startsWith("<?xml") || head.startsWith("<")) return "xml";
  return "unknown";
}

/**
 * Parses RSS 2.0 / RSS 1.0 (RDF) / Atom / JSON Feed into a common item shape:
 * { title, link, guid, summary, content, published, image, categories, author, lang }
 */
export function parseFeed(text, contentType = "") {
  const format = detectFormat(text, contentType);
  if (format === "json") return parseJsonFeed(text);

  let doc;
  try {
    doc = parser.parse(text);
  } catch (err) {
    try {
      doc = literalParser.parse(text);
    } catch {
      return { format, meta: {}, items: [], error: String(err?.message || err) };
    }
  }

  const channel = doc?.rss?.channel || doc?.channel;
  const rdf = doc?.["rdf:RDF"] || doc?.RDF;
  const atom = doc?.feed;

  if (channel) return { format: "rss", meta: channelMeta(channel), items: toItems(channel.item) };
  if (rdf) {
    const ch = rdf.channel || {};
    const items = rdf.item ? (Array.isArray(rdf.item) ? rdf.item : [rdf.item]) : [];
    return { format: "rdf", meta: channelMeta(ch), items: toItems(items) };
  }
  if (atom) return { format: "atom", meta: atomMeta(atom), items: toAtomItems(atom.entry) };
  return { format, meta: {}, items: [] };
}

function channelMeta(ch) {
  return {
    title: stripHtml(textOf(ch.title)),
    link: textOf(ch.link),
    language: (textOf(ch.language) || textOf(ch["dc:language"]) || "").slice(0, 5).toLowerCase(),
    description: stripHtml(textOf(ch.description)),
  };
}

function atomMeta(f) {
  const link = Array.isArray(f.link) ? f.link.find((l) => l["@rel"] !== "self") : f.link;
  return {
    title: stripHtml(textOf(f.title)),
    link: textOf(link?.["@href"] ?? link),
    language: String(f["@xml:lang"] || "").slice(0, 5).toLowerCase(),
    description: stripHtml(textOf(f.subtitle)),
  };
}

function toItems(items) {
  if (!items) return [];
  const list = Array.isArray(items) ? items : [items];
  return list.map((it) => {
    const content = textOf(first(it["content:encoded"], it.content, it["dc:description"]));
    const summary = textOf(first(it.description, it.summary, it["dc:description"]));
    return {
      title: stripHtml(textOf(it.title)),
      link: canonicalUrl(textOf(first(it.link, it["@rdf:about"], it.guid))),
      guid: textOf(first(it.guid, it["@rdf:about"], it.link)),
      summary: stripHtml(summary),
      content: content || summary,
      published: textOf(first(it.pubDate, it["dc:date"], it.published, it.date, it["a10:updated"])),
      image: imageOf(it, content || summary),
      categories: categoriesOf(it),
      author: stripHtml(textOf(first(it["dc:creator"], it.author, it["itunes:author"]))),
      lang: String(textOf(it["dc:language"]) || "").slice(0, 5).toLowerCase(),
      // <source url="…">Publisher</source> — aggregator feeds name the newsroom here
      sourceName: stripHtml(textOf(it.source)),
      sourceUrl: typeof it.source === "object" ? textOf(it.source["@url"]) : "",
    };
  });
}

function toAtomItems(entries) {
  if (!entries) return [];
  const list = Array.isArray(entries) ? entries : [entries];
  return list.map((e) => {
    const links = Array.isArray(e.link) ? e.link : e.link ? [e.link] : [];
    const alt = links.find((l) => (l["@rel"] || "alternate") === "alternate") || links[0];
    const content = textOf(first(e.content, e.summary));
    return {
      title: stripHtml(textOf(e.title)),
      link: canonicalUrl(textOf(alt?.["@href"] ?? alt)),
      guid: textOf(first(e.id, alt?.["@href"])),
      summary: stripHtml(textOf(first(e.summary, e.content))),
      content,
      published: textOf(first(e.published, e.updated, e["dc:date"])),
      image: imageOf(e, content),
      categories: categoriesOf(e),
      author: stripHtml(textOf(e.author?.name ?? e.author)),
      lang: String(e["@xml:lang"] || "").slice(0, 5).toLowerCase(),
    };
  });
}

function categoriesOf(it) {
  const raw = it.category ?? it["dc:subject"];
  if (!raw) return [];
  const list = Array.isArray(raw) ? raw : [raw];
  return list
    .map((c) => stripHtml(textOf(c?.["@term"] ?? c)))
    .filter(Boolean)
    .slice(0, 8);
}

/** Pulls an image from media:*, enclosure, itunes:image or an inline <img>. */
function imageOf(it, html) {
  const cand = [];
  const push = (v) => {
    const s = textOf(v);
    if (s) cand.push(s);
  };

  for (const key of ["media:content", "media:thumbnail", "media:group"]) {
    const m = it[key];
    if (!m) continue;
    const arr = Array.isArray(m) ? m : [m];
    for (const x of arr) {
      if (typeof x !== "object") continue;
      push(x["@url"]);
      for (const nested of ["media:content", "media:thumbnail"]) {
        if (!x[nested]) continue;
        const inner = Array.isArray(x[nested]) ? x[nested] : [x[nested]];
        inner.forEach((y) => push(y?.["@url"]));
      }
    }
  }

  const enc = it.enclosure ? (Array.isArray(it.enclosure) ? it.enclosure : [it.enclosure]) : [];
  for (const e of enc) {
    if (typeof e !== "object") continue;
    if (!e["@type"] || /image/i.test(e["@type"])) push(e["@url"]);
  }
  push(it["itunes:image"]?.["@href"]);
  push(it.image?.url ?? it.image);

  if (html) {
    const m = /<img[^>]+src=["']([^"']+)["']/i.exec(html);
    if (m) cand.push(decodeEntities(m[1]));
  }

  const url = cand.find((u) => /^https?:\/\//i.test(u) && !/\.(svg|gif)(\?|$)/i.test(u));
  return url || "";
}

function parseJsonFeed(text) {
  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    return { format: "json", meta: {}, items: [] };
  }
  const items = Array.isArray(doc.items) ? doc.items : [];
  return {
    format: "jsonfeed",
    meta: {
      title: doc.title || "",
      link: doc.home_page_url || "",
      language: String(doc.language || "").slice(0, 5),
    },
    items: items.map((i) => ({
      title: stripHtml(i.title || ""),
      link: canonicalUrl(i.url || i.external_url || i.id || ""),
      guid: String(i.id || i.url || ""),
      summary: stripHtml(i.summary || i.content_text || i.content_html || ""),
      content: i.content_html || i.content_text || i.summary || "",
      published: i.date_published || i.date_modified || "",
      image: i.image || i.banner_image || "",
      categories: Array.isArray(i.tags) ? i.tags.slice(0, 8) : [],
      author: i.author?.name || (Array.isArray(i.authors) ? i.authors[0]?.name : "") || "",
      lang: String(i.language || "").slice(0, 5),
    })),
  };
}
