import { config } from "../config.js";

/**
 * Pluggable machine translation.
 *
 * The project's premise is reading local reporting from anywhere in one
 * language you understand, so translation is a first-class part of the
 * pipeline — and it has to work on a fresh clone, with no signup and no key:
 *
 *   TRANSLATE_PROVIDER=auto            (default) DeepL or LibreTranslate when a
 *                                      key is configured, otherwise "free"
 *   TRANSLATE_PROVIDER=free            the key-less public services, tried in
 *                                      order until one answers:
 *                                      LibreTranslate mirrors → MyMemory
 *   TRANSLATE_PROVIDER=mymemory        MyMemory only — no signup, no key,
 *                                      5 000 chars a day, 50 000 with
 *                                      MYMEMORY_EMAIL set
 *   TRANSLATE_PROVIDER=libretranslate  one self-hosted or public instance
 *   TRANSLATE_PROVIDER=deepl           DeepL API
 *   TRANSLATE_PROVIDER=none            passthrough, articles stay in their
 *                                      original language
 *
 * Nothing is ever invented: if every backend is unavailable the original text
 * is returned untouched and the article is flagged as untranslated.
 */

let spentChars = 0;

/**
 * A backend that just failed is set aside for a few minutes rather than retried
 * for every article. The free mirrors go down without warning, and walking into
 * the same timeout on every request is what makes a page feel broken.
 */
const COOLOFF_MS = 5 * 60 * 1000;
const coolOff = new Map(); // backend name → the time it may be tried again
let lastGood = "";

export function translationStatus() {
  const chain = backends();
  return {
    provider: config.translate.provider,
    target: config.translate.target,
    enabled: chain.length > 0,
    budgetChars: config.translate.budgetChars,
    spentChars,
    backends: chain.map((b) => b.name),
    lastGood,
  };
}

export function resetTranslationBudget() {
  spentChars = 0;
  coolOff.clear();
  lastGood = "";
}

/**
 * Languages each provider can translate into, used to drive the UI selector.
 * The free chain advertises MyMemory's reach, because MyMemory is the member
 * that is always there.
 */
const FREE_TARGETS = [
  "de", "en", "fr", "es", "it", "pt", "nl", "pl", "ru", "uk", "tr", "ar", "zh", "ja", "hi",
];

export function supportedTargets() {
  switch (config.translate.provider) {
    case "none":
      return [];
    case "deepl":
      return ["de", "en", "fr", "es", "it", "pt", "nl", "pl", "ja", "zh"];
    case "libretranslate":
      return ["de", "en", "fr", "es", "it", "pt", "nl", "pl", "ru", "ar", "zh", "ja"];
    default:
      // "free" and "mymemory" both end on MyMemory, which brokers the major
      // engines and so covers every pair our feeds publish in.
      return FREE_TARGETS;
  }
}

const hostOf = (url) => {
  try {
    return new URL(url).host;
  } catch {
    return String(url);
  }
};

/**
 * The ordered backends the configured provider is willing to use.
 *
 * "free" is a chain rather than a single service because no key-less endpoint
 * is dependable on its own: a LibreTranslate instance takes a whole article in
 * one request and has no daily character budget, so it is tried first; MyMemory
 * is the floor that answers when the volunteer-run mirrors do not.
 */
function backends() {
  const p = config.translate.provider;
  if (p === "none") return [];
  if (p === "deepl") return [{ name: "deepl", run: deepl }];
  if (p === "mymemory") return [{ name: "mymemory", run: myMemory }];

  const libreAt = (url) => ({
    name: `libretranslate:${hostOf(url)}`,
    run: (texts, from, to) => libre(texts, from, to, url),
  });
  if (p === "libretranslate") return [libreAt(config.translate.libreUrl)];

  const chain = [];
  // A deliberately configured instance is always the best answer for a
  // deployment that has one; the public mirrors are the fallback for everyone
  // who just cloned the repo.
  if (config.translate.libreKey || process.env.LIBRETRANSLATE_URL) {
    chain.push(libreAt(config.translate.libreUrl));
  }
  for (const url of config.translate.libreMirrors) chain.push(libreAt(url));
  chain.push({ name: "mymemory", run: myMemory });
  return chain;
}

/**
 * Translates a batch of strings. Returns the input unchanged when translation
 * is disabled, over budget, or the provider errors.
 * @returns {Promise<{texts:string[], translated:boolean, provider:string, error?:string}>}
 */
export async function translateBatch(texts, from, to = config.translate.target) {
  const provider = config.translate.provider;
  const clean = texts.map((t) => String(t ?? ""));
  const noop = { texts: clean, translated: false, provider };

  if (provider === "none" || !to || from === to) return noop;

  const cost = clean.reduce((n, t) => n + t.length, 0);
  if (config.translate.budgetChars > 0 && spentChars + cost > config.translate.budgetChars) {
    return { ...noop, error: "translation budget exhausted for this cycle" };
  }

  const chain = backends();
  if (!chain.length) return { ...noop, error: "no translation backend configured" };

  // A backend still cooling off is only tried when nothing else is left, so a
  // total outage still gets one real attempt instead of a stale error note.
  const now = Date.now();
  const ready = chain.filter((b) => (coolOff.get(b.name) || 0) <= now);
  const order = ready.length ? ready : chain;

  let lastError = "";
  for (const backend of order) {
    try {
      const out = await backend.run(clean, from, to);
      if (!out || out.length !== clean.length) throw new Error("backend returned no result");
      coolOff.delete(backend.name);
      lastGood = backend.name;
      spentChars += cost;
      return { texts: out, translated: true, provider: backend.name };
    } catch (err) {
      lastError = `${backend.name}: ${String(err?.message || err)}`;
      coolOff.set(backend.name, Date.now() + COOLOFF_MS);
    }
  }
  return { ...noop, error: lastError || "translation unavailable" };
}

