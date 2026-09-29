/**
 * tests/agent_spending_atomicity.test.ts
 *
 * End-to-end coverage of the spending-limit guard audit, exercised through
 * PayFiAgent.run() rather than SpendingTracker directly:
 *   - concurrent PayFiAgent.run() calls share one persisted cumulative window
 *     and cannot jointly spend past AGENT_SPENDING_LIMIT / MAINNET_SPENDING_CAP
 *   - a payment in an asset other than XLM / X402_ASSET_CODE is rejected
 *     instead of being compared to the caps at face value
 *   - batch_payment aggregates per asset, not as one undifferentiated number
 *
 * Unlike tests/agent.test.ts, `../backend/persistence` is NOT mocked here —
 * these tests need the real (in-memory) SQLite-backed rolling window to
 * exercise the atomic check-and-reserve path in
 * backend/persistence.ts's checkAndRecordSpending, not the in-memory-only
 * fallback a missing/broken persistence layer would fall back to.
 *
 * Asset-conversion ("convert" policy) tests live in
 * tests/agent_spending_conversion.test.ts, which needs a different static
 * config. Restart safety and hourly/daily window independence are covered at
 * the SpendingTracker unit level in tests/spending_tracker_windows.test.ts
 * and tests/spending_tracker_persistence.test.ts, which back this same
 * checkAndRecordSpending code path.
 */

import Database from 'better-sqlite3';
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../backend/tools/StellarPaymentTool', () => ({
  StellarPaymentTool: vi.fn().mockImplementation(() => ({
    execute: vi.fn().mockResolvedValue({ txHash: 'mock_hash', ledger: 1 }),
  })),
}));
vi.mock('../backend/tools/SorobanInvokeTool', () => ({
  SorobanInvokeTool: vi.fn().mockImplementation(() => ({ execute: vi.fn() })),
}));
vi.mock('../backend/tools/X402PaymentTool', () => ({
  X402PaymentTool: vi.fn().mockImplementation(() => ({ respond: vi.fn() })),
}));
vi.mock('../backend/tools/AccountInfoTool', () => ({
  AccountInfoTool: vi.fn().mockImplementation(() => ({ fetch: vi.fn() })),
}));
vi.mock('../backend/tools/TrustlineTool', () => ({
  TrustlineTool: vi.fn().mockImplementation(() => ({ execute: vi.fn(), checkTrustline: vi.fn() })),
}));
vi.mock('../backend/tools/MultiSigPaymentTool', () => ({
  MultiSigPaymentTool: vi.fn().mockImplementation(() => ({ execute: vi.fn() })),
}));
vi.mock('../backend/tools/BatchPaymentTool', () => ({
  BatchPaymentTool: vi.fn().mockImplementation(() => ({
    execute: vi.fn().mockResolvedValue({ txHash: 'batch_mock_hash', ledger: 1, skipped: 0 }),
  })),
}));
vi.mock('../backend/tools/SorobanQueryTool', () => ({
  SorobanQueryTool: vi.fn().mockImplementation(() => ({ query: vi.fn() })),
}));
vi.mock('../backend/tools/BalanceCheckTool', () => ({
  BalanceCheckTool: vi.fn().mockImplementation(() => ({ getBalance: vi.fn() })),
}));
vi.mock('../backend/tools/PathPaymentTool', () => ({
  PathPaymentTool: vi.fn().mockImplementation(() => ({
    execute: vi.fn().mockResolvedValue({ txHash: 'path_mock_hash', ledger: 1 }),
  })),
}));
vi.mock('../backend/tools/FeeBumpTool', () => ({
  FeeBumpTool: vi.fn().mockImplementation(() => ({ execute: vi.fn() })),
}));
vi.mock('../backend/tools/DexOfferTool', () => ({
  DexOfferTool: vi.fn().mockImplementation(() => ({ execute: vi.fn() })),
}));
vi.mock('../backend/tools/LiquidityPoolTool', () => ({
  LiquidityPoolTool: vi.fn().mockImplementation(() => ({ execute: vi.fn() })),
}));
vi.mock('../backend/tools/StellarTomlTool', () => ({
  StellarTomlTool: vi.fn().mockImplementation(() => ({ fetchToml: vi.fn() })),
}));
vi.mock('../backend/tools/DataEntryTool', () => ({
  DataEntryTool: vi.fn().mockImplementation(() => ({ execute: vi.fn() })),
}));
vi.mock('../backend/tools/SequenceNumberTool', () => ({
  SequenceNumberTool: vi.fn().mockImplementation(() => ({ execute: vi.fn() })),
}));
vi.mock('../backend/tools/SponsoredAccountTool', () => ({
  SponsoredAccountTool: vi.fn().mockImplementation(() => ({ execute: vi.fn() })),
}));
vi.mock('../backend/tools/AnchorQuoteTool', () => ({
  AnchorQuoteTool: vi.fn().mockImplementation(() => ({ execute: vi.fn() })),
}));
vi.mock('../backend/tools/InflationTool', () => ({
  InflationTool: vi.fn().mockImplementation(() => ({ execute: vi.fn() })),
}));
vi.mock('../backend/tools/ContractEventListener', () => ({
  listen: vi.fn().mockReturnValue(() => {}),
}));
vi.mock('../backend/tools/ClaimableBalanceTool', () => ({
  ClaimableBalanceTool: vi.fn().mockImplementation(() => ({ execute: vi.fn() })),
}));
vi.mock('../backend/tools/SetOptionsTool', () => ({
  SetOptionsTool: vi.fn().mockImplementation(() => ({ execute: vi.fn() })),
}));
vi.mock('../backend/tools/SorobanEventIndexerTool', () => ({
  SorobanEventIndexerTool: vi.fn().mockImplementation(() => ({ query: vi.fn() })),
}));
vi.mock('../backend/tools/StellarIdentityTool', () => ({
  StellarIdentityTool: vi.fn().mockImplementation(() => ({ execute: vi.fn() })),
}));
vi.mock('../backend/tools/BalanceStreamTool', () => {
  const { EventEmitter } = require('events');
  return {
    BalanceStreamTool: vi.fn().mockImplementation(() => {
      const emitter = new EventEmitter();
      return { subscribe: vi.fn().mockReturnValue(emitter), stop: vi.fn() };
    }),
  };
});
vi.mock('../backend/webhook', () => ({ dispatchWebhook: vi.fn().mockResolvedValue(undefined) }));

