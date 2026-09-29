import { config } from './config';
import { logger } from './logger';
import {
  checkAndRecordSpending,
  clearSpendingRecords,
  loadSpendingRecords,
  pruneSpendingRecords,
  saveSpendingRecord,
  SpendingLimitExceededError,
  type SpendingWindowCheck,
} from './persistence';

/** Fixed-duration rolling windows layered on top of the generic configurable one. */
export const HOUR_MS = 60 * 60 * 1000;
export const DAY_MS = 24 * HOUR_MS;

/**
 * Spending tracker that records each payment amount and maintains a rolling
 * time window. It is used by the agent to enforce a cumulative spending limit
 * within `config.SPENDING_WINDOW_MS`.
 *
 * The window is mirrored to SQLite (#372). Holding it only in memory meant a
 * restart reset the cumulative total to zero, so an agent that was restarted —
 * or that crashed and was restarted for it — could spend past its cap by
 * starting over with a clean slate. Records are reloaded on construction and
 * written on every `record()`.
 *
 * Persistence is best-effort: if the database is unavailable the tracker still
 * enforces the limit for the life of the process rather than refusing to run.
 */
export class SpendingTracker {
  private readonly windowMs: number;
  private records: { amount: number; timestamp: number }[] = [];

  constructor(windowMs: number = config.SPENDING_WINDOW_MS) {
    this.windowMs = windowMs;
    this.restore();
  }

  /**
   * Load the unexpired part of the window left behind by a previous process.
   */
  private restore(): void {
    const cutoff = Date.now() - this.windowMs;
    try {
      this.records = loadSpendingRecords(cutoff).map((r) => ({
        amount: r.amount,
        timestamp: r.timestamp,
      }));
      if (this.records.length > 0) {
        logger.info('Restored spending window from persistence', {
          records: this.records.length,
          total: this.total(),
        });
      }
    } catch (err) {
      // No database, or it is unreadable — carry on with an empty window.
      logger.warn('Could not restore spending window; starting empty', {
        error: String(err),
      });
      this.records = [];
    }
  }

  /** Build the set of rolling windows currently in effect. */
  private activeWindowChecks(): SpendingWindowCheck[] {
    return [
      { label: 'window', windowMs: this.windowMs, limit: parseFloat(config.AGENT_SPENDING_LIMIT) },
      {
        label: 'hourly',
        windowMs: HOUR_MS,
        limit: config.AGENT_HOURLY_SPENDING_LIMIT
          ? parseFloat(config.AGENT_HOURLY_SPENDING_LIMIT)
          : undefined,
      },
      {
        label: 'daily',
        windowMs: DAY_MS,
        limit: config.AGENT_DAILY_SPENDING_LIMIT
          ? parseFloat(config.AGENT_DAILY_SPENDING_LIMIT)
          : undefined,
      },
    ];
  }

  /**
   * Record a payment amount. The amount is expected to be a numeric string.
   * Throws if the new cumulative total would exceed `config.AGENT_SPENDING_LIMIT`,
   * `config.AGENT_HOURLY_SPENDING_LIMIT`, or `config.AGENT_DAILY_SPENDING_LIMIT`
   * (whichever are configured).
   *
   * When persistence is available, the check-then-insert is atomic (see
   * {@link checkAndRecordSpending}) so two processes — or two `PayFiAgent`
   * instances in the same process — sharing a database cannot both observe a
   * stale total and jointly walk past a cap that either one alone would have
   * been stopped by. Rejected amounts are never recorded in this path: a
   * throw here means the caller's tool is never invoked, so nothing was
   * actually spent.
   *
   * If persistence is unavailable, enforcement falls back to this process's
   * in-memory records only — the pre-existing, single-process guarantee.
   */
  record(amountStr: string) {
    const amount = parseFloat(amountStr);
    if (isNaN(amount)) return; // let callers handle invalid input
    const now = Date.now();
    const windows = this.activeWindowChecks();

    try {
      checkAndRecordSpending(amount, now, windows);
      this.pruneOld(now);
      this.records.push({ amount, timestamp: now });
      this.warnIfApproachingLimit(now);
      return;
    } catch (err) {
      if (err instanceof SpendingLimitExceededError) {
        throw new Error(err.message);
      }
      // Not a limit violation — persistence itself is unavailable. Fall back
      // to enforcing against this process's own records only.
      logger.warn(
        'Spending check could not run atomically against persistence; falling back to in-memory enforcement',
        {
          error: String(err),
        }
      );
    }

