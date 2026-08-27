import express from "express";
import compression from "compression";
import { config } from "./config.js";
import { api, sourcesByRegionName } from "./routes/api.js";

/**
 * Builds the HTTP app. Kept separate from index.js so tests can mount it
 * without opening a port or starting the ingest scheduler.
 */
export function createApp() {
  const app = express();
  app.disable("x-powered-by");
  // Behind a proxy/CDN, trust the forwarded client IP so reader-language
  // detection sees the visitor rather than the load balancer.
  app.set("trust proxy", true);
  // The map bundle is a few hundred kB of JSON — always worth compressing.
  app.use(compression());
  app.use(express.json({ limit: "64kb" }));

  app.use((req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer-when-downgrade");
    if (req.path.startsWith("/api/")) res.setHeader("Cache-Control", "no-store");
    next();
  });

  app.use("/api", api);

  /**
   * The outlet catalog as a plain script, so the page keeps the
   * `window.NEWS_SOURCES` contract the design was built against.
   */
  app.get("/sources.js", (_req, res) => {
    res.type("application/javascript");
    res.setHeader("Cache-Control", "public, max-age=300");
    res.send(`window.NEWS_SOURCES=${JSON.stringify(sourcesByRegionName())};`);
  });

  app.use(
    express.static(config.paths.public, {
      extensions: ["html"],
      setHeaders(res, path) {
        if (path.endsWith(".html")) res.setHeader("Cache-Control", "no-cache");
      },
    })
  );

  app.use((_req, res) => res.status(404).json({ error: "not found" }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    console.error("[server]", err);
    res.status(500).json({ error: "internal error" });
  });

  return app;
}
