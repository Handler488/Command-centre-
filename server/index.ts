import { createPlatform } from './app.ts';
import { config } from './config.ts';
import { openDatabase } from './db.ts';

const db = openDatabase(config.databasePath);
const { app, news, cache } = createPlatform(db);

const server = app.listen(config.port, () => {
  console.log(`Command Centre API listening on http://localhost:${config.port}`);
  console.log(`  database: ${config.databasePath}`);
  console.log(`  AI analyst: ${config.anthropicApiKey ? `enabled (${config.analystModel})` : 'disabled (no ANTHROPIC_API_KEY)'}`);
});

// Background ingestion: once at boot, then on the configured interval.
async function ingest() {
  try {
    const results = await news.refresh();
    const failed = results.filter((r) => !r.ok);
    console.log(`[news] refresh: +${results.reduce((a, r) => a + r.inserted, 0)} articles from ${results.length - failed.length}/${results.length} sources`);
    for (const f of failed) console.warn(`[news]   ${f.name}: ${f.error}`);
  } catch (err) {
    console.error('[news] refresh failed', err);
  }
}
let timer: NodeJS.Timeout | undefined;
if (config.newsRefreshMinutes > 0) {
  void ingest();
  timer = setInterval(() => void ingest(), config.newsRefreshMinutes * 60_000);
  timer.unref();
}
const housekeeping = setInterval(() => cache.prune(), 6 * 3_600_000);
housekeeping.unref();

function shutdown(signal: string) {
  console.log(`${signal} received, shutting down`);
  clearInterval(timer);
  clearInterval(housekeeping);
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 5000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
