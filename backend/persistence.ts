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

/**
 * Apply the pragmas the spending-window atomicity guarantee depends on.
 *
 * `busy_timeout` makes a second process's write block-and-retry instead of
 * failing immediately with SQLITE_BUSY when it arrives while another
 * process's immediate transaction (see {@link checkAndRecordSpending}) still
 * holds the write lock. WAL is skipped for `:memory:` — SQLite does not
 * support it there, and the pragma would be a silent no-op anyway.
 */
function applyConcurrencyPragmas(db: Database.Database, dbPath: string): void {
  db.pragma('busy_timeout = 5000');
  if (dbPath !== ':memory:') {
    db.pragma('journal_mode = WAL');
  }
}

function getDb(): Database.Database {
  if (!_db) {
    // Lazy import of config so that tests can inject via _setDb() before any DB access
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { config } = require('./config') as typeof import('./config');
    _db = new Database(config.DB_PATH);
    applyConcurrencyPragmas(_db, config.DB_PATH);
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

/**
 * Replace the underlying DB instance — used in tests to inject an in-memory or
 * file-backed DB. Pass `dbPath` (the path the caller opened `db` with) when the
 * test needs the concurrency pragmas applied, e.g. to exercise cross-connection
 * atomicity against a real file rather than a private `:memory:` database.
 */
export function _setDb(db: Database.Database, dbPath = ':memory:'): void {
  _db = db;
  applyConcurrencyPragmas(_db, dbPath);
  applySchema(_db);
}

/** Raised by {@link checkAndRecordSpending} when a window's cap would be exceeded. */
export class SpendingLimitExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SpendingLimitExceededError';
    Object.setPrototypeOf(this, SpendingLimitExceededError.prototype);
  }
}

/** One rolling-window cumulative cap to enforce inside {@link checkAndRecordSpending}. */
export interface SpendingWindowCheck {
  /** Human-readable window name, used only in the thrown error message. */
  label: string;
  windowMs: number;
  /** Undefined skips this window's check entirely. */
  limit: number | undefined;
}

/**
 * Atomically check every configured rolling window against `amount` and, if
 * none would be exceeded, record it — all inside a single SQLite immediate
 * transaction.
 *
 * The immediate transaction acquires SQLite's write lock before reading, so a
 * second process (or connection) attempting the same call blocks until this
 * one commits or rolls back, instead of racing a stale in-memory sum the way
 * a separate read-then-write would. This is what makes the rolling window
 * safe across process restarts *and* concurrent `PayFiAgent.run()` calls,
 * whether from the same process or several sharing one database file.
 *
 * Throws {@link SpendingLimitExceededError} — and inserts nothing — the
 * moment any window's cap would be exceeded. Any other thrown error (e.g. the
 * database is unreachable) means the caller should fall back to a
 * best-effort, in-memory-only check instead of trusting this result.
 */
export function checkAndRecordSpending(
  amount: number,
  timestamp: number,
  windows: SpendingWindowCheck[]
): void {
  const db = getDb();
  const activeWindows = windows.filter(
    (w): w is SpendingWindowCheck & { limit: number } => w.limit !== undefined && !isNaN(w.limit)
  );

  const run = db.transaction(() => {
    // Bound the table by the widest window in play; anything older is dead
    // weight no active check will ever look at again.
    if (activeWindows.length > 0) {
      const maxWindowMs = Math.max(...activeWindows.map((w) => w.windowMs));
      db.prepare(`DELETE FROM spending_records WHERE timestamp < ?`).run(timestamp - maxWindowMs);
    }

    for (const w of activeWindows) {
      const cutoff = timestamp - w.windowMs;
      const row = db
        .prepare(
          `SELECT COALESCE(SUM(amount), 0) AS total FROM spending_records WHERE timestamp >= ?`
        )
        .get(cutoff) as { total: number };
      const projected = row.total + amount;
      if (projected > w.limit) {
        // "Cumulative spending" (no window label) is the pre-existing generic
        // window's wording — kept verbatim so it stays a stable substring for
        // callers/tests matching on it. Named windows (hourly/daily) get an
        // explicit label so the two are distinguishable in logs.
        const prefix =
          w.label === 'window' ? 'Cumulative spending' : `Cumulative ${w.label} spending`;
        throw new SpendingLimitExceededError(`${prefix} ${projected} exceeds limit ${w.limit}`);
      }
    }

    db.prepare(`INSERT INTO spending_records (amount, timestamp) VALUES (?, ?)`).run(
      amount,
      timestamp
    );
  });

  run.immediate();
}
