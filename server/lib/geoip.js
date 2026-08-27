import { REGIONS } from "./geo.js";
import { config } from "../config.js";

/**
 * Works out which language to offer a reader, without asking them.
 *
 * Layers, strongest first:
 *   1. explicit choice          ?lang=nl  (the UI remembers the reader's pick)
 *   2. CDN geo header           cf-ipcountry / x-vercel-ip-country / …
 *   3. optional IP lookup       GEOIP_PROVIDER=ipapi  (off by default)
 *   4. Accept-Language header   sent by every browser, costs nothing
 *   5. fallback                 TRANSLATE_TARGET, else English
 *
 * No IP address is stored anywhere; the lookup result is a country code that
 * lives only for the duration of the request.
 */

/** Country → the language its readers most likely want the news in. */
const COUNTRY_LANG = {
  AT: "de", DE: "de", CH: "de", LI: "de",
  NL: "nl", BE: "nl", SR: "nl",
  GB: "en", IE: "en", US: "en", CA: "en", AU: "en", NZ: "en", ZA: "en", IN: "en",
  NG: "en", KE: "en", GH: "en", SG: "en", PH: "en", PK: "en", MY: "en", HK: "en",
  FR: "fr", LU: "fr", MC: "fr", SN: "fr", CI: "fr", CM: "fr", CD: "fr", MA: "fr", DZ: "fr", TN: "fr",
  ES: "es", MX: "es", AR: "es", CO: "es", CL: "es", PE: "es", VE: "es", EC: "es", UY: "es",
  PY: "es", BO: "es", CR: "es", GT: "es", PA: "es", CU: "es", DO: "es",
  IT: "it", SM: "it", VA: "it",
  PT: "pt", BR: "pt", AO: "pt", MZ: "pt",
  PL: "pl", RU: "ru", BY: "ru", KZ: "ru", UA: "uk",
  SE: "sv", NO: "no", DK: "da", FI: "fi", IS: "is",
  CZ: "cs", SK: "sk", HU: "hu", RO: "ro", BG: "bg", GR: "el", HR: "hr", SI: "sl",
  RS: "sr", TR: "tr", IL: "he", SA: "ar", AE: "ar", EG: "ar", QA: "ar", JO: "ar",
  IQ: "ar", LB: "ar", KW: "ar", OM: "ar", YE: "ar", LY: "ar", SY: "ar",
  IR: "fa", AF: "fa", CN: "zh", TW: "zh", JP: "ja", KR: "ko", TH: "th", VN: "vi",
  ID: "id", BD: "bn", NP: "ne", LK: "si", MM: "my", KH: "km", LA: "lo",
};

/** Display names for the reading-language selector. */
export const LANG_NAMES = {
  ar: "العربية", bg: "Български", bn: "বাংলা", cs: "Čeština", da: "Dansk", de: "Deutsch",
  el: "Ελληνικά", en: "English", es: "Español", fa: "فارسی", fi: "Suomi", fr: "Français",
  he: "עברית", hi: "हिन्दी", hr: "Hrvatski", hu: "Magyar", id: "Bahasa Indonesia", is: "Íslenska",
  it: "Italiano", ja: "日本語", km: "ភាសាខ្មែរ", ko: "한국어", lo: "ລາວ", my: "မြန်မာ",
  ne: "नेपाली", nl: "Nederlands", no: "Norsk", pl: "Polski", pt: "Português", ro: "Română",
  ru: "Русский", si: "සිංහල", sk: "Slovenčina", sl: "Slovenščina", sr: "Српски", sv: "Svenska",
  th: "ไทย", tl: "Tagalog", tr: "Türkçe", uk: "Українська", vi: "Tiếng Việt", zh: "中文",
};

/** English names, used for the "translated from X" note. */
export const LANG_NAMES_EN = {
  ar: "Arabic", bg: "Bulgarian", bn: "Bengali", cs: "Czech", da: "Danish", de: "German",
  el: "Greek", en: "English", es: "Spanish", fa: "Persian", fi: "Finnish", fr: "French",
  he: "Hebrew", hi: "Hindi", hr: "Croatian", hu: "Hungarian", id: "Indonesian", is: "Icelandic",
  it: "Italian", ja: "Japanese", km: "Khmer", ko: "Korean", lo: "Lao", my: "Burmese",
  ne: "Nepali", nl: "Dutch", no: "Norwegian", pl: "Polish", pt: "Portuguese", ro: "Romanian",
  ru: "Russian", si: "Sinhala", sk: "Slovak", sl: "Slovenian", sr: "Serbian", sv: "Swedish",
  th: "Thai", tl: "Tagalog", tr: "Turkish", uk: "Ukrainian", vi: "Vietnamese", zh: "Chinese",
};

