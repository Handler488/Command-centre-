import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export type DB = DatabaseSync;

/**
 * Ordered, append-only migrations. Each runs once inside a transaction and is
 * recorded in schema_migrations; never edit a shipped entry, add a new one.
 */
const MIGRATIONS: { id: number; name: string; sql: string }[] = [
  {
    id: 1,
    name: 'initial schema',
    sql: `
      CREATE TABLE news_sources (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        url TEXT NOT NULL UNIQUE,
        homepage TEXT,
        region TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        builtin INTEGER NOT NULL DEFAULT 0,
        last_attempt_at TEXT,
        last_ok_at TEXT,
        last_error TEXT,
        last_item_count INTEGER
      );

      CREATE TABLE articles (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        url TEXT NOT NULL UNIQUE,
        title TEXT NOT NULL,
        summary TEXT NOT NULL DEFAULT '',
        source_id TEXT NOT NULL,
        source_name TEXT NOT NULL,
        published_at TEXT NOT NULL,
        fetched_at TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'report',
        story_id INTEGER,
        severity REAL NOT NULL DEFAULT 0
      );
      CREATE INDEX idx_articles_published ON articles(published_at DESC);
      CREATE INDEX idx_articles_story ON articles(story_id);

      CREATE TABLE article_countries (
        article_id INTEGER NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
        iso3 TEXT NOT NULL,
        PRIMARY KEY (article_id, iso3)
      );
      CREATE INDEX idx_article_countries_iso ON article_countries(iso3);

      CREATE TABLE article_topics (
        article_id INTEGER NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
        topic TEXT NOT NULL,
        PRIMARY KEY (article_id, topic)
      );
      CREATE INDEX idx_article_topics_topic ON article_topics(topic);

      CREATE TABLE watchlist (
        symbol TEXT PRIMARY KEY,
        name TEXT,
        added_at TEXT NOT NULL
      );

      CREATE TABLE transactions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        symbol TEXT NOT NULL,
        side TEXT NOT NULL CHECK (side IN ('buy','sell')),
        quantity REAL NOT NULL CHECK (quantity > 0),
        price REAL NOT NULL CHECK (price >= 0),
        fee REAL NOT NULL DEFAULT 0,
        traded_on TEXT NOT NULL,
        note TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL
      );
      CREATE INDEX idx_tx_symbol ON transactions(symbol);

      CREATE TABLE research_notes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        symbol TEXT NOT NULL,
        title TEXT NOT NULL,
        body TEXT NOT NULL DEFAULT '',
        stance TEXT NOT NULL DEFAULT 'neutral' CHECK (stance IN ('bullish','neutral','bearish')),
        target_price REAL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX idx_notes_symbol ON research_notes(symbol);

      CREATE TABLE runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_on TEXT NOT NULL,
        distance_km REAL NOT NULL CHECK (distance_km > 0),
        duration_s INTEGER NOT NULL CHECK (duration_s > 0),
        kind TEXT NOT NULL DEFAULT 'easy',
        avg_hr INTEGER,
        elevation_m REAL,
        notes TEXT NOT NULL DEFAULT '',
        origin TEXT NOT NULL DEFAULT 'manual',
        created_at TEXT NOT NULL
      );
      CREATE INDEX idx_runs_date ON runs(run_on);

      CREATE TABLE objectives (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        category TEXT NOT NULL DEFAULT 'general',
        unit TEXT NOT NULL DEFAULT '',
        start_value REAL NOT NULL DEFAULT 0,
        target_value REAL NOT NULL,
        current_value REAL NOT NULL DEFAULT 0,
        due_on TEXT,
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','achieved','dropped')),
        created_at TEXT NOT NULL
      );

      CREATE TABLE objective_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        objective_id INTEGER NOT NULL REFERENCES objectives(id) ON DELETE CASCADE,
        value REAL NOT NULL,
        note TEXT NOT NULL DEFAULT '',
        logged_at TEXT NOT NULL
      );
      CREATE INDEX idx_objective_logs ON objective_logs(objective_id, logged_at);

      CREATE TABLE tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        notes TEXT NOT NULL DEFAULT '',
        due_on TEXT,
        priority INTEGER NOT NULL DEFAULT 2 CHECK (priority BETWEEN 1 AND 3),
        done_at TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX idx_tasks_due ON tasks(due_on);

      CREATE TABLE deadlines (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        due_on TEXT NOT NULL,
        category TEXT NOT NULL DEFAULT 'general',
        notes TEXT NOT NULL DEFAULT '',
        done_at TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE conversations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK (role IN ('user','assistant')),
        content TEXT NOT NULL,
        display TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX idx_messages_conv ON messages(conversation_id, id);

      CREATE TABLE reports (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        kind TEXT NOT NULL,
        engine TEXT NOT NULL,
        body TEXT NOT NULL,
        sources TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL
      );

      CREATE TABLE kv_cache (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        stored_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
    `,
  },
];

export function openDatabase(file: string): DB {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.exec(
    'CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)',
  );
  const applied = new Set(
    db.prepare('SELECT id FROM schema_migrations').all().map((r) => Number(r.id)),
  );
  for (const m of MIGRATIONS) {
    if (applied.has(m.id)) continue;
    transaction(db, () => {
      db.exec(m.sql);
      db.prepare('INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)').run(
        m.id,
        m.name,
        new Date().toISOString(),
      );
    });
  }
  return db;
}

/** Run fn atomically; rolls back and rethrows on any error. */
export function transaction<T>(db: DB, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export const nowIso = () => new Date().toISOString();
