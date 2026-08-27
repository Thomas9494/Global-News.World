import { config } from "../config.js";

/**
 * Fetches a URL and decodes the body using the charset the server (or the XML
 * prolog) declares. Many national outlets still ship windows-1251 / ISO-8859-1
 * feeds, which would otherwise arrive as mojibake.
 */
export async function fetchText(url, opts = {}) {
  const timeout = opts.timeoutMs ?? config.ingest.timeoutMs;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeout);
  const started = Date.now();
  try {
    const res = await fetch(url, {
      signal: ac.signal,
      redirect: "follow",
      headers: {
        "User-Agent": config.ingest.userAgent,
        Accept:
          "application/rss+xml, application/atom+xml, application/xml, text/xml, application/json;q=0.9, */*;q=0.8",
        "Accept-Language": "en;q=0.9, *;q=0.5",
        ...(opts.headers || {}),
      },
    });
    const ct = res.headers.get("content-type") || "";
    const buf = Buffer.from(await res.arrayBuffer());
    const text = decodeBuffer(buf, ct);
    return {
      ok: res.ok,
      status: res.status,
      contentType: ct,
      text,
      bytes: buf.length,
      ms: Date.now() - started,
      url: res.url || url,
    };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      contentType: "",
      text: "",
      bytes: 0,
      ms: Date.now() - started,
      url,
      error: err?.name === "AbortError" ? `timeout after ${timeout}ms` : String(err?.message || err),
    };
  } finally {
    clearTimeout(timer);
  }
}

export function decodeBuffer(buf, contentType = "") {
  let charset = /charset=["']?([\w-]+)/i.exec(contentType)?.[1];
  if (!charset) {
    // Sniff the XML prolog / HTML meta from the first bytes (ASCII-safe).
    const head = buf.subarray(0, 1024).toString("latin1");
    charset =
      /<\?xml[^>]*encoding=["']([\w-]+)["']/i.exec(head)?.[1] ||
      /<meta[^>]*charset=["']?([\w-]+)/i.exec(head)?.[1];
  }
  const cs = (charset || "utf-8").toLowerCase();
  if (cs === "utf-8" || cs === "utf8" || cs === "us-ascii" || cs === "ascii") {
    return buf.toString("utf8");
  }
  try {
    return new TextDecoder(cs, { fatal: false }).decode(buf);
  } catch {
    return buf.toString("utf8");
  }
}

/** Runs `worker` over `items` with a fixed number of parallel slots. */
export async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      try {
        results[i] = await worker(items[i], i);
      } catch (err) {
        results[i] = { error: String(err?.message || err) };
      }
    }
  });
  await Promise.all(runners);
  return results;
}