vi.mock('../backend/rpc_client', () => ({
  loadAccount: vi.fn(),
  submitTransaction: vi.fn(),
  prepareSorobanTx: vi.fn(),
  prepareSorobanTxWithEvents: vi.fn(),
  simulateSorobanTx: vi.fn(),
  horizonServer: { payments: vi.fn(() => ({ forAccount: vi.fn(() => ({ stream: vi.fn() })) })) },
  sorobanServer: {},
  resolveNetworkPassphrase: vi.fn(() => 'Test SDF Network ; September 2015'),
  StellarRPCError: class extends Error {},
}));

const DEST = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
const ISSUER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';

vi.mock('../backend/config', () => ({
  config: {
    STELLAR_NETWORK: 'mainnet',
    HORIZON_URL: 'https://horizon.stellar.org',
    SOROBAN_RPC_URL: 'https://soroban-mainnet.stellar.org',
    AGENT_PUBLIC_KEY: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
    X402_ASSET_CODE: 'USDC',
    X402_ASSET_ISSUER: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
    MAX_RETRIES: 3,
    RETRY_DELAY_MS: 100,
    MAX_CONCURRENT_TASKS: 10,
    AGENT_SPENDING_LIMIT: '15000',
    SPENDING_WINDOW_MS: 24 * 60 * 60 * 1000,
    DB_PATH: ':memory:',
    SPENDING_LIMIT_UNKNOWN_ASSET_POLICY: 'reject',
    agentKeypair: () => ({
      secret: () => 'SADQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQP54X',
    }),
  },
  MAINNET_SPENDING_CAP: 10_000,
}));

import { PayFiAgent, spendingTracker } from '../backend/agent';
import { StellarPaymentTool } from '../backend/tools/StellarPaymentTool';
import { BatchPaymentTool } from '../backend/tools/BatchPaymentTool';
import { _setDb } from '../backend/persistence';

