import test from "node:test";
import assert from "node:assert/strict";

import { stripHtml, toParagraphs, truncate, relativeTime, canonicalUrl, hash } from "../server/lib/text.js";
import { parseFeed, detectFormat } from "../server/lib/feedparser.js";
import { decodeBuffer, mapLimit } from "../server/lib/http.js";
import { categorize, CATEGORIES } from "../server/lib/categorize.js";
import { detectLang, resolveLang, langFromCatalog, normalizeLang } from "../server/lib/lang.js";
import { detectCity, routeCountry, countryCenter, ccn3ForSourceKey, isGroupKey, REGIONS } from "../server/lib/geo.js";
import { normalizeItem, dedupe, parseDate } from "../server/ingest.js";
import { langForCountry, resolveReader, LANG_NAMES } from "../server/lib/geoip.js";

/* ------------------------------------------------------------------ text -- */

test("stripHtml removes markup and decodes entities", () => {
  assert.equal(stripHtml("<p>Caf&eacute; &amp; <b>Bar</b></p>"), "Café & Bar");
  assert.equal(stripHtml("<script>evil()</script>Text"), "Text");
  assert.equal(stripHtml("a&#8211;b"), "a–b");
  assert.equal(stripHtml(null), "");
});

test("toParagraphs splits into readable chunks", () => {
  const long = "Erster Satz hier. " + "Ein weiterer, deutlich längerer Satz mit vielen Wörtern. ".repeat(8);
  const paras = toParagraphs(long);
  assert.ok(paras.length > 1);
  assert.ok(paras.length <= 6);
  assert.equal(toParagraphs("").length, 0);
});

test("truncate cuts on a word boundary", () => {
  assert.equal(truncate("short", 20), "short");
  const t = truncate("one two three four five six seven eight", 20);
  assert.ok(t.length <= 21);
  assert.ok(t.endsWith("…"));
});

test("relativeTime matches the card format", () => {
  const now = Date.parse("2026-08-28T12:00:00Z");
  assert.equal(relativeTime(now - 12 * 60000, now), "12 min ago");
  assert.equal(relativeTime(now - 3 * 3600e3, now), "3h ago");
  assert.equal(relativeTime(now - 2 * 86400e3, now), "2d ago");
  assert.equal(relativeTime(now - 5000, now), "just now");
});

test("canonicalUrl strips tracking parameters", () => {
  assert.equal(canonicalUrl("https://www.x.com/a?utm_source=rss&id=2#frag"), "https://x.com/a?id=2");
  assert.equal(canonicalUrl("not a url"), "not a url");
});

test("hash is stable and differs per input", () => {
  assert.equal(hash("abc"), hash("abc"));
  assert.notEqual(hash("abc"), hash("abd"));
});

/* ------------------------------------------------------------- feedparser -- */

const RSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/" xmlns:dc="http://purl.org/dc/elements/1.1/">
<channel><title>Demo Wire</title><language>de-DE</language><link>https://demo.example</link>
<item>
  <title>Bundesrat einigt sich auf Kompromiss</title>
  <link>https://demo.example/a/1?utm_medium=rss</link>
  <description>&lt;p&gt;Nach Verhandlungen liegt ein Kompromiss vor.&lt;/p&gt;</description>
  <content:encoded xmlns:content="http://purl.org/rss/1.0/modules/content/">Langer Text. Zweiter Satz.</content:encoded>
  <pubDate>Wed, 27 Aug 2026 09:15:00 GMT</pubDate>
  <category>Politik</category>
  <dc:creator>Redaktion</dc:creator>
  <media:content url="https://img.example/pic.jpg" type="image/jpeg"/>
</item>
</channel></rss>`;

const ATOM = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xml:lang="en">
<title>Atom Wire</title><link rel="self" href="https://a.example/feed"/><link rel="alternate" href="https://a.example/"/>
<entry><title>Parliament votes on election law</title>
  <link rel="alternate" href="https://a.example/story"/>
  <id>tag:a.example,2026:1</id>
  <summary>Thousands rally outside parliament.</summary>
  <published>2026-08-27T08:00:00Z</published>
</entry></feed>`;

