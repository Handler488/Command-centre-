import 'dotenv/config';
import path from 'node:path';

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Upstream base URLs are overridable so the test-suite can point the platform
 * at a local mock upstream. Production never needs to set these.
 */
export const config = {
  port: int('PORT', 4000),
  /** Loopback by default: this is a single-user tool holding personal data, with no login. */
  host: process.env.HOST?.trim() || '127.0.0.1',
  env: process.env.NODE_ENV ?? 'development',
  databasePath: path.resolve(process.env.DATABASE_PATH ?? './data/command-centre.db'),
  newsRefreshMinutes: int('NEWS_REFRESH_MINUTES', 15),
  anthropicApiKey: process.env.ANTHROPIC_API_KEY?.trim() || '',
  analystModel: process.env.ANALYST_MODEL?.trim() || 'claude-opus-5-5',
  secUserAgent:
    process.env.SEC_USER_AGENT?.trim() || 'CommandCentre/1.0 (personal research tool)',
  secUserAgentConfigured: Boolean(process.env.SEC_USER_AGENT?.trim()),
  upstream: {
    yahooChart: process.env.YAHOO_CHART_BASE ?? 'https://query1.finance.yahoo.com',
    yahooSearch: process.env.YAHOO_SEARCH_BASE ?? 'https://query2.finance.yahoo.com',
    stooq: process.env.STOOQ_BASE ?? 'https://stooq.com',
    secData: process.env.SEC_DATA_BASE ?? 'https://data.sec.gov',
    secWww: process.env.SEC_WWW_BASE ?? 'https://www.sec.gov',
    gdelt: process.env.GDELT_BASE ?? 'https://api.gdeltproject.org',
  },
};

export type Config = typeof config;
