/** Small text helpers shared by the feed plugins. */

const ENTITIES = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–",
  mdash: "—", hellip: "…", laquo: "«", raquo: "»", euro: "€",
  pound: "£", copy: "©", reg: "®", deg: "°", middot: "·",
  lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", bdquo: "„",
  szlig: "ß", auml: "ä", ouml: "ö", uuml: "ü", Auml: "Ä",
  Ouml: "Ö", Uuml: "Ü", eacute: "é", egrave: "è", agrave: "à",
  ccedil: "ç", ntilde: "ñ", aacute: "á", iacute: "í", oacute: "ó",
  uacute: "ú",
};

export function decodeEntities(s) {
  if (!s) return "";
  return String(s).replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, g) => {
    if (g[0] === "#") {
      const code = g[1] === "x" || g[1] === "X" ? parseInt(g.slice(2), 16) : parseInt(g.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[g] ?? m;
  });
}

/** Strips markup and collapses whitespace. Feed descriptions are frequently HTML. */
export function stripHtml(html) {
  if (!html) return "";
  return decodeEntities(
    String(html)
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<br\s*\/?>/gi, " ")
      .replace(/<\/(p|div|li|h[1-6])>/gi, " ")
      .replace(/<[^>]+>/g, " ")
  )
    .replace(/\s+/g, " ")
    .trim();
}

/** Splits plain text into readable paragraphs for the article panel. */
export function toParagraphs(text, maxParas = 6) {
  const clean = stripHtml(text);
  if (!clean) return [];
  const sentences = clean.match(/[^.!?…]+[.!?…]+["'»”]?|\S+$/g) || [clean];
  const out = [];
  let buf = "";
  for (const s of sentences) {
    buf += s;
    if (buf.length > 260) { out.push(buf.trim()); buf = ""; }
    if (out.length >= maxParas) break;
  }
  if (buf.trim() && out.length < maxParas) out.push(buf.trim());
  return out;
}

export function truncate(s, n) {
  const t = (s || "").trim();
  if (t.length <= n) return t;
  const cut = t.slice(0, n);
  const sp = cut.lastIndexOf(" ");
  return (sp > n * 0.6 ? cut.slice(0, sp) : cut).replace(/[\s.,;:–—-]+$/, "") + "…";
}

/** Stable 32-bit FNV-1a hash, used for article ids and deterministic image seeds. */
export function hash(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

/** "12 min ago" / "3h ago" / "2d ago" — matches the design's `time` field. */
export function relativeTime(date, now = Date.now()) {
  const ms = now - new Date(date).getTime();
  if (!Number.isFinite(ms)) return "just now";
  const min = Math.round(ms / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return `${d}d ago`;
}

/** Normalises a URL for de-duplication (drops tracking params and fragments). */
export function canonicalUrl(url) {
  try {
    const u = new URL(url);
    u.hash = "";
    for (const p of [...u.searchParams.keys()]) {
      if (/^(utm_|ref|fbclid|gclid|mc_|at_|ito|CMP|cmpid|source)/i.test(p)) u.searchParams.delete(p);
    }
    u.hostname = u.hostname.replace(/^www\./, "");
    return u.toString().replace(/\/$/, "");
  } catch {
    return String(url || "").trim();
  }
}