const RDF = `<?xml version="1.0"?>
<rdf:RDF xmlns="http://purl.org/rss/1.0/" xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:dc="http://purl.org/dc/elements/1.1/">
<channel><title>RDF Wire</title></channel>
<item rdf:about="https://r.example/1"><title>Headline one</title><link>https://r.example/1</link>
<description>Body text.</description><dc:date>2026-08-27T07:00:00Z</dc:date></item>
</rdf:RDF>`;

const JSONFEED = JSON.stringify({
  version: "https://jsonfeed.org/version/1.1",
  title: "JSON Wire",
  language: "nl",
  items: [
    { id: "1", url: "https://j.example/1", title: "Kabinet valt", content_text: "Toelichting.", date_published: "2026-08-27T10:00:00Z" },
  ],
});

test("detectFormat recognises every supported shape", () => {
  assert.equal(detectFormat(RSS), "rss");
  assert.equal(detectFormat(ATOM), "atom");
  assert.equal(detectFormat(RDF), "rdf");
  assert.equal(detectFormat(JSONFEED), "json");
});

test("parseFeed reads RSS 2.0 including media, categories and content", () => {
  const f = parseFeed(RSS);
  assert.equal(f.format, "rss");
  assert.equal(f.meta.language, "de-de");
  assert.equal(f.items.length, 1);
  const i = f.items[0];
  assert.equal(i.title, "Bundesrat einigt sich auf Kompromiss");
  assert.equal(i.link, "https://demo.example/a/1");
  assert.equal(i.summary, "Nach Verhandlungen liegt ein Kompromiss vor.");
  assert.match(i.content, /Langer Text/);
  assert.equal(i.image, "https://img.example/pic.jpg");
  assert.deepEqual(i.categories, ["Politik"]);
  assert.equal(i.author, "Redaktion");
});

test("parseFeed reads Atom", () => {
  const f = parseFeed(ATOM);
  assert.equal(f.format, "atom");
  assert.equal(f.items[0].link, "https://a.example/story");
  assert.equal(f.items[0].title, "Parliament votes on election law");
});

test("parseFeed reads RSS 1.0 / RDF", () => {
  const f = parseFeed(RDF);
  assert.equal(f.format, "rdf");
  assert.equal(f.items[0].link, "https://r.example/1");
});

test("parseFeed reads JSON Feed", () => {
  const f = parseFeed(JSONFEED, "application/feed+json");
  assert.equal(f.format, "jsonfeed");
  assert.equal(f.items[0].title, "Kabinet valt");
});

test("parseFeed survives malformed input instead of throwing", () => {
  const f = parseFeed("<rss><channel><item><title>Unclosed");
  assert.ok(Array.isArray(f.items));
});

test("parseFeed handles feeds with thousands of entities", () => {
  const many = Array.from({ length: 2000 }, (_, i) => `<item><title>A &amp; B ${i}</title><link>https://e.example/${i}</link></item>`).join("");
  const f = parseFeed(`<rss version="2.0"><channel><title>t</title>${many}</channel></rss>`);
  assert.equal(f.items.length, 2000);
  assert.equal(f.items[0].title, "A & B 0");
});

/* ------------------------------------------------------------------ http -- */

test("decodeBuffer honours the declared charset", () => {
  const utf8 = Buffer.from("Grüße", "utf8");
  assert.equal(decodeBuffer(utf8, "text/xml; charset=utf-8"), "Grüße");
  const latin = Buffer.from([0x47, 0x72, 0xfc, 0xdf, 0x65]); // "Grüße" in latin1
  assert.equal(decodeBuffer(latin, "text/xml; charset=iso-8859-1"), "Grüße");
});

test("decodeBuffer sniffs the XML prolog when no header is set", () => {
  const buf = Buffer.concat([
    Buffer.from(`<?xml version="1.0" encoding="windows-1251"?><rss>`, "latin1"),
    Buffer.from([0xcc, 0xee, 0xf1, 0xea, 0xe2, 0xe0]), // Москва
  ]);
  assert.match(decodeBuffer(buf, ""), /Москва/);
});