describe('PayFiAgent — spending-limit atomicity across concurrent runs and assets', () => {
  beforeEach(() => {
    // Fresh in-memory DB per test so the rolling window starts empty and the
    // atomic check-and-reserve path (not the in-memory fallback) is exercised.
    _setDb(new Database(':memory:'));
    spendingTracker.clear();
    vi.mocked(StellarPaymentTool).mockImplementation(
      () => ({ execute: vi.fn().mockResolvedValue({ txHash: 'mock_hash', ledger: 1 }) }) as any
    );
    vi.mocked(BatchPaymentTool).mockImplementation(
      () =>
        ({
          execute: vi.fn().mockResolvedValue({ txHash: 'batch_mock_hash', ledger: 1, skipped: 0 }),
        }) as any
    );
  });

  // ── Concurrent runs ─────────────────────────────────────────────────────────

  it('two concurrent stellar_payment tasks that jointly exceed AGENT_SPENDING_LIMIT: exactly one succeeds', async () => {
    const agent = new PayFiAgent();
    const task = (amount: string) => ({
      type: 'stellar_payment' as const,
      payload: { destination: DEST, amount, assetCode: 'USDC', assetIssuer: ISSUER },
    });

    // limit is 15000; two payments of 8000 each jointly exceed it
    // (16000 > 15000), though neither alone does, and each is well within
    // the 10,000 mainnet cap too.
    const [r1, r2] = await Promise.all([agent.run(task('8000')), agent.run(task('8000'))]);

    const results = [r1, r2];
    expect(results.filter((r) => r.success)).toHaveLength(1);
    const failure = results.find((r) => !r.success);
    // The per-transaction check (8000 <= 15000) passes for both individually;
    // it is the cumulative rolling-window check that catches the pair.
    expect(failure?.error).toMatch(/Cumulative spending.*exceeds limit/);
  });

  it('running the same two payments across two separate PayFiAgent instances still enforces the shared cap', async () => {
    const agent1 = new PayFiAgent();
    const agent2 = new PayFiAgent();
    const task = (amount: string) => ({
      type: 'stellar_payment' as const,
      payload: { destination: DEST, amount, assetCode: 'USDC', assetIssuer: ISSUER },
    });

    const [r1, r2] = await Promise.all([agent1.run(task('8000')), agent2.run(task('8000'))]);

    expect([r1, r2].filter((r) => r.success)).toHaveLength(1);
  });

  it('a third concurrent payment fails once the first two consume the whole window, even though each is within the per-transaction limit', async () => {
    const agent = new PayFiAgent();
    const task = (amount: string) => ({
      type: 'stellar_payment' as const,
      payload: { destination: DEST, amount, assetCode: 'USDC', assetIssuer: ISSUER },
    });

    const results = await Promise.all([
      agent.run(task('6000')),
      agent.run(task('6000')),
      agent.run(task('6000')),
    ]);

    // 6000 + 6000 = 12000 (<= 15000, allowed); the third pushes to 18000 > 15000.
    expect(results.filter((r) => r.success)).toHaveLength(2);
    expect(results.filter((r) => !r.success)).toHaveLength(1);
  });

  // ── Multi-asset payments ─────────────────────────────────────────────────────

  it('rejects a payment in an asset that is neither XLM nor the configured reference asset', async () => {
    const agent = new PayFiAgent();
    const result = await agent.run({
      type: 'stellar_payment',
      payload: { destination: DEST, amount: '1', assetCode: 'BTC', assetIssuer: ISSUER },
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not XLM or the configured reference asset/);
    // The tool must never be reached — the guard rejects before any network call.
    expect(vi.mocked(StellarPaymentTool).mock.results[0]?.value.execute).not.toHaveBeenCalled();
  });

  it('batch_payment aggregates per asset instead of summing raw amounts across assets', async () => {
    const agent = new PayFiAgent();

    // USDC leg (6000) is within the mainnet cap on its own; XLM leg (6000) is
    // too. Neither breaches 10,000 alone, and naively summing 6000+6000=12000
    // as one undifferentiated number would wrongly reject this batch on the
    // mainnet cap. Their combined total (12000) also stays under the
    // configured AGENT_SPENDING_LIMIT of 15000, so that check isn't what's
    // under test here — see the next test for a mainnet-cap breach.
    const result = await agent.run({
      type: 'batch_payment',
      payload: {
        payments: [
          { destination: DEST, amount: '6000', assetCode: 'USDC', assetIssuer: ISSUER },
          { destination: DEST, amount: '6000', assetCode: 'XLM' },
        ],
      },
    });

    expect(result.success).toBe(true);
  });

  it('batch_payment still rejects when one asset leg alone breaches the mainnet cap', async () => {
    const agent = new PayFiAgent();

    const result = await agent.run({
      type: 'batch_payment',
      payload: {
        payments: [
          { destination: DEST, amount: '6000', assetCode: 'USDC', assetIssuer: ISSUER },
          { destination: DEST, amount: '6000', assetCode: 'USDC', assetIssuer: ISSUER },
          { destination: DEST, amount: '1', assetCode: 'XLM' },
        ],
      },
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/mainnet spending cap/);
  });
});
