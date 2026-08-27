import { translateBatch, translationStatus } from "./translate.js";

/**
 * On-demand article translation with a bounded cache.
 *
 * The map deliberately shows every headline in the language its newsroom
 * published it in — that is the point of reading foreign press. The translation
 * is produced when a reader opens the article, into *their* language (resolved
 * from the request, see lib/geoip.js), and cached so the second reader from the
 * same country pays nothing.
 */

const MAX_ENTRIES = 5000;
const cache = new Map(); // `${articleId}:${lang}` → translation
let hits = 0;
let misses = 0;

function remember(key, value) {
  if (cache.size >= MAX_ENTRIES) {
    // Map preserves insertion order — drop the oldest tenth in one pass.
    const drop = Math.ceil(MAX_ENTRIES / 10);
    let i = 0;
    for (const k of cache.keys()) {
      cache.delete(k);
      if (++i >= drop) break;
    }
  }
  cache.set(key, value);
}

export function translationCacheStats() {
  return { entries: cache.size, hits, misses, max: MAX_ENTRIES };
}

export function clearTranslationCache() {
  cache.clear();
  hits = 0;
  misses = 0;
}

/**
 * @param {object} article  an article record from the store
 * @param {string} to       two-letter reading language
 * @returns {Promise<{lang:string, title:string, teaser:string, lede:string, body:string[],
 *                    provider:string, cached:boolean, reason?:string}|null>}
 *          null when no translation is needed (already in the reader's language)
 */
export async function translateArticle(article, to) {
  if (!article || !to) return null;
  if (article.lang === to) return null;

  const key = `${article.id}:${to}`;
  const cached = cache.get(key);
  if (cached) {
    hits++;
    return { ...cached, cached: true };
  }
  misses++;

  const status = translationStatus();
  const src = article.orig;
  if (!status.enabled) {
    return {
      lang: to,
      title: src.title,
      teaser: src.teaser,
      lede: src.lede,
      body: src.body,
      provider: "none",
      cached: false,
      reason: "no translation provider configured (set TRANSLATE_PROVIDER)",
    };
  }

  const payload = [src.title, src.teaser, src.lede, ...src.body];
  const res = await translateBatch(payload, article.lang, to);
  if (!res.translated) {
    return {
      lang: to,
      title: src.title,
      teaser: src.teaser,
      lede: src.lede,
      body: src.body,
      provider: res.provider,
      cached: false,
      reason: res.error || "translation unavailable",
    };
  }

  const value = {
    lang: to,
    title: res.texts[0],
    teaser: res.texts[1],
    lede: res.texts[2],
    body: res.texts.slice(3),
    provider: res.provider,
    cached: false,
  };
  remember(key, value);
  return value;
}

/** Translates just the headline + teaser — used for card previews. */
export async function translateHeadline(article, to) {
  const full = await translateArticle(article, to);
  if (!full) return null;
  return { lang: full.lang, title: full.title, teaser: full.teaser, provider: full.provider, reason: full.reason };
}