test("mapLimit runs everything and never rejects on a worker error", async () => {
  const out = await mapLimit([1, 2, 3, 4, 5], 2, async (n) => {
    if (n === 3) throw new Error("boom");
    return n * 2;
  });
  assert.equal(out.length, 5);
  assert.equal(out[0], 2);
  assert.deepEqual(out[2], { error: "boom" });
});

/* ------------------------------------------------------------ categorize -- */

test("categorize returns a category from the design's taxonomy", () => {
  for (const t of ["a", "Zinsentscheid der Notenbank", "Champions League final"]) {
    assert.ok(CATEGORIES.includes(categorize({ title: t })));
  }
});

test("categorize recognises topics across languages", () => {
  assert.equal(categorize({ title: "SNB senkt den Leitzins auf 0,25 Prozent" }), "Business");
  assert.equal(categorize({ title: "Bayern gewinnt das Spitzenspiel der Bundesliga" }), "Sports");
  assert.equal(categorize({ title: "Le parlement vote une nouvelle loi électorale" }), "Politics");
  assert.equal(categorize({ title: "Nueva vacuna contra el cáncer aprobada" }), "Health");
  assert.equal(categorize({ title: "Why China Loves A.I." }), "Digital");
});

test("categorize weights the feed's own category above the headline", () => {
  const c = categorize({ title: "A quiet morning", categories: ["Sport"], summary: "" });
  assert.equal(c, "Sports");
});

test("categorize never matches a keyword inside a longer word", () => {
  // "war" must not fire on "warm", "goal" not on "goalkeeper-free text"
  assert.notEqual(categorize({ title: "A warm and pleasant afternoon in the park" }), "Politics");
});

/* ------------------------------------------------------------------ lang -- */

test("detectLang identifies scripts", () => {
  assert.equal(detectLang("รัฐบาลไทยประกาศมาตรการใหม่วันนี้"), "th");
  assert.equal(detectLang("Правительство объявило о новых мерах сегодня"), "ru");
  assert.equal(detectLang("Уряд оголосив про нові заходи, які діють з понеділка"), "uk");
  assert.equal(detectLang("東京都は新しい対策を発表しました"), "ja");
});

test("detectLang scores Latin-script stop words", () => {
  assert.equal(detectLang("Der Bundesrat hat sich mit der Kommission auf das neue Abkommen geeinigt"), "de");
  assert.equal(detectLang("The government said that the new rules will apply from Monday"), "en");
  assert.equal(detectLang("Het kabinet heeft besloten dat de nieuwe regels niet voor iedereen gelden"), "nl");
});

test("resolveLang prefers explicit tags over detection", () => {
  assert.equal(resolveLang({ itemLang: "pt-BR", text: "The government said" }), "pt");
  assert.equal(resolveLang({ feedLang: "sv", text: "hi" }), "sv");
  assert.equal(resolveLang({ catalogLang: "IT", text: "xx" }), "it");
  assert.equal(resolveLang({ text: "" }), "en");
});

test("langFromCatalog reads the curated column", () => {
  assert.equal(langFromCatalog("FR/EN"), "fr");
  assert.equal(langFromCatalog(""), "");
  assert.equal(normalizeLang("de_CH"), "de");
});

/* ------------------------------------------------------------------- geo -- */

test("detectCity finds cities including native spellings", () => {
  assert.deepEqual(detectCity("Neues aus Zürich heute", "756"), { city: "Zurich", ll: [8.54, 47.37] });
  assert.equal(detectCity("Fondue-Preis in Luzern", "756").city, "Lucerne");
  assert.equal(detectCity("Streik in München", "276").city, "Munich");
  assert.equal(detectCity("Nothing here", "756"), null);
});

test("detectCity prefers the longest match", () => {
  assert.equal(detectCity("A story from New York today", "840").city, "New York");
});

