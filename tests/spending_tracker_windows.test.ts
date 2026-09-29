/**
 * tests/spending_tracker_windows.test.ts
 *
 * Extends the rolling spending-window guard (backend/spending_tracker.ts,
 * backend/persistence.ts) with independent hourly and daily cumulative caps,
 * layered on top of the pre-existing generic `SPENDING_WINDOW_MS` window.
 *
 * Covers:
 *   - hourly and daily limits are enforced independently of each other and of
 *     the generic window
 *   - both survive a "restart" (a fresh SpendingTracker built over the same
 *     persisted database), so an agent can't reset its hourly/daily spend by
 *     restarting mid-window
 */

import Database from 'better-sqlite3';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../backend/config', () => ({
  config: {
    // Large enough that the generic window never trips in these tests —
    // hourly/daily are what's under test here.
    SPENDING_WINDOW_MS: 7 * 24 * 60 * 60 * 1000,
    AGENT_SPENDING_LIMIT: '1000000',
    AGENT_HOURLY_SPENDING_LIMIT: '50',
    AGENT_DAILY_SPENDING_LIMIT: '80',
    DB_PATH: ':memory:',
  },
}));

import { SpendingTracker, HOUR_MS, DAY_MS } from '../backend/spending_tracker';
import { _setDb, clearSpendingRecords } from '../backend/persistence';

let db: Database.Database;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
  db = new Database(':memory:');
  _setDb(db);
  clearSpendingRecords();
});

afterEach(() => {
  vi.useRealTimers();
  db.close();
});

describe('SpendingTracker — independent hourly/daily windows', () => {
  it('allows spend under both the hourly and daily caps', () => {
    const tracker = new SpendingTracker();
    expect(() => tracker.record('30')).not.toThrow();
    expect(() => tracker.record('15')).not.toThrow();
  });

  it('rejects once cumulative spend within the hour exceeds AGENT_HOURLY_SPENDING_LIMIT', () => {
    const tracker = new SpendingTracker();
    tracker.record('30');
    // 30 + 25 = 55 > hourly limit of 50, but well under the daily limit of 80.
    expect(() => tracker.record('25')).toThrow(/Cumulative hourly spending.*exceeds limit 50/);
  });

  it('rejects once cumulative spend within the day exceeds AGENT_DAILY_SPENDING_LIMIT, even when spread across several hours', () => {
    const tracker = new SpendingTracker();

    // Space payments an hour apart so the hourly cap never triggers, only the
    // daily one accumulates.
    tracker.record('30');
    vi.advanceTimersByTime(HOUR_MS + 1);
    tracker.record('30');
    vi.advanceTimersByTime(HOUR_MS + 1);

    // 30 + 30 + 25 = 85 > daily limit of 80.
    expect(() => tracker.record('25')).toThrow(/Cumulative daily spending.*exceeds limit 80/);
  });

  it('does not let the hourly window reset mask the daily cap', () => {
    const tracker = new SpendingTracker();
    tracker.record('45'); // within both caps

    vi.advanceTimersByTime(HOUR_MS + 1); // hourly window rolls over
    // Hourly total is now back to 0, so this alone is fine hour-wise (30 < 50).
    // But daily total is 45 + 30 = 75, still under 80 — should pass.
    expect(() => tracker.record('30')).not.toThrow();

    vi.advanceTimersByTime(HOUR_MS + 1); // hourly rolls over again
    // Daily total would become 75 + 10 = 85 > 80 even though hourly (10) is fine.
    expect(() => tracker.record('10')).toThrow(/Cumulative daily spending.*exceeds limit 80/);
  });

  it('rejected spend is not recorded — a payment blocked by the hourly cap does not count against the daily cap either', () => {
    const tracker = new SpendingTracker();
    tracker.record('30');
    expect(() => tracker.record('25')).toThrow(); // blocked by hourly (55 > 50)

    // Because the atomic check rejects before inserting, the "25" never landed.
    // A later payment that only the daily cap would catch should be evaluated
    // against 30, not 55.
    vi.advanceTimersByTime(HOUR_MS + 1);
    expect(() => tracker.record('40')).not.toThrow(); // 30 + 40 = 70 <= 80 daily, hourly reset
  });

  it('keeps enforcing the hourly cap across a restart', () => {
    const first = new SpendingTracker();
    first.record('40');

    // A "restart": same database, brand new tracker instance.
    const second = new SpendingTracker();

    // 40 + 20 = 60 > hourly limit of 50.
    expect(() => second.record('20')).toThrow(/Cumulative hourly spending.*exceeds limit 50/);
  });

  it('keeps enforcing the daily cap across a restart even once the hourly window has rolled over', () => {
    const first = new SpendingTracker();
    first.record('45');

    vi.advanceTimersByTime(HOUR_MS + 1); // hourly window clears

    const second = new SpendingTracker(); // restart

    // Hourly total is 0 post-rollover, so the hourly cap alone would allow 30.
    // But daily is 45 + 30 = 75 <= 80, so this one still passes...
    expect(() => second.record('30')).not.toThrow();

    // ...while one more push takes the daily total to 85 > 80.
    const third = new SpendingTracker(); // another restart
    expect(() => third.record('10')).toThrow(/Cumulative daily spending.*exceeds limit 80/);
  });

  it('daily spend rolls off after 24 hours even across a restart', () => {
    const first = new SpendingTracker();
    first.record('45'); // under both the hourly (50) and daily (80) caps

    vi.advanceTimersByTime(DAY_MS + 1);

    const second = new SpendingTracker();
    // The 45 has aged out of both the hourly and daily windows, so this would
    // have failed the daily cap (45 + 50 = 95 > 80) had it not rolled off. The
    // row itself is still on disk (SPENDING_WINDOW_MS's generic 7-day window
    // still covers it) — only the hourly/daily sums exclude it.
    expect(() => second.record('50')).not.toThrow();
  });
});
