/**
 * Lightweight language identification.
 *
 * Order of confidence:
 *   1. the language the feed itself declares (`<language>` / `xml:lang`)
 *   2. the language tag curated in data/sources.json
 *   3. script detection (Cyrillic, Arabic, CJK, Thai, …)
 *   4. stop-word scoring for Latin-script languages
 *
 * This is deliberately dependency-free: it only has to be good enough to pick
 * the right label for the article card and to decide whether a translation is
 * needed at all.
 */

/** Unicode ranges that identify a language (or a small candidate set) outright. */
const SCRIPTS = [
  [/[฀-๿]/, "th"],
  [/[֐-׿]/, "he"],
  [/[؀-ۿݐ-ݿ]/, "ar"],
  [/[ऀ-ॿ]/, "hi"],
  [/[ঀ-৿]/, "bn"],
  [/[઀-૿]/, "gu"],
  [/[ఀ-౿]/, "te"],
  [/[ഀ-ൿ]/, "ml"],
  [/[Ͱ-Ͽ]/, "el"],
  [/[぀-ゟ゠-ヿ]/, "ja"],
  [/[가-힯]/, "ko"],
  [/[一-鿿]/, "zh"],
];

const STOPWORDS = {
  en: ["the", "and", "for", "with", "that", "from", "says", "after", "will", "has", "have", "was", "been", "more", "new"],
  de: ["der", "die", "das", "und", "für", "mit", "nicht", "auch", "wird", "sich", "von", "den", "ist", "eine", "dem"],
  fr: ["les", "des", "une", "dans", "pour", "avec", "que", "sur", "est", "aux", "par", "plus", "son", "ses", "pas"],
  es: ["que", "los", "las", "una", "por", "con", "del", "para", "más", "como", "sobre", "sus", "año", "este", "gobierno"],
  it: ["che", "per", "con", "del", "nel", "una", "sono", "alla", "dei", "più", "anche", "come", "dalla", "gli", "governo"],
  pt: ["que", "para", "com", "não", "uma", "dos", "das", "por", "mais", "como", "está", "sobre", "seu", "ele", "governo"],
  nl: ["het", "een", "van", "voor", "met", "niet", "dat", "aan", "wordt", "zijn", "maar", "door", "over", "naar", "ook"],
  sv: ["och", "att", "för", "med", "inte", "det", "som", "till", "har", "efter", "från", "kan", "mot", "sig", "ett"],
  no: ["ikke", "det", "til", "med", "har", "som", "for", "etter", "kan", "men", "fra", "seg", "være", "vil", "over"],
  da: ["ikke", "det", "til", "med", "har", "som", "for", "efter", "kan", "men", "fra", "sig", "være", "vil", "over"],
  fi: ["että", "on", "ei", "ja", "sekä", "mutta", "kun", "myös", "hän", "ovat", "sen", "sitä", "vain", "koska", "jälkeen"],
  pl: ["nie", "się", "jest", "oraz", "przez", "które", "jak", "tego", "dla", "przed", "ale", "już", "roku", "tym", "jego"],
  tr: ["ile", "için", "bir", "olarak", "daha", "sonra", "ancak", "olan", "bu", "ve", "değil", "kadar", "yeni", "büyük", "göre"],
  id: ["yang", "dan", "untuk", "dengan", "dari", "pada", "ini", "itu", "akan", "tidak", "dalam", "sudah", "juga", "karena", "bisa"],
  tl: ["ang", "mga", "sa", "ng", "para", "hindi", "ito", "na", "may", "kay", "nang", "dahil", "kaya", "pero", "isang"],
  ru: ["что", "как", "для", "это", "при", "его", "она", "они", "все", "был", "года", "после", "может", "было", "который"],
  uk: ["що", "для", "але", "його", "які", "цього", "після", "також", "було", "може", "року", "від", "про", "вже", "усі"],
};

/** Maps a two-letter tag from arbitrary sources onto our supported set. */
export function normalizeLang(tag) {
  if (!tag) return "";
  const t = String(tag).toLowerCase().replace("_", "-").split("-")[0].trim();
  if (t.length !== 2) return "";
  return t;
}

/** Turns the curated `l` column of data/sources.json ("DE", "FR/EN") into a tag. */
export function langFromCatalog(l) {
  if (!l) return "";
  return normalizeLang(String(l).split("/")[0]);
}

export function detectLang(text) {
  const s = String(text || "").slice(0, 1200);
  if (!s.trim()) return "";

  for (const [re, code] of SCRIPTS) {
    const hits = (s.match(new RegExp(re.source, "g")) || []).length;
    if (hits >= 4) return code;
  }
  if (/[Ѐ-ӿ]/.test(s)) {
    // Cyrillic: separate Ukrainian from Russian by its distinctive letters.
    return /[іїєґІЇЄҐ]/.test(s) ? "uk" : "ru";
  }

  const words = s.toLowerCase().match(/[\p{L}]{2,}/gu) || [];
  if (words.length < 4) return "";
  const set = new Set(words);
  let best = "";
  let bestScore = 0;
  for (const [code, list] of Object.entries(STOPWORDS)) {
    let score = 0;
    for (const w of list) if (set.has(w)) score++;
    if (score > bestScore) {
      bestScore = score;
      best = code;
    }
  }
  return bestScore >= 2 ? best : "";
}

/**
 * Resolves the language of one article from every hint available,
 * strongest first. Returns a two-letter tag, defaulting to "en".
 */
export function resolveLang({ itemLang, feedLang, catalogLang, text }) {
  return (
    normalizeLang(itemLang) ||
    normalizeLang(feedLang) ||
    detectLang(text) ||
    langFromCatalog(catalogLang) ||
    "en"
  );
}