test("routeCountry assigns wire copy to the right country", () => {
  assert.equal(routeCountry("Kenyan police clash with protesters in Nairobi").ccn3, "404");
  assert.equal(routeCountry("Thailand parliament votes on election law in Bangkok").ccn3, "764");
  assert.equal(routeCountry("Brazil president visits Rio de Janeiro").ccn3, "076");
});

test("routeCountry refuses to guess", () => {
  assert.equal(routeCountry("A quiet day with nothing much happening"), null);
  assert.equal(routeCountry(""), null);
});

test("catalog maps every curated source group", () => {
  assert.equal(ccn3ForSourceKey("Switzerland"), "756");
  assert.equal(ccn3ForSourceKey("Turkey"), "792");
  assert.equal(ccn3ForSourceKey("Hong Kong"), "344");
  assert.equal(ccn3ForSourceKey("Global"), null);
  assert.ok(isGroupKey("Global"));
  assert.ok(isGroupKey("EU"));
  assert.ok(!isGroupKey("Japan"));
});

test("region descriptors keep the design's hand-tuned values", () => {
  assert.deepEqual(REGIONS["756"].ll, [8.23, 46.8]);
  assert.equal(REGIONS["756"].z, 6.6);
  assert.equal(REGIONS["756"].min, 5.2);
  assert.equal(REGIONS["840"].z, 4.0);
  assert.equal(REGIONS["344"].z, 9.8);
  assert.deepEqual(countryCenter("764"), [100.99, 15.87]);
});

/* ---------------------------------------------------------------- ingest -- */

test("parseDate understands the shapes feeds emit", () => {
  assert.equal(parseDate("Wed, 27 Aug 2026 09:15:00 GMT"), Date.parse("2026-08-27T09:15:00Z"));
  assert.equal(parseDate("2026-08-27T09:15:00Z"), Date.parse("2026-08-27T09:15:00Z"));
  assert.equal(parseDate("2026-08-27 09:15:00"), Date.parse("2026-08-27T09:15:00"));
  assert.equal(parseDate("27.08.2026 09:15"), Date.UTC(2026, 7, 27, 9, 15));
  assert.equal(parseDate(""), null);
});

const rawItem = (over = {}) => ({
  title: "Bundesrat einigt sich auf Kompromiss mit der EU",
  link: "https://demo.example/a/1",
  summary: "Nach monatelangen Verhandlungen liegt in Bern ein Kompromiss auf dem Tisch.",
  content: "Erster Absatz. Zweiter Absatz mit weiterem Inhalt.",
  published: new Date().toISOString(),
  image: "https://img.example/pic.jpg",
  categories: ["Politik"],
  src: "SRF News",
  srcHome: "https://www.srf.ch/news",
  sourceKey: "Switzerland",
  catalogLang: "de",
  feedLang: "de-CH",
  plugin: "rss",
  ...over,
});

test("normalizeItem produces the shape the map renders", () => {
  const a = normalizeItem(rawItem());
  assert.equal(a.ccn3, "756");
  assert.equal(a.country, "Switzerland");
  assert.equal(a.lang, "de");
  assert.equal(a.cat, "Politics");
  assert.equal(a.city, "Bern");
  assert.deepEqual(a.ll, [7.44, 46.95]);
  assert.equal(a.src, "SRF News");
  assert.equal(a.img, "https://img.example/pic.jpg");
  assert.ok(a.id && a.url && a.publishedAt && a.time);
  assert.ok(a.orig.title && a.orig.teaser && a.orig.lede);
  assert.ok(Array.isArray(a.orig.body) && a.orig.body.length);
  // articles are stored untranslated — that is the API layer's job
  assert.equal(a.read, undefined);
});

test("without a city in the headline the article sits at its newsroom", () => {
  const a = normalizeItem(rawItem({ summary: "Ein Kompromiss liegt vor.", title: "Kompromiss gefunden" }));
  assert.equal(a.city, "", "no place named in the text");
  assert.equal(a.srcCity, "Zurich", "SRF News is a Zurich newsroom");
  assert.deepEqual(a.ll, [8.54, 47.37]);
});