    // ── In-memory fallback (best-effort; does not survive a restart and does
    // not see spend recorded by another process) ──
    this.pruneOld(now);
    this.records.push({ amount, timestamp: now });
    this.persist({ amount, timestamp: now });
    for (const w of windows) {
      if (w.limit === undefined || isNaN(w.limit)) continue;
      const total = this.sumSince(now - w.windowMs, now);
      if (total > w.limit) {
        const prefix =
          w.label === 'window' ? 'Cumulative spending' : `Cumulative ${w.label} spending`;
        throw new Error(`${prefix} ${total} exceeds limit ${w.limit}`);
      }
    }
    this.warnIfApproachingLimit(now);
  }

  /** Sum of in-memory records with `timestamp >= cutoff`, after pruning against `now`. */
  private sumSince(cutoff: number, now: number): number {
    this.pruneOld(now);
    return this.records.filter((r) => r.timestamp >= cutoff).reduce((sum, r) => sum + r.amount, 0);
  }

  private warnIfApproachingLimit(now: number): void {
    const total = this.sumSince(now - this.windowMs, now);
    const limit = parseFloat(config.AGENT_SPENDING_LIMIT);
    if (!isNaN(total) && !isNaN(limit) && total > limit * 0.8) {
      logger.warn('Approaching spending limit', {
        total,
        limit,
        percent: ((total / limit) * 100).toFixed(1),
      });
    }
  }

  /** Return the total amount spent within the current window. */
  total(): number {
    const now = Date.now();
    return this.sumSince(now - this.windowMs, now);
  }

  /**
   * Return a snapshot of the current window state.
   *
   * @returns An object with:
   *   - `total` – cumulative spend within the active window
   *   - `recordCount` – number of records still within the window
   *   - `windowMs` – the configured window duration in milliseconds
   *   - `oldestTimestamp` – timestamp of the oldest in-window record, or `null` when empty
   *   - `hourlyTotal` / `dailyTotal` – cumulative spend within the fixed 1h/24h
   *     windows, from this process's in-memory records. Informational only —
   *     the authoritative check happens inside `record()` against persistence.
   */
  getWindowStatus(): {
    total: number;
    recordCount: number;
    windowMs: number;
    oldestTimestamp: number | null;
    hourlyTotal: number;
    dailyTotal: number;
  } {
    const now = Date.now();
    this.pruneOld(now);
    // `pruneOld` trims the backing array to the widest window in play (so
    // hourly/daily stats below stay correct), which is not necessarily
    // `this.windowMs` — so `total`/`recordCount`/`oldestTimestamp` still need
    // their own filter down to just this window rather than summing whatever
    // pruning happened to leave in the array.
    const cutoff = now - this.windowMs;
    const inWindow = this.records.filter((r) => r.timestamp >= cutoff);
    return {
      total: inWindow.reduce((sum, r) => sum + r.amount, 0),
      recordCount: inWindow.length,
      windowMs: this.windowMs,
      oldestTimestamp: inWindow.length > 0 ? inWindow[0]!.timestamp : null,
      hourlyTotal: this.sumSince(now - HOUR_MS, now),
      dailyTotal: this.sumSince(now - DAY_MS, now),
    };
  }

  private persist(record: { amount: number; timestamp: number }): void {
    try {
      saveSpendingRecord(record);
    } catch (err) {
      // A spend that cannot be written down still counts in this process.
      logger.warn('Could not persist spending record', { error: String(err) });
    }
  }

  private pruneOld(now: number) {
    // Retain far enough back to cover the widest active window (the generic
    // configurable one, or the fixed hourly/daily ones) — otherwise the
    // in-memory fallback and the informational hourly/daily totals in
    // `getWindowStatus()` could under-count when `this.windowMs` is
    // configured shorter than a day.
    const cutoff = now - Math.max(this.windowMs, HOUR_MS, DAY_MS);
    let evicted = false;
    while (this.records.length > 0) {
      const first = this.records[0];
      if (first && first.timestamp < cutoff) {
        this.records.shift();
        evicted = true;
      } else {
        break;
      }
    }
    if (evicted) {
      try {
        pruneSpendingRecords(cutoff);
      } catch {
        // Pruning is housekeeping; failing to do it must not block a payment.
      }
    }
  }

  clear() {
    this.records = [];
    try {
      clearSpendingRecords();
    } catch {
      // Nothing persisted to clear.
    }
  }
}

/**
 * Process-wide singleton backing the cumulative spending window.
 *
 * Lives here (not in agent.ts) so value-moving tools — e.g.
 * {@link SorobanInvokeTool} — can record simulated SAC transfers against the
 * same window as payments without importing the agent (which would create a
 * module cycle) or instantiating a second tracker (whose in-memory state would
 * drift from the real one).
 */
export const spendingTracker = new SpendingTracker();
