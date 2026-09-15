/**
 * backend/persistence.ts
 *
 * SQLite-backed audit log for every AgentResult produced by PayFiAgent.run().
 * The DB path is configured via DB_PATH (default: ./agent.db).
 * Pass ":memory:" for in-process testing via _setDb().
 */

import Database from 'better-sqlite3';
import type { AgentResult } from './agent';

export type PersistedResult = AgentResult & { timestamp: string };

let _db: Database.Database | null = null;

/**
 * Create every table this module owns, plus the idempotent migrations.
 *
 * Applied both to the lazily opened connection and to any DB injected through
 * `_setDb()`, so a test database has the same shape as a real one and the two
 * cannot drift apart.
 */
function applySchema(db: Database.Database): void {
  db.exec(`
      CREATE TABLE IF NOT EXISTS agent_results (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp     TEXT    NOT NULL,
        taskType      TEXT    NOT NULL,
        success       INTEGER NOT NULL,
        data          TEXT,
        error         TEXT,
        correlationId TEXT
      )
    `);
  // Rolling spending window (#372). Kept here so the tracker survives a
  // restart instead of silently resetting its cumulative total to zero.
  db.exec(`
      CREATE TABLE IF NOT EXISTS spending_records (
        id        INTEGER PRIMARY KEY AUTOINCREMENT,
        amount    REAL    NOT NULL,
        timestamp INTEGER NOT NULL
      )
    `);
  db.exec(`
      CREATE INDEX IF NOT EXISTS idx_spending_records_timestamp
        ON spending_records (timestamp)
    `);
  // Idempotent migration for databases created before correlationId existed.
  const cols = db.prepare(`PRAGMA table_info(agent_results)`).all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === 'correlationId')) {
    db.exec(`ALTER TABLE agent_results ADD COLUMN correlationId TEXT`);
  }
}

function getDb(): Database.Database {
  if (!_db) {
    // Lazy import of config so that tests can inject via _setDb() before any DB access
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { config } = require('./config') as typeof import('./config');
    _db = new Database(config.DB_PATH);
    applySchema(_db);
  }
  return _db;
}

/**
 * Execute a trivial query against the live connection (#234).
 *
 * `getDb()` owns the only `better-sqlite3` handle, so the probe belongs here
 * rather than in DatabaseManager — duplicating connection ownership to satisfy
 * a health check would mean the check exercised a handle the app does not use.
 *
 * Throws if the file is missing, corrupt, or the connection is in a bad state,
 * which is exactly what an in-memory boolean cannot detect.
 */
export function probeDb(): void {
  getDb().prepare('SELECT 1').get();
}

/**
 * Close the underlying `better-sqlite3` handle, if one is open.
 *
 * `getDb()` owns the only handle (see `probeDb()`'s comment above), so
 * closing it belongs here too — DatabaseManager.close() delegates to this
 * rather than tracking a second reference to the same connection.
 */
export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}

export function saveResult(result: PersistedResult): void {
  getDb()
    .prepare(
      `INSERT INTO agent_results (timestamp, taskType, success, data, error, correlationId)
       VALUES (@timestamp, @taskType, @success, @data, @error, @correlationId)`
    )
    .run({
      timestamp: result.timestamp,
      taskType: result.taskType,
      success: result.success ? 1 : 0,
      data: result.data !== undefined ? JSON.stringify(result.data) : null,
      error: result.error ?? null,
      correlationId: result.correlationId ?? null,
    });
}

export function getResults(limit = 100, offset = 0): PersistedResult[] {
  const rows = getDb()
    .prepare(
      `SELECT timestamp, taskType, success, data, error, correlationId
       FROM agent_results ORDER BY id DESC LIMIT ? OFFSET ?`
    )
    .all(limit, offset) as Array<{
    timestamp: string;
    taskType: string;
    success: number;
    data: string | null;
    error: string | null;
    correlationId: string | null;
  }>;

  return rows.map((r) => {
    const result: PersistedResult = {
      timestamp: r.timestamp,
      taskType: r.taskType as AgentResult['taskType'],
      success: r.success === 1,
      data: r.data !== null ? JSON.parse(r.data) : undefined,
    };
    if (r.error !== null) result.error = r.error;
    if (r.correlationId !== null) result.correlationId = r.correlationId;
    return result;
  });
}

/** One recorded payment inside the rolling spending window (#372). */
export interface SpendingRecord {
  amount: number;
  timestamp: number;
}

/** Append a payment to the persisted spending window. */
export function saveSpendingRecord(record: SpendingRecord): void {
  getDb()
    .prepare(`INSERT INTO spending_records (amount, timestamp) VALUES (@amount, @timestamp)`)
    .run({ amount: record.amount, timestamp: record.timestamp });
}

/** Records at or after `sinceMs`, oldest first. */
export function loadSpendingRecords(sinceMs: number): SpendingRecord[] {
  return getDb()
    .prepare(
      `SELECT amount, timestamp FROM spending_records
       WHERE timestamp >= ? ORDER BY timestamp ASC`
    )
    .all(sinceMs) as SpendingRecord[];
}

/** Drop records that have fallen out of the window. */
export function pruneSpendingRecords(cutoffMs: number): void {
  getDb().prepare(`DELETE FROM spending_records WHERE timestamp < ?`).run(cutoffMs);
}

/** Drop the whole persisted window. */
export function clearSpendingRecords(): void {
  getDb().prepare(`DELETE FROM spending_records`).run();
}

/** Replace the underlying DB instance — used in tests to inject an in-memory DB. */
export function _setDb(db: Database.Database): void {
  _db = db;
  applySchema(_db);
}