test("an outlet with no known home sits at the country centre", () => {
  const a = normalizeItem(
    rawItem({ src: "Ein unbekanntes Blatt", summary: "Ein Kompromiss liegt vor.", title: "Kompromiss gefunden" })
  );
  assert.equal(a.city, "");
  assert.equal(a.srcCity, "");
  assert.deepEqual(a.ll, REGIONS["756"].ll);
});

test("normalizeItem rejects unusable and stale items", () => {
  assert.equal(normalizeItem(rawItem({ title: "" })), null);
  assert.equal(normalizeItem(rawItem({ link: "" })), null);
  assert.equal(normalizeItem(rawItem({ published: "2001-01-01T00:00:00Z" })), null);
  // an unknown source group with nothing to geo-locate is dropped, not guessed
  assert.equal(normalizeItem(rawItem({ sourceKey: "Global", title: "Nothing identifiable", summary: "" })), null);
});

test("normalizeItem routes worldwide wire copy to the country it is about", () => {
  const a = normalizeItem(
    rawItem({ sourceKey: "Global", src: "BBC News – World", title: "Kenya police clash with protesters in Nairobi", summary: "" })
  );
  assert.equal(a.ccn3, "404");
  assert.equal(a.city, "Nairobi");
  assert.equal(a.routedFrom.sourceKey, "Global");
});

test("normalizeItem drops non-http images rather than passing them through", () => {
  assert.equal(normalizeItem(rawItem({ image: "javascript:alert(1)" })).img, "");
  assert.equal(normalizeItem(rawItem({ image: "/relative.jpg" })).img, "");
});

test("dedupe removes repeats by url and by headline within a country", () => {
  const a = normalizeItem(rawItem());
  const sameUrl = normalizeItem(rawItem({ title: "Andere Schlagzeile in Bern" }));
  const sameTitle = normalizeItem(rawItem({ link: "https://demo.example/a/2" }));
  const other = normalizeItem(rawItem({ link: "https://demo.example/a/3", title: "Ganz andere Meldung aus Bern" }));
  const out = dedupe([a, sameUrl, sameTitle, other]);
  const urls = out.map((x) => x.url);
  assert.equal(new Set(urls).size, urls.length);
  assert.ok(out.length < 4);
  assert.ok(out.length >= 2);
});

/* ----------------------------------------------------------- reader lang -- */

test("langForCountry maps a visitor's country to a reading language", () => {
  assert.equal(langForCountry("NL"), "nl");
  assert.equal(langForCountry("BE"), "nl");
  assert.equal(langForCountry("CH"), "de");
  assert.equal(langForCountry("BR"), "pt");
  assert.equal(langForCountry("JP"), "ja");
  assert.equal(langForCountry(""), "");
});

const fakeReq = (headers = {}, query = {}) => ({ headers, query, socket: { remoteAddress: "203.0.113.9" } });

test("resolveReader prefers an explicit choice", async () => {
  const r = await resolveReader(fakeReq({}, { lang: "fr" }));
  assert.equal(r.lang, "fr");
  assert.equal(r.via, "explicit");
  assert.equal(r.explicit, true);
});

test("resolveReader reads a CDN geo header — a visitor from NL gets Dutch", async () => {
  const r = await resolveReader(fakeReq({ "cf-ipcountry": "NL" }));
  assert.equal(r.lang, "nl");
  assert.equal(r.langName, LANG_NAMES.nl);
  assert.equal(r.country, "NL");
  assert.equal(r.via, "cf-ipcountry");
});

test("resolveReader falls back to Accept-Language, then to the default", async () => {
  const r = await resolveReader(fakeReq({ "accept-language": "sv-SE,sv;q=0.9,en;q=0.8" }));
  assert.equal(r.lang, "sv");
  assert.equal(r.via, "accept-language");

  const d = await resolveReader(fakeReq({}));
  assert.ok(d.lang.length === 2);
  assert.equal(d.via, "default");
});

test("an explicit parameter overrides the geo header", async () => {
  const r = await resolveReader(fakeReq({ "cf-ipcountry": "NL" }), "de");
  assert.equal(r.lang, "de");
});
