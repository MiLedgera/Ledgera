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
  // Idempotency ledger for on-chain submissions (#484). Keyed by a
  // caller-supplied idempotency key (e.g. AgentTask.correlationId) so a retry
  // that reuses the same key can detect "this was already submitted" instead
  // of blindly building and broadcasting a second, distinct transaction.
  db.exec(`
      CREATE TABLE IF NOT EXISTS tx_submissions (
        idempotency_key TEXT    PRIMARY KEY,
        source_account  TEXT    NOT NULL,
        tx_hash         TEXT,
        envelope_xdr    TEXT,
        status          TEXT    NOT NULL CHECK (status IN ('pending', 'success', 'failed')),
        result_json     TEXT,
        error           TEXT,
        created_at      INTEGER NOT NULL,
        updated_at      INTEGER NOT NULL
      )
    `);
  db.exec(`
      CREATE INDEX IF NOT EXISTS idx_tx_submissions_source_account
        ON tx_submissions (source_account)
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

// ─── Transaction submission idempotency ledger (#484) ────────────────────────

export type TxSubmissionStatus = 'pending' | 'success' | 'failed';

export interface TxSubmissionRecord {
  idempotencyKey: string;
  sourceAccount: string;
  txHash: string | null;
  envelopeXdr: string | null;
  status: TxSubmissionStatus;
  resultJson: string | null;
  error: string | null;
  createdAt: number;
  updatedAt: number;
}

interface TxSubmissionRow {
  idempotency_key: string;
  source_account: string;
  tx_hash: string | null;
  envelope_xdr: string | null;
  status: TxSubmissionStatus;
  result_json: string | null;
  error: string | null;
  created_at: number;
  updated_at: number;
}

function rowToTxSubmission(row: TxSubmissionRow): TxSubmissionRecord {
  return {
    idempotencyKey: row.idempotency_key,
    sourceAccount: row.source_account,
    txHash: row.tx_hash,
    envelopeXdr: row.envelope_xdr,
    status: row.status,
    resultJson: row.result_json,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Look up a submission by idempotency key, or `undefined` if none exists. */
export function getTxSubmission(idempotencyKey: string): TxSubmissionRecord | undefined {
  const row = getDb()
    .prepare(`SELECT * FROM tx_submissions WHERE idempotency_key = ?`)
    .get(idempotencyKey) as TxSubmissionRow | undefined;
  return row ? rowToTxSubmission(row) : undefined;
}

/**
 * Atomically fetch-or-create the submission row for `idempotencyKey`.
 *
 * Wrapped in an immediate transaction so two concurrent callers racing on the
 * *same* key — two processes sharing this database, or two in-process calls —
 * cannot both observe "no row yet" and proceed to build and broadcast two
 * distinct transactions for what is supposed to be one logical operation.
 * Exactly one of them inserts the `pending` row and gets `isNew: true`; the
 * other sees the row the first one just created.
 */
export function beginTxSubmission(
  idempotencyKey: string,
  sourceAccount: string,
  now: number
): { record: TxSubmissionRecord; isNew: boolean } {
  const db = getDb();
  const run = db.transaction(() => {
    const existing = db
      .prepare(`SELECT * FROM tx_submissions WHERE idempotency_key = ?`)
      .get(idempotencyKey) as TxSubmissionRow | undefined;
    if (existing) {
      return { record: rowToTxSubmission(existing), isNew: false };
    }
    db.prepare(
      `INSERT INTO tx_submissions (idempotency_key, source_account, status, created_at, updated_at)
       VALUES (@idempotencyKey, @sourceAccount, 'pending', @now, @now)`
    ).run({ idempotencyKey, sourceAccount, now });
    return {
      record: {
        idempotencyKey,
        sourceAccount,
        txHash: null,
        envelopeXdr: null,
        status: 'pending' as const,
        resultJson: null,
        error: null,
        createdAt: now,
        updatedAt: now,
      },
      isNew: true,
    };
  });
  return run.immediate();
}

/**
 * Record the hash and signed envelope of a submission attempt *before* it is
 * broadcast — the crux of the idempotency guarantee. If the process crashes,
 * or the RPC call times out without a response, the next attempt (same key)
 * can check this exact hash's on-chain status instead of guessing.
 */
export function attachTxSubmissionHash(
  idempotencyKey: string,
  txHash: string,
  envelopeXdr: string,
  now: number
): void {
  getDb()
    .prepare(
      `UPDATE tx_submissions SET tx_hash = @txHash, envelope_xdr = @envelopeXdr, updated_at = @now
       WHERE idempotency_key = @idempotencyKey`
    )
    .run({ idempotencyKey, txHash, envelopeXdr, now });
}

/** Mark a submission settled successfully, with its final (possibly status-checked) result. */
export function completeTxSubmission(
  idempotencyKey: string,
  resultJson: string,
  now: number
): void {
  getDb()
    .prepare(
      `UPDATE tx_submissions SET status = 'success', result_json = @resultJson, error = NULL, updated_at = @now
       WHERE idempotency_key = @idempotencyKey`
    )
    .run({ idempotencyKey, resultJson, now });
}

/** Mark a submission definitively failed, so a future call with the same key may rebuild and retry. */
export function failTxSubmission(idempotencyKey: string, error: string, now: number): void {
  getDb()
    .prepare(
      `UPDATE tx_submissions SET status = 'failed', error = @error, updated_at = @now
       WHERE idempotency_key = @idempotencyKey`
    )
    .run({ idempotencyKey, error, now });
}

/**
 * Reset a `failed` submission back to `pending`, clearing its prior hash/
 * envelope, so the next attempt can rebuild a fresh transaction under the
 * same idempotency key rather than accumulating unrelated rows.
 */
export function resetTxSubmissionToPending(idempotencyKey: string, now: number): void {
  getDb()
    .prepare(
      `UPDATE tx_submissions
       SET status = 'pending', tx_hash = NULL, envelope_xdr = NULL, result_json = NULL, error = NULL, updated_at = @now
       WHERE idempotency_key = @idempotencyKey`
    )
    .run({ idempotencyKey, now });
}
