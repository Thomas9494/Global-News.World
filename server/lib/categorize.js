/**
 * Maps an article onto the topic taxonomy the frontend renders as filter chips.
 * The list and its order are taken verbatim from the design.
 */
export const CATEGORIES = [
  "All",
  "Politics",
  "Business",
  "Sports",
  "Culture",
  "Digital",
  "Science",
  "Health",
  "Lifestyle",
  "Society",
  "Entertainment",
  "Opinion",
  "Video",
  "Regional",
];

/**
 * Keyword sets per category, in the languages our feeds actually publish in.
 * Matching is accent-insensitive and word-boundary aware, so "art" does not
 * match "start". Feed-declared categories and URL path segments are weighted
 * higher than words found in the headline.
 */
const KEYWORDS = {
  Politics: [
    "politic", "politik", "politique", "politica", "política", "polityka", "politiek",
    "election", "wahl", "élection", "elecciones", "eleicoes", "eleições", "vote", "voting",
    "parliament", "parlament", "bundestag", "senate", "senat", "congress", "kongress",
    "government", "regierung", "gouvernement", "gobierno", "governo", "regering", "hallitus",
    "minister", "ministre", "ministro", "chancellor", "kanzler", "president", "präsident",
    "presidente", "président", "diplomat", "sanctions", "sanktionen", "treaty", "abkommen",
    "referendum", "coalition", "koalition", "opposition", "campaign", "wahlkampf", "geopolit",
    "white house", "kremlin", "downing street", "elysee", "élysée", "prime minister",
    "premierminister", "premier ministre", "primer ministro", "bundeskanzler", "lawmaker",
    "abgeordnete", "summit", "gipfel", "cabinet", "kabinett", "policy address", "un chief",
    "secretary of state", "foreign minister", "aussenminister", "außenminister", "envoy",
    "ambassador", "botschafter", "legislature", "bill passes", "gesetzentwurf", "veto",
    "military", "militär", "army", "armee", "war", "krieg", "guerre", "guerra", "conflict",
    "ceasefire", "waffenruhe", "nato", "united nations", "vereinte nationen", "eu summit",
  ],
  Business: [
    "business", "wirtschaft", "économie", "economia", "economía", "economy", "ekonomi",
    "market", "markt", "marché", "mercado", "mercato", "börse", "bourse", "stock", "aktien",
    "shares", "nasdaq", "dow jones", "dax", "ftse", "nikkei", "index",
    "bank", "banque", "banco", "finance", "finanz", "financial", "finanzas", "inflation",
    "interest rate", "zins", "leitzins", "taux", "recession", "rezession", "gdp", "bip",
    "trade", "handel", "commerce", "comercio", "tariff", "zoll", "export", "import",
    "company", "unternehmen", "entreprise", "empresa", "azienda", "corporate", "konzern",
    "startup", "ipo", "merger", "übernahme", "acquisition", "revenue", "umsatz", "profit",
    "gewinn", "bankruptcy", "insolvenz", "unemployment", "arbeitslos", "jobs", "salary",
    "lohn", "budget", "haushalt", "tax", "steuer", "impuesto", "crypto", "bitcoin",
    "oil price", "ölpreis", "housing", "immobilien", "real estate", "mortgage", "hypothek",
  ],
  Sports: [
    "sport", "sports", "deporte", "esporte", "футбол", "football", "fussball", "fußball",
    "soccer", "premier league", "bundesliga", "la liga", "serie a", "champions league",
    "world cup", "weltmeisterschaft", "wm-", "olympi", "olympia", "cricket", "rugby",
    "tennis", "basketball", "nba", "nfl", "mlb", "nhl", "hockey", "eishockey", "golf",
    "formula 1", "formel 1", "motogp", "cycling", "radsport", "tour de france", "marathon",
    "athlet", "boxing", "boxen", "ufc", "swimming", "schwimm", "ski", "skiing", "coach",
    "trainer", "striker", "goal", "match", "spieltag", "tournament", "turnier", "league",
  ],
  Culture: [
    "culture", "kultur", "cultura", "kunst", "art exhibition", "museum", "gallery",
    "galerie", "literature", "literatur", "literatura", "book", "buch", "livre", "libro",
    "novel", "roman", "poet", "author", "autor", "writer", "schriftsteller", "theatre",
    "theater", "théâtre", "teatro", "opera", "oper", "ballet", "ballett", "orchestra",
    "orchester", "classical music", "klassik", "architecture", "architektur", "heritage",
    "denkmal", "unesco", "festival", "biennale", "photography", "fotografie", "sculpture",
  ],
  Digital: [
    "tech", "technology", "technologie", "tecnologia", "tecnología", "digital", "digitale",
    "software", "hardware", "app", "apps", "smartphone", "iphone", "android", "computer",
    "internet", "online", "web", "website", "cloud", "server", "data centre", "data center",
    "rechenzentrum", "cyber", "hacker", "hacking", "ransomware", "malware", "phishing",
    "security breach", "datenschutz", "privacy", "encryption", "verschlüsselung",
    "artificial intelligence", "künstliche intelligenz", "intelligence artificielle",
    "ai model", "chatgpt", "openai", "algorithm", "algorithmus", "machine learning",
    "semiconductor", "halbleiter", "chip", "nvidia", "apple", "google", "microsoft",
    "meta", "tiktok", "social media", "soziale medien", "streaming platform", "5g",
    "robot", "roboter", "drone", "drohne", "blockchain", "quantum comput",
    "a.i.", "chatbot", "data breach", "datenleck", "app store", "spyware", "deepfake",
    "open source", "developer", "entwickler", "smart home", "electric vehicle", "elektroauto",
  ],
  Science: [
    "science", "wissenschaft", "ciencia", "ciência", "scienza", "research", "forschung",
    "recherche", "study finds", "studie", "estudio", "scientist", "forscher", "researcher",
    "university", "universität", "université", "universidad", "physics", "physik",
    "chemistry", "chemie", "biology", "biologie", "genetic", "genetik", "dna", "species",
    "climate", "klima", "clima", "climat", "global warming", "erderwärmung", "emission",
    "co2", "environment", "umwelt", "medio ambiente", "biodiversity", "artenvielfalt",
    "space", "weltraum", "espacio", "nasa", "esa", "spacex", "satellite", "satellit",
    "rocket", "rakete", "mars", "moon landing", "telescope", "teleskop", "astronom",
    "earthquake", "erdbeben", "volcano", "vulkan", "archaeolog", "archäolog", "fossil",
  ],
  Health: [
    "health", "gesundheit", "santé", "salud", "saúde", "salute", "medicine", "medizin",
    "medical", "medizinisch", "hospital", "krankenhaus", "spital", "hôpital", "hospital",
    "doctor", "arzt", "ärzte", "nurse", "pflege", "patient", "patienten", "disease",
    "krankheit", "virus", "covid", "corona", "influenza", "vaccine", "impfstoff", "impfung",
    "vacuna", "epidemic", "epidemie", "pandemic", "pandemie", "outbreak", "cancer", "krebs",
    "diabetes", "mental health", "psychische", "depression", "therapy", "therapie",
    "drug approval", "medikament", "pharma", "who warns", "surgery", "operation",
  ],
  Lifestyle: [
    "lifestyle", "leben", "food", "essen", "cuisine", "küche", "cocina", "cucina",
    "restaurant", "recipe", "rezept", "receta", "chef", "wine", "wein", "vino", "beer",
    "bier", "coffee", "kaffee", "fashion", "mode", "moda", "style", "design trend",
    "travel", "reise", "voyage", "viaje", "viagem", "tourism", "tourismus", "turismo",
    "holiday", "urlaub", "ferien", "vacation", "hotel", "airline", "flight", "flug",
    "garden", "garten", "home", "wohnen", "fitness", "yoga", "wellness", "beauty",
    "parenting", "familie", "family life", "pets", "haustier", "dating", "relationship",
  ],
  Society: [
    "society", "gesellschaft", "société", "sociedad", "social", "sozial", "community",
    "gemeinde", "school", "schule", "école", "escuela", "education", "bildung", "éducation",
    "student", "schüler", "teacher", "lehrer", "university tuition", "housing crisis",
    "wohnungsnot", "poverty", "armut", "homeless", "obdachlos", "migration", "migranten",
    "refugee", "flüchtling", "réfugié", "refugiado", "asylum", "asyl", "integration",
    "discrimination", "diskriminierung", "racism", "rassismus", "protest", "demonstration",
    "strike", "streik", "grève", "huelga", "union", "gewerkschaft", "religion", "kirche",
    "church", "mosque", "moschee", "crime", "kriminalität", "police", "polizei", "policía",
    "court", "gericht", "trial", "prozess", "verdict", "urteil", "prison", "gefängnis",
    "accident", "unfall", "fire brigade", "feuerwehr", "flood", "hochwasser", "storm",
    "sturm", "wildfire", "waldbrand", "rescue", "rettung",
  ],
  Entertainment: [
    "entertainment", "unterhaltung", "celebrity", "promi", "star", "hollywood", "bollywood",
    "film", "movie", "kino", "cinema", "cine", "netflix", "disney", "series", "serie",
    "tv show", "fernsehen", "music", "musik", "música", "musique", "album", "song", "band",
    "concert", "konzert", "concierto", "tour dates", "singer", "sänger", "rapper", "pop",
    "grammy", "oscar", "cannes", "berlinale", "eurovision", "game", "gaming", "videospiel",
    "playstation", "xbox", "nintendo", "esports", "comic", "anime", "manga",
  ],
  Opinion: [
    "opinion", "meinung", "kommentar", "commentary", "comment:", "editorial", "leitartikel",
    "analysis", "analyse", "análisis", "column", "kolumne", "chronique", "op-ed",
    "standpunkt", "debate", "debatte", "viewpoint", "perspective", "essay", "gastbeitrag",
    "interview", "letters to the editor", "leserbriefe",
  ],
  Video: [
    "video", "watch:", "live stream", "livestream", "live blog", "liveblog", "podcast",
    "documentary", "dokumentation", "doku", "reportage", "bildergalerie", "in pictures",
    "photo gallery", "gallery:", "audio", "radio", "sendung", "webcast",
  ],
  Regional: [
    "regional", "region", "local", "lokal", "local news", "lokales", "provincial",
    "kanton", "county", "district", "bezirk", "municipal", "gemeinde", "stadtrat",
    "city council", "mayor", "bürgermeister", "alcalde", "maire", "neighbourhood",
    "quartier", "village", "dorf", "rural", "ländlich",
  ],
};