async function deepl(texts, from, to) {
  const res = await fetch(`${config.translate.deeplUrl}/v2/translate`, {
    method: "POST",
    headers: {
      Authorization: `DeepL-Auth-Key ${config.translate.deeplKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      text: texts,
      target_lang: to.toUpperCase(),
      ...(from ? { source_lang: from.toUpperCase() } : {}),
    }),
    signal: AbortSignal.timeout(config.translate.timeoutMs),
  });
  if (!res.ok) throw new Error(`DeepL ${res.status}`);
  const data = await res.json();
  return (data.translations || []).map((t) => t.text);
}

async function libre(texts, from, to, url = config.translate.libreUrl) {
  const res = await fetch(`${String(url).replace(/\/+$/, "")}/translate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      q: texts,
      source: from || "auto",
      target: to,
      format: "text",
      ...(config.translate.libreKey ? { api_key: config.translate.libreKey } : {}),
    }),
    signal: AbortSignal.timeout(config.translate.timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  const t = data.translatedText;
  return Array.isArray(t) ? t : [t];
}

/* ------------------------------------------------------------- MyMemory -- */
/**
 * The only provider here that needs no account, which is why "auto" ends up on
 * it: a fresh clone translates foreign press without anyone signing up for
 * anything. Two constraints shape the code below.
 *
 * One string per request — there is no batch endpoint — and a hard cap of about
 * 500 bytes on `q`. Article bodies are therefore split on sentence boundaries,
 * translated piece by piece and stitched back together. Requests go out two at
 * a time: enough to keep a panel responsive, gentle enough not to be throttled.
 *
 * The free allowance is 5 000 characters a day anonymously and 50 000 with
 * MYMEMORY_EMAIL set. When it runs out MyMemory answers 200 with the quota
 * notice in the translation field, so that case is detected explicitly rather
 * than passed off to the reader as a translation.
 */
const MYMEMORY_MAX_Q = 480;
const MYMEMORY_CONCURRENCY = 2;

/**
 * Splits text into pieces MyMemory will accept, preferring sentence ends over
 * word breaks so each piece still reads as a unit to the translator.
 */
export function chunkForTranslation(text, max = MYMEMORY_MAX_Q) {
  const out = [];
  let rest = String(text ?? "").trim();
  while (rest.length > max) {
    const head = rest.slice(0, max);
    let cut = Math.max(head.lastIndexOf(". "), head.lastIndexOf("! "), head.lastIndexOf("? "));
    if (cut < max * 0.4) cut = head.lastIndexOf(" ");
    if (cut <= 0) cut = max; // one very long word: a hard cut is the only option
    else cut += 1;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out;
}

/** Runs `job` over `items` with a small fixed concurrency, preserving order. */
async function mapLimit(items, limit, job) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await job(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

const QUOTA_NOTICE = /^(MYMEMORY WARNING|YOU USED ALL AVAILABLE FREE TRANSLATIONS|PLEASE SELECT TWO DISTINCT)/i;

async function myMemoryOne(text, from, to) {
  const url = new URL("/get", config.translate.myMemoryUrl);
  url.searchParams.set("q", text);
  // MyMemory takes "Autodetect" when the feed never declared a language
  url.searchParams.set("langpair", `${from || "Autodetect"}|${to}`);
  if (config.translate.myMemoryEmail) url.searchParams.set("de", config.translate.myMemoryEmail);
  if (config.translate.myMemoryKey) url.searchParams.set("key", config.translate.myMemoryKey);

  const res = await fetch(url, { signal: AbortSignal.timeout(config.translate.timeoutMs) });
  if (!res.ok) throw new Error(`MyMemory ${res.status}`);
  const data = await res.json();

  const status = Number(data.responseStatus);
  if (status && status !== 200) {
    throw new Error(`MyMemory ${status}: ${data.responseDetails || "request refused"}`);
  }
  const out = data.responseData?.translatedText;
  if (typeof out !== "string") throw new Error("MyMemory returned no text");
  if (data.quotaFinished || QUOTA_NOTICE.test(out)) {
    throw new Error(
      "MyMemory daily quota reached — set MYMEMORY_EMAIL for 50 000 characters a day"
    );
  }
  return out;
}

async function myMemory(texts, from, to) {
  // one flat queue of pieces, so the concurrency limit applies across the whole
  // article rather than per paragraph
  const pieces = [];
  const plan = texts.map((t) => {
    const parts = chunkForTranslation(t);
    const at = pieces.length;
    pieces.push(...parts);
    return { at, count: parts.length };
  });
  if (!pieces.length) return texts.map(() => "");

  const done = await mapLimit(pieces, MYMEMORY_CONCURRENCY, (p) => myMemoryOne(p, from, to));
  return plan.map((p) => (p.count ? done.slice(p.at, p.at + p.count).join(" ") : ""));
}