const GEO_HEADERS = [
  "cf-ipcountry",
  "x-vercel-ip-country",
  "x-appengine-country",
  "fastly-client-geo-country",
  "x-country-code",
  "cloudfront-viewer-country",
];

export function clientIp(req) {
  const fwd = (req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return fwd || req.headers["x-real-ip"] || req.socket?.remoteAddress || "";
}

function countryFromHeaders(req) {
  for (const h of GEO_HEADERS) {
    const v = String(req.headers[h] || "").trim().toUpperCase();
    if (/^[A-Z]{2}$/.test(v) && v !== "XX") return { cca2: v, via: h };
  }
  return null;
}

function langFromAcceptLanguage(req) {
  const header = String(req.headers["accept-language"] || "");
  const first = header.split(",")[0]?.trim().toLowerCase();
  if (!first) return null;
  const [lang, regionTag] = first.split("-");
  if (!/^[a-z]{2}$/.test(lang)) return null;
  return { lang, cca2: regionTag ? regionTag.toUpperCase() : "", via: "accept-language" };
}

const ipCache = new Map(); // ip → { cca2, at }
const IP_CACHE_TTL = 6 * 3600 * 1000;

/** Optional network lookup. Disabled unless GEOIP_PROVIDER is set. */
async function countryFromIp(ip) {
  const provider = (process.env.GEOIP_PROVIDER || "").toLowerCase();
  if (!provider || !ip || /^(::1|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip)) return null;

  const cached = ipCache.get(ip);
  if (cached && Date.now() - cached.at < IP_CACHE_TTL) return { cca2: cached.cca2, via: `${provider} (cached)` };

  const url =
    provider === "ipapi"
      ? `https://ipapi.co/${encodeURIComponent(ip)}/country/`
      : provider === "ip-api"
        ? `http://ip-api.com/json/${encodeURIComponent(ip)}?fields=countryCode`
        : null;
  if (!url) return null;

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(2500) });
    if (!res.ok) return null;
    const body = (await res.text()).trim();
    const cca2 = provider === "ipapi" ? body.toUpperCase() : JSON.parse(body).countryCode;
    if (!/^[A-Z]{2}$/.test(cca2 || "")) return null;
    ipCache.set(ip, { cca2, at: Date.now() });
    return { cca2, via: provider };
  } catch {
    return null;
  }
}

export function langForCountry(cca2) {
  if (!cca2) return "";
  if (COUNTRY_LANG[cca2]) return COUNTRY_LANG[cca2];
  // Fall back to the country's own official language list from the catalog.
  const region = Object.values(REGIONS).find((r) => r.cca2 === cca2);
  const name = region?.languages?.[0];
  if (!name) return "";
  const hit = Object.entries(LANG_NAMES_EN).find(([, en]) => en === name);
  return hit ? hit[0] : "";
}

/**
 * Resolves the reader's country and reading language for one request.
 * @param {import("express").Request} req
 * @param {string} [explicitLang] overrides detection (a reader's own pick)
 * @returns {Promise<{lang:string, langName:string, country:string, via:string, explicit:boolean}>}
 */
export async function resolveReader(req, explicitLang) {
  const explicit = String(explicitLang ?? req.query?.lang ?? "").toLowerCase();
  if (/^[a-z]{2}$/.test(explicit)) {
    return {
      lang: explicit,
      langName: LANG_NAMES[explicit] || explicit.toUpperCase(),
      country: "",
      via: "explicit",
      explicit: true,
    };
  }

  const header = countryFromHeaders(req);
  const ipHit = header || (await countryFromIp(clientIp(req)));
  if (ipHit) {
    const lang = langForCountry(ipHit.cca2);
    if (lang) {
      return {
        lang,
        langName: LANG_NAMES[lang] || lang.toUpperCase(),
        country: ipHit.cca2,
        via: ipHit.via,
        explicit: false,
      };
    }
  }

  const accept = langFromAcceptLanguage(req);
  if (accept?.lang) {
    return {
      lang: accept.lang,
      langName: LANG_NAMES[accept.lang] || accept.lang.toUpperCase(),
      country: accept.cca2 || ipHit?.cca2 || "",
      via: accept.via,
      explicit: false,
    };
  }

  const fallback = config.translate.target || "en";
  return {
    lang: fallback,
    langName: LANG_NAMES[fallback] || fallback.toUpperCase(),
    country: ipHit?.cca2 || "",
    via: "default",
    explicit: false,
  };
}