/** Weights: feed-declared category > URL path > headline > summary. */
const WEIGHT = { category: 6, path: 4, title: 3, summary: 1 };

const deaccent = (s) =>
  String(s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");

const COMPILED = Object.entries(KEYWORDS).map(([cat, words]) => [
  cat,
  words.map((w) => ({ raw: w, plain: deaccent(w) })),
]);

function scoreField(text, weight, scores) {
  if (!text) return;
  const hay = " " + deaccent(text).replace(/[^\p{L}\p{N}]+/gu, " ") + " ";
  const rawHay = " " + String(text).toLowerCase() + " ";
  for (const [cat, words] of COMPILED) {
    for (const w of words) {
      const hit = w.plain.includes(" ") || /[^\p{L}]/u.test(w.raw)
        ? rawHay.includes(w.raw) || hay.includes(w.plain)
        : hay.includes(" " + w.plain + " ") || hay.includes(" " + w.plain + "s ");
      if (hit) {
        scores[cat] = (scores[cat] || 0) + weight;
        break; // one hit per category per field keeps long keyword lists fair
      }
    }
  }
}

/**
 * @param {{title?:string, summary?:string, categories?:string[], link?:string}} article
 * @returns {string} one of CATEGORIES (never "All")
 */
export function categorize(article = {}) {
  const scores = {};
  scoreField((article.categories || []).join(" "), WEIGHT.category, scores);

  let path = "";
  try {
    path = new URL(article.link).pathname.replace(/[-_/]+/g, " ");
  } catch {
    /* link may be missing or relative */
  }
  scoreField(path, WEIGHT.path, scores);
  scoreField(article.title, WEIGHT.title, scores);
  scoreField(article.summary, WEIGHT.summary, scores);

  let best = "";
  let bestScore = 0;
  for (const [cat, score] of Object.entries(scores)) {
    if (score > bestScore) {
      bestScore = score;
      best = cat;
    }
  }
  return bestScore > 0 ? best : "Society";
}
