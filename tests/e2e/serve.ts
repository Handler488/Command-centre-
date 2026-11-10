/**
 * Boots the real application against the mock upstream for browser tests.
 * A throwaway database is used; nothing here touches real providers or data.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MOCK_PORT = Number(process.env.MOCK_PORT ?? 4598);
const PORT = Number(process.env.PORT ?? 4010);
const MOCK = `http://127.0.0.1:${MOCK_PORT}`;
const dbFile = process.env.E2E_DB ?? path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cc-e2e-')), 'e2e.db');
Object.assign(process.env, {
  NODE_ENV: 'production',
  PORT: String(PORT),
  DATABASE_PATH: dbFile,
  NEWS_REFRESH_MINUTES: '0',
  ANTHROPIC_API_KEY: process.env.E2E_NO_AI ? '' : 'test-key',
  ANTHROPIC_BASE_URL: `${MOCK}/anthropic`,
  YAHOO_CHART_BASE: `${MOCK}/yahoo`,
  YAHOO_SEARCH_BASE: `${MOCK}/yahoo`,
  STOOQ_BASE: `${MOCK}/stooq`,
  SEC_DATA_BASE: `${MOCK}/sec`,
  SEC_WWW_BASE: `${MOCK}/sec`,
  GDELT_BASE: `${MOCK}/gdelt`,
});

const { startMockUpstream } = await import('../fixtures/upstream.ts');
const { createPlatform } = await import('../../server/app.ts');
const { openDatabase } = await import('../../server/db.ts');

await startMockUpstream(MOCK_PORT);
const db = openDatabase(process.env.DATABASE_PATH!);
const platform = createPlatform(db);
// Replace the real feeds with fixture feeds so no test reaches the internet.
for (const s of platform.news.listSources()) platform.news.setSourceEnabled(s.id, false);
if (!platform.news.listSources().some((s) => !s.builtin)) {
  platform.news.addSource('Fixture Wire', `${MOCK}/feeds/wire.xml`);
  platform.news.addSource('Fixture Herald', `${MOCK}/feeds/herald.atom`);
  platform.news.addSource('Fixture Dispatch', `${MOCK}/feeds/dispatch.rdf`);
}
platform.app.listen(PORT, '127.0.0.1', () => console.log(`E2E_READY http://127.0.0.1:${PORT}`));
