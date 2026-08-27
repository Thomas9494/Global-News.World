import { config } from "./config.js";
import { createApp } from "./app.js";
import { startScheduler } from "./ingest.js";
import * as store from "./lib/store.js";

const app = createApp();

if (store.load()) {
  const s = store.getState().stats;
  console.log(`[store] restored snapshot: ${s.articles} articles / ${s.countries} countries`);
}

const server = app.listen(config.port, config.host, () => {
  console.log(`Global News → http://localhost:${config.port}`);
  startScheduler(console.log);
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    console.log(`\n[server] ${sig} — saving snapshot`);
    store.save();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
