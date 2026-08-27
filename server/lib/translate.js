import { config } from "../config.js";

/**
 * Pluggable machine translation.
 *
 * The project's premise is reading local reporting from anywhere in one
 * language you understand, so translation is a first-class part of the
 * pipeline — but it always needs a provider you control:
 *
 *   TRANSLATE_PROVIDER=none            passthrough, articles stay in their
 *                                      original language (default)
 *   TRANSLATE_PROVIDER=libretranslate  self-hosted or public LibreTranslate
 *   TRANSLATE_PROVIDER=deepl           DeepL API (free or pro tier)
 *
 * Nothing is ever invented: if a provider is unavailable the original text is
 * returned untouched and the article is flagged as untranslated.
 */

let spentChars = 0;

export function translationStatus() {
  return {
    provider: config.translate.provider,
    target: config.translate.target,
    enabled: config.translate.provider !== "none",
    budgetChars: config.translate.budgetChars,
    spentChars,
  };
}

export function resetTranslationBudget() {
  spentChars = 0;
}

/** Languages each provider can translate into, used to drive the UI selector. */
export function supportedTargets() {
  switch (config.translate.provider) {
    case "deepl":
      return ["de", "en", "fr", "es", "it", "pt", "nl", "pl", "ja", "zh"];
    case "libretranslate":
      return ["de", "en", "fr", "es", "it", "pt", "nl", "pl", "ru", "ar", "zh", "ja"];
    default:
      return [];
  }
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

  try {
    const out =
      provider === "deepl"
        ? await deepl(clean, from, to)
        : provider === "libretranslate"
          ? await libre(clean, from, to)
          : null;
    if (!out || out.length !== clean.length) return { ...noop, error: "provider returned no result" };
    spentChars += cost;
    return { texts: out, translated: true, provider };
  } catch (err) {
    return { ...noop, error: String(err?.message || err) };
  }
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
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`DeepL ${res.status}`);
  const data = await res.json();
  return (data.translations || []).map((t) => t.text);
}

async function libre(texts, from, to) {
  const res = await fetch(`${config.translate.libreUrl}/translate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      q: texts,
      source: from || "auto",
      target: to,
      format: "text",
      ...(config.translate.libreKey ? { api_key: config.translate.libreKey } : {}),
    }),
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`LibreTranslate ${res.status}`);
  const data = await res.json();
  const t = data.translatedText;
  return Array.isArray(t) ? t : [t];
}
