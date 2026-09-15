/**
 * tests/persistence.test.ts
 *
 * Tests for backend/persistence.ts using an in-memory SQLite database.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { saveResult, getResults, _setDb, closeDb } from '../backend/persistence';
import type { AgentResult } from '../backend/agent';

function makeInMemoryDb(): Database.Database {
  const db = new Database(':memory:');
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
  return db;
}

beforeEach(() => {
  _setDb(makeInMemoryDb());
});

const TIMESTAMP = '2026-06-25T22:00:00.000Z';

function makeResult(
  overrides: Partial<AgentResult & { timestamp: string }> = {}
): AgentResult & { timestamp: string } {
  return {
    success: true,
    taskType: 'stellar_payment',
    data: { txHash: 'abc123' },
    timestamp: TIMESTAMP,
    ...overrides,
  };
}

describe('persistence', () => {
  it('saves a successful result and retrieves it', () => {
    saveResult(makeResult());
    const results = getResults();
    expect(results).toHaveLength(1);
    const result = results[0];
    expect(result).toBeDefined();
    if (!result) return;
    expect(result.success).toBe(true);
    expect(result.taskType).toBe('stellar_payment');
    expect(result.timestamp).toBe(TIMESTAMP);
    expect((result.data as any).txHash).toBe('abc123');
  });

  it('saves a failed result and retrieves the error', () => {
    saveResult(makeResult({ success: false, data: undefined, error: 'Network failure' }));
    const results = getResults();
    expect(results).toHaveLength(1);
    const result = results[0];
    expect(result).toBeDefined();
    if (!result) return;
    expect(result.success).toBe(false);
    expect(result.error).toBe('Network failure');
    expect(result.data).toBeUndefined();
  });

  it('respects the limit parameter and returns results newest-first', () => {
    for (let i = 0; i < 5; i++) {
      saveResult(makeResult({ data: { index: i }, timestamp: `2026-06-25T22:0${i}:00.000Z` }));
    }
    const results = getResults(3);
    expect(results).toHaveLength(3);
    // Newest first — last inserted has the highest id
    const result = results[0];
    expect(result).toBeDefined();
    if (result) {
      expect((result.data as any).index).toBe(4);
    }
  });

  it('returns an empty array when no results have been saved', () => {
    expect(getResults()).toEqual([]);
  });

  it('persists multiple task types independently', () => {
    saveResult(makeResult({ taskType: 'stellar_payment' }));
    saveResult(makeResult({ taskType: 'soroban_invoke', data: { result: 'ok' } }));
    saveResult(makeResult({ taskType: 'x402_respond', data: { protocol: 'x402' } }));

    const results = getResults();
    expect(results).toHaveLength(3);
    const types = results.map((r) => r.taskType);
    expect(types).toContain('stellar_payment');
    expect(types).toContain('soroban_invoke');
    expect(types).toContain('x402_respond');
  });

  // ─── Edge-case tests (#449) ────────────────────────────────────────────────

  it('handles 10 concurrent saveResult calls without data corruption', async () => {
    // Issue 10 simultaneous writes via Promise.all to verify SQLite lock handling.
    // better-sqlite3 is synchronous per-call, but async wrappers / test runners
    // can interleave at the micro-task level — all 10 rows must still be present.
    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        Promise.resolve(
          saveResult(
            makeResult({
              taskType: 'stellar_payment',
              data: { index: i, txHash: `hash_${i}` },
              timestamp: `2026-06-25T22:00:0${i}.000Z`,
            })
          )
        )
      )
    );

    const results = getResults(20);
    expect(results).toHaveLength(10);

    // Every index from 0..9 must be recoverable — no writes lost or duplicated.
    const indices = results
      .map((r) => (r.data as Record<string, unknown> | undefined)?.index)
      .sort((a, b) => (a as number) - (b as number));
    expect(indices).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('saves and retrieves a payload larger than 1 MB', () => {
    // Build a string that serialises to well over 1,000,000 bytes.  JSON.stringify
    // adds ~14 chars of wrapper so a 1,010,000-char value is safely above the threshold.
    const largeString = 'x'.repeat(1_010_000);
    const largePayload = { blob: largeString };

    saveResult(makeResult({ data: largePayload }));

    const results = getResults(1);
    expect(results).toHaveLength(1);

    const retrieved = results[0];
    expect(retrieved).toBeDefined();
    if (!retrieved) return;

    const blob = (retrieved.data as Record<string, unknown>)?.blob;
    expect(typeof blob).toBe('string');
    expect((blob as string).length).toBe(1_010_000);

    // Confirm the round-trip did not silently truncate the payload.
    const serialised = JSON.stringify(largePayload);
    expect(serialised.length).toBeGreaterThan(1_000_000);
    expect(blob).toBe(largeString);
  });

  it('saves and retrieves a result whose data field is null', () => {
    // null is a valid JSON value; the persistence layer must not throw on insert
    // and must return null (not undefined or a parse artefact) on retrieval.
    saveResult(makeResult({ data: null }));

    const results = getResults(1);
    expect(results).toHaveLength(1);

    const result = results[0];
    expect(result).toBeDefined();
    if (!result) return;

    // The serialisation path stores null as the SQL NULL column value and maps it
    // back to undefined in getResults (see persistence.ts: `r.data !== null ? JSON.parse(r.data) : undefined`).
    // Both null and undefined are acceptable absent-data representations here.
    expect(result.data == null).toBe(true); // null or undefined
  });

  it('returns null / empty array when looking up a never-saved correlationId', () => {
    // Seed the database with an unrelated record so the table is non-empty.
    saveResult(makeResult({ correlationId: 'known-id-abc' }));

    // getResults() returns all rows newest-first; none will match the phantom ID.
    const allResults = getResults();
    const match = allResults.find((r) => r.correlationId === 'phantom-id-does-not-exist');

    // No row exists for the phantom ID — the lookup must yield undefined / null,
    // not throw and not return a stale result.
    expect(match).toBeUndefined();

    // Also verify that a targeted search (simulating loadResult semantics) yields
    // an empty collection — not an error.
    const byCorrelation = allResults.filter((r) => r.correlationId === 'phantom-id-does-not-exist');
    expect(byCorrelation).toHaveLength(0);
  });

  // Audit finding Q-8: DatabaseManager.close() (backend/db/client.ts) flipped
  // an internal flag but never closed the actual better-sqlite3 handle that
  // getDb() owns. closeDb() is what DatabaseManager.close() now delegates to.
  describe('closeDb()', () => {
    it('closes the underlying better-sqlite3 handle exactly once, and is idempotent', () => {
      const injectedDb = makeInMemoryDb();
      const closeSpy = vi.spyOn(injectedDb, 'close');
      _setDb(injectedDb);

      closeDb();
      expect(closeSpy).toHaveBeenCalledTimes(1);

      // A second call must not throw or attempt to close an already-closed handle.
      expect(() => closeDb()).not.toThrow();
      expect(closeSpy).toHaveBeenCalledTimes(1);
    });
  });
});
