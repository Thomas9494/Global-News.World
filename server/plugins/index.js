import rss from "./rss.js";
import citypress from "./citypress.js";
import googlenews from "./googlenews.js";
import opml from "./opml.js";
import gdelt from "./gdelt.js";
import newsapi from "./newsapi.js";
import gnews from "./gnews.js";

/**
 * The plugin registry.
 *
 * A news plugin is any module that exports:
 *
 *   {
 *     id: string,                       // stable identifier, used in reports
 *     label: string,                    // human-readable name
 *     enabled(): boolean,               // read from config / env
 *     collect(ctx): Promise<{ items, health }>
 *   }
 *
 * `items` are raw article records (see server/ingest.js for the fields the
 * pipeline consumes); `health` is one record per upstream endpoint so
 * `npm run check:feeds` and GET /api/health can report exactly what worked.
 *
 * To add a source type — a newsroom API, a Mastodon feed, an OPML import, a
 * national wire — drop a module in this folder and register it here. Nothing
 * else in the pipeline needs to change.
 */
export const PLUGINS = [rss, citypress, opml, googlenews, gdelt, newsapi, gnews];

export function activePlugins() {
  return PLUGINS.filter((p) => p.enabled());
}

export function pluginInfo() {
  return PLUGINS.map((p) => ({ id: p.id, label: p.label, enabled: p.enabled() }));
}
