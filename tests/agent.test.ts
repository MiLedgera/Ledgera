/**
 * tests/agent.test.ts
 *
 * Tests for PayFiAgent — focused on assertWithinSpendingLimit behaviour,
 * including the secondary mainnet spending cap guard.
 */

import { describe, it, test, expect, vi, beforeEach } from 'vitest';
import { PayFiAgent, spendingTracker, type TaskType } from '../backend/agent';
import { StellarPaymentTool } from '../backend/tools/StellarPaymentTool';
import { BalanceCheckTool } from '../backend/tools/BalanceCheckTool';
import { PathPaymentTool } from '../backend/tools/PathPaymentTool';
import { FeeBumpTool } from '../backend/tools/FeeBumpTool';
import { DexOfferTool } from '../backend/tools/DexOfferTool';
import { LiquidityPoolTool } from '../backend/tools/LiquidityPoolTool';
import { StellarTomlTool } from '../backend/tools/StellarTomlTool';
import { DataEntryTool } from '../backend/tools/DataEntryTool';
import { SequenceNumberTool } from '../backend/tools/SequenceNumberTool';
import { SponsoredAccountTool } from '../backend/tools/SponsoredAccountTool';
import { AnchorQuoteTool } from '../backend/tools/AnchorQuoteTool';
import { InflationTool } from '../backend/tools/InflationTool';
import { SorobanInvokeTool } from '../backend/tools/SorobanInvokeTool';
import { SorobanQueryTool } from '../backend/tools/SorobanQueryTool';
import { X402PaymentTool } from '../backend/tools/X402PaymentTool';
import { AccountInfoTool } from '../backend/tools/AccountInfoTool';
import { TrustlineTool } from '../backend/tools/TrustlineTool';
import { MultiSigPaymentTool } from '../backend/tools/MultiSigPaymentTool';
import { BatchPaymentTool } from '../backend/tools/BatchPaymentTool';
import { ValidationError, UnauthorizedError, ErrorType } from '../backend/errors';

vi.mock('../backend/tools/StellarPaymentTool', () => ({
  StellarPaymentTool: vi.fn().mockImplementation(() => ({
    execute: vi.fn().mockResolvedValue({ txHash: 'mock_hash', ledger: 1 }),
  })),
}));

vi.mock('../backend/tools/SorobanInvokeTool', () => ({
  SorobanInvokeTool: vi.fn().mockImplementation(() => ({
    execute: vi.fn(),
  })),
}));

vi.mock('../backend/tools/X402PaymentTool', () => ({
  X402PaymentTool: vi.fn().mockImplementation(() => ({
    respond: vi.fn(),
  })),
}));

vi.mock('../backend/tools/AccountInfoTool', () => ({
  AccountInfoTool: vi.fn().mockImplementation(() => ({
    fetch: vi.fn(),
  })),
}));

vi.mock('../backend/tools/TrustlineTool', () => ({
  TrustlineTool: vi.fn().mockImplementation(() => ({
    execute: vi.fn(),
    checkTrustline: vi.fn(),
  })),
}));

vi.mock('../backend/tools/MultiSigPaymentTool', () => ({
  MultiSigPaymentTool: vi.fn().mockImplementation(() => ({
    execute: vi.fn(),
  })),
}));

vi.mock('../backend/tools/BatchPaymentTool', () => ({
  BatchPaymentTool: vi.fn().mockImplementation(() => ({
    execute: vi.fn(),
  })),
}));

vi.mock('../backend/tools/SorobanQueryTool', () => ({
  SorobanQueryTool: vi.fn().mockImplementation(() => ({
    query: vi.fn(),
  })),
}));

vi.mock('../backend/tools/BalanceCheckTool', () => ({
  BalanceCheckTool: vi.fn().mockImplementation(() => ({
    getBalance: vi.fn().mockResolvedValue({
      publicKey: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
      balances: [],
    }),
  })),
}));

vi.mock('../backend/tools/PathPaymentTool', () => ({
  PathPaymentTool: vi.fn().mockImplementation(() => ({
    execute: vi.fn().mockResolvedValue({ txHash: 'path_mock_hash', ledger: 1 }),
  })),
}));

vi.mock('../backend/tools/FeeBumpTool', () => ({
  FeeBumpTool: vi.fn().mockImplementation(() => ({
    execute: vi.fn().mockResolvedValue({ txHash: 'fee_bump_mock_hash', ledger: 1 }),
  })),
}));

vi.mock('../backend/tools/DexOfferTool', () => ({
  DexOfferTool: vi.fn().mockImplementation(() => ({
    execute: vi.fn().mockResolvedValue({ txHash: 'dex_mock_hash', ledger: 1, offerId: '0' }),
  })),
}));

vi.mock('../backend/tools/LiquidityPoolTool', () => ({
  LiquidityPoolTool: vi.fn().mockImplementation(() => ({
    execute: vi.fn().mockResolvedValue({ poolId: 'pool_mock_id' }),
  })),
}));

vi.mock('../backend/tools/StellarTomlTool', () => ({
  StellarTomlTool: vi.fn().mockImplementation(() => ({
    fetchToml: vi.fn().mockResolvedValue({ VERSION: '2.0.0' }),
  })),
}));

vi.mock('../backend/tools/DataEntryTool', () => ({
  DataEntryTool: vi.fn().mockImplementation(() => ({
    execute: vi.fn().mockResolvedValue({ txHash: 'data_entry_mock_hash', ledger: 1 }),
  })),
}));

vi.mock('../backend/tools/SequenceNumberTool', () => ({
  SequenceNumberTool: vi.fn().mockImplementation(() => ({
    execute: vi.fn().mockResolvedValue({ sequence: '12345678' }),
  })),
}));

vi.mock('../backend/tools/SponsoredAccountTool', () => ({
  SponsoredAccountTool: vi.fn().mockImplementation(() => ({
    execute: vi.fn().mockResolvedValue({ txHash: 'sponsored_mock_hash', ledger: 1 }),
  })),
}));

vi.mock('../backend/tools/AnchorQuoteTool', () => ({
  AnchorQuoteTool: vi.fn().mockImplementation(() => ({
    execute: vi.fn().mockResolvedValue({ quoteId: 'quote_mock_id', price: '1.0' }),
  })),
}));

vi.mock('../backend/tools/InflationTool', () => ({
  InflationTool: vi.fn().mockImplementation(() => ({
    execute: vi.fn().mockResolvedValue({ txHash: 'inflation_mock_hash', ledger: 1 }),
  })),
}));

vi.mock('../backend/tools/ContractEventListener', () => ({
  listen: vi.fn().mockReturnValue(() => {}),
}));

vi.mock('../backend/webhook', () => ({
  dispatchWebhook: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../backend/persistence', () => ({
  saveResult: vi.fn(),
}));

// Named so `instanceof rpcClient.StellarRPCError` checks in agent.ts's error
// handling work against real thrown errors, matching the real class shape.
// Declared via vi.hoisted() because vi.mock() factories are hoisted above
// regular statements — a plain `class` declared here would be in its temporal
// dead zone by the time the factory below actually runs.
const { MockStellarRPCError } = vi.hoisted(() => {
  class MockStellarRPCError extends Error {
    readonly cause: unknown;
    constructor(message: string, cause?: unknown) {
      super(message);
      this.name = 'StellarRPCError';
      this.cause = cause;
    }
  }
  return { MockStellarRPCError };
});

vi.mock('../backend/rpc_client', () => ({
  loadAccount: vi.fn(),
  submitTransaction: vi.fn(),
  prepareSorobanTx: vi.fn(),
  prepareSorobanTxWithEvents: vi.fn(),
  simulateSorobanTx: vi.fn(),
  horizonServer: { payments: vi.fn(() => ({ forAccount: vi.fn(() => ({ stream: vi.fn() })) })) },
  sorobanServer: {},
  resolveNetworkPassphrase: vi.fn(() => 'Public Global Stellar Network ; September 2015'),
  StellarRPCError: MockStellarRPCError,
}));

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
    MAX_CONCURRENT_TASKS: 10, // Set above MAINNET_SPENDING_CAP to exercise the secondary runtime guard
    AGENT_SPENDING_LIMIT: '15000',
    agentKeypair: () => ({
      secret: () => 'SADQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQP54X',
    }),
  },
  MAINNET_SPENDING_CAP: 10_000,
}));

// ─── Tests ────────────────────────────────────────────────────────────────────

const DEST = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
const ISSUER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';

describe('PayFiAgent — runSequence', () => {
  let agent: PayFiAgent;

  beforeEach(() => {
    spendingTracker.clear();
    vi.clearAllMocks();
    // Re-apply default mock implementation after clearAllMocks (clearMocks resets call history
    // but also clears mockReturnValue / mockResolvedValue set inside vi.mock factories).
    vi.mocked(StellarPaymentTool).mockImplementation(
      () =>
        ({
          execute: vi.fn().mockResolvedValue({ txHash: 'mock_hash', ledger: 1 }),
        }) as any
    );
    agent = new PayFiAgent();
  });

  it('executes 3 tasks in order and returns all results on success', async () => {
    const task = {
      type: 'stellar_payment' as const,
      payload: { destination: DEST, amount: '100', assetCode: 'USDC', assetIssuer: ISSUER },
    };
    const results = await agent.runSequence([task, task, task]);
    expect(results).toHaveLength(3);
    expect(results.every((r) => r.success)).toBe(true);
  });

  it('stops at task 2 when it fails and does not execute task 3', async () => {
    const mockInstance = vi.mocked(StellarPaymentTool).mock.results[0]!.value;
    mockInstance.execute
      .mockResolvedValueOnce({ txHash: 'hash1', ledger: 1 })
      .mockRejectedValueOnce(new Error('Network failure'));

    const task = {
      type: 'stellar_payment' as const,
      payload: { destination: DEST, amount: '100', assetCode: 'USDC', assetIssuer: ISSUER },
    };
    const results = await agent.runSequence([task, task, task]);
    expect(results).toHaveLength(2);
    expect(results[0]!.success).toBe(true);
    expect(results[1]!.success).toBe(false);
    expect(results[1]!.error).toContain('Network failure');
    expect(mockInstance.execute).toHaveBeenCalledTimes(2);
  });

  // ── #370: positional context on sequence results ──────────────────────────

  it('stamps sequenceIndex on every result, including the one that failed', async () => {
    const mockInstance = vi.mocked(StellarPaymentTool).mock.results[0]!.value;
    mockInstance.execute
      .mockResolvedValueOnce({ txHash: 'hash1', ledger: 1 })
      .mockRejectedValueOnce(new Error('Network failure'));

    const task = {
      type: 'stellar_payment' as const,
      payload: { destination: DEST, amount: '100', assetCode: 'USDC', assetIssuer: ISSUER },
    };
    const results = await agent.runSequence([task, task, task]);

    expect(results).toHaveLength(2);
    expect(results[0]!.sequenceIndex).toBe(0);
    // The failing task is index 1 of the original three, and says so without
    // the caller having to infer it from the truncated array.
    expect(results[1]!.sequenceIndex).toBe(1);
    expect(results[1]!.success).toBe(false);
  });

  it('keeps sequenceIndex correct after the results array is filtered', async () => {
    const mockInstance = vi.mocked(StellarPaymentTool).mock.results[0]!.value;
    mockInstance.execute
      .mockResolvedValueOnce({ txHash: 'hash1', ledger: 1 })
      .mockResolvedValueOnce({ txHash: 'hash2', ledger: 2 })
      .mockRejectedValueOnce(new Error('Network failure'));

    const task = {
      type: 'stellar_payment' as const,
      payload: { destination: DEST, amount: '100', assetCode: 'USDC', assetIssuer: ISSUER },
    };
    const results = await agent.runSequence([task, task, task]);

    // This is the case array position cannot answer: once the successes are
    // dropped, position 0 of the filtered array is task 2 of the sequence.
    const failures = results.filter((r) => !r.success);
    expect(failures).toHaveLength(1);
    expect(failures[0]!.sequenceIndex).toBe(2);
  });

  it('does not set sequenceIndex on a single run()', async () => {
    const result = await agent.run({
      type: 'stellar_payment' as const,
      payload: { destination: DEST, amount: '100', assetCode: 'USDC', assetIssuer: ISSUER },
    });
    expect(result.sequenceIndex).toBeUndefined();
  });

  it('rejects mid-sequence when a task exceeds the mainnet spending cap', async () => {
    const okTask = {
      type: 'stellar_payment' as const,
      payload: { destination: DEST, amount: '9999', assetCode: 'USDC', assetIssuer: ISSUER },
    };
    const overCapTask = {
      type: 'stellar_payment' as const,
      payload: { destination: DEST, amount: '11000', assetCode: 'USDC', assetIssuer: ISSUER },
    };
    const results = await agent.runSequence([okTask, overCapTask, okTask]);
    expect(results).toHaveLength(2);
    expect(results[0]!.success).toBe(true);
    expect(results[1]!.success).toBe(false);
    expect(results[1]!.error).toMatch(/mainnet spending cap/);
  });
});

// ── #368: structured auth context reaches AgentResult.error ─────────────────

describe('PayFiAgent — structured error context', () => {
  let agent: PayFiAgent;
  const ROGUE_SIGNER = 'GCVJ4Z6TI6Z2SOGENSPXDQ2U4RKH3CNQKYUHNSSQ5HDIWEVI6V6VOSWZ';

  beforeEach(() => {
    spendingTracker.clear();
    vi.clearAllMocks();
    agent = new PayFiAgent();
  });

  it('serialises UnauthorizedError context, including the signer, into error', async () => {
    vi.mocked(StellarPaymentTool).mockImplementation(
      () =>
        ({
          execute: vi.fn().mockRejectedValue(
            new UnauthorizedError(`Unexpected Soroban auth signer: ${ROGUE_SIGNER}`, {
              signer: ROGUE_SIGNER,
              expected: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
            })
          ),
        }) as any
    );
    agent = new PayFiAgent();

    const result = await agent.run({
      type: 'stellar_payment' as const,
      payload: { destination: DEST, amount: '100', assetCode: 'USDC', assetIssuer: ISSUER },
    });

    expect(result.success).toBe(false);
    expect(result.errorType).toBe(ErrorType.UnauthorizedError);
    // The signer must survive into the string field, because that is all the
    // persisted result and the webhook payload carry.
    expect(result.error).toContain(ROGUE_SIGNER);
    expect(result.error).toContain('expected');
  });

  it('leaves the message untouched for an error with no structured cause', async () => {
    vi.mocked(StellarPaymentTool).mockImplementation(
      () =>
        ({
          execute: vi.fn().mockRejectedValue(new Error('plain failure')),
        }) as any
    );
    agent = new PayFiAgent();

    const result = await agent.run({
      type: 'stellar_payment' as const,
      payload: { destination: DEST, amount: '100', assetCode: 'USDC', assetIssuer: ISSUER },
    });

    expect(result.error).toBe('plain failure');
    expect(result.error).not.toContain('context:');
  });

  it('does not serialise signing material out of an error cause', async () => {
    const SECRET = 'SCVJ4Z6TI6Z2SOGENSPXDQ2U4RKH3CNQKYUHNSSQ5HDIWEVI6V6VOAAA';
    vi.mocked(StellarPaymentTool).mockImplementation(
      () =>
        ({
          execute: vi
            .fn()
            .mockRejectedValue(
              new UnauthorizedError('bad signer', { signer: ROGUE_SIGNER, secretKey: SECRET })
            ),
        }) as any
    );
    agent = new PayFiAgent();

    const result = await agent.run({
      type: 'stellar_payment' as const,
      payload: { destination: DEST, amount: '100', assetCode: 'USDC', assetIssuer: ISSUER },
    });

    expect(result.error).toContain(ROGUE_SIGNER);
    expect(result.error).not.toContain(SECRET);
  });
});

describe('PayFiAgent — mainnet spending cap', () => {
  let agent: PayFiAgent;

  beforeEach(() => {
    spendingTracker.clear();
    vi.clearAllMocks();
    vi.mocked(StellarPaymentTool).mockImplementation(
      () =>
        ({
          execute: vi.fn().mockResolvedValue({ txHash: 'mock_hash', ledger: 1 }),
        }) as any
    );
    agent = new PayFiAgent();
  });

  it('rejects a stellar_payment above MAINNET_SPENDING_CAP on mainnet', async () => {
    const result = await agent.run({
      type: 'stellar_payment',
      payload: {
        destination: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
        amount: '12000',
        assetCode: 'USDC',
        assetIssuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
      },
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/mainnet spending cap/);
  });

  it('rejects an x402_respond above MAINNET_SPENDING_CAP on mainnet', async () => {
    const result = await agent.run({
      type: 'x402_respond',
      payload: {
        resource: 'https://api.example.com/data',
        amount: '11000',
        assetCode: 'USDC',
        assetIssuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
        payTo: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
        nonce: '550e8400-e29b-41d4-a716-446655440000',
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/mainnet spending cap/);
  });

  it('accepts a stellar_payment at or below MAINNET_SPENDING_CAP on mainnet', async () => {
    const result = await agent.run({
      type: 'stellar_payment',
      payload: {
        destination: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
        amount: '9999',
        assetCode: 'USDC',
        assetIssuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
      },
    });

    expect(result.success).toBe(true);
  });

  it('two PayFiAgent instances do not share state when run concurrently', async () => {
    vi.clearAllMocks();
    const agent1 = new PayFiAgent();
    const agent2 = new PayFiAgent();

    const mockInstance1 = vi.mocked(StellarPaymentTool).mock.results[0]!.value;
    const mockInstance2 = vi.mocked(StellarPaymentTool).mock.results[1]!.value;

    mockInstance1.execute.mockResolvedValueOnce({ txHash: 'tx_hash_1', ledger: 1 });
    mockInstance2.execute.mockResolvedValueOnce({ txHash: 'tx_hash_2', ledger: 2 });

    const task = {
      type: 'stellar_payment' as const,
      payload: {
        destination: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
        amount: '100',
        assetCode: 'USDC',
        assetIssuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
      },
    };

    const [result1, result2] = await Promise.all([agent1.run(task), agent2.run(task)]);

    expect(result1.success).toBe(true);
    expect(result2.success).toBe(true);
    expect((result1.data as Record<string, unknown>)?.txHash).toBe('tx_hash_1');
    expect((result2.data as Record<string, unknown>)?.txHash).toBe('tx_hash_2');
    expect((result1.data as any)?.txHash).toBe('tx_hash_1');
    expect((result2.data as any)?.txHash).toBe('tx_hash_2');
    expect(agent1).not.toBe(agent2);
  });
});

// Audit finding S-1: assertWithinSpendingLimit (and thus MAINNET_SPENDING_CAP)
// was previously enforced for only stellar_payment/x402_respond, leaving every
// other value-moving task type free to move unbounded amounts on mainnet.
// These tests pin the fix — each task type below must reject an amount above
// MAINNET_SPENDING_CAP (10_000, mocked above) before ever reaching its tool.
describe('PayFiAgent — spending-limit enforcement across all money-moving task types (audit S-1)', () => {
  let agent: PayFiAgent;

  beforeEach(() => {
    spendingTracker.clear();
    // vitest.config.ts sets restoreMocks: true, which resets every vi.fn()
    // (including the mockImplementation set inside each vi.mock() factory)
    // after every test — so any tool actually reached (i.e. not blocked by
    // the spending guard) needs its mock re-applied here, same as the
    // "task dispatch matrix" describe block below.
    vi.mocked(MultiSigPaymentTool).mockImplementation(
      () => ({ execute: vi.fn().mockResolvedValue({ txHash: 's1_multisig_hash', ledger: 1 }) }) as any
    );
    vi.mocked(BatchPaymentTool).mockImplementation(
      () =>
        ({
          execute: vi.fn().mockResolvedValue({ txHash: 's1_batch_hash', ledger: 1, skipped: 0 }),
        }) as any
    );
    vi.mocked(PathPaymentTool).mockImplementation(
      () => ({ execute: vi.fn().mockResolvedValue({ txHash: 's1_path_hash', ledger: 1 }) }) as any
    );
    vi.mocked(DexOfferTool).mockImplementation(
      () =>
        ({
          execute: vi.fn().mockResolvedValue({ txHash: 's1_dex_hash', ledger: 1, offerId: '42' }),
        }) as any
    );
    vi.mocked(LiquidityPoolTool).mockImplementation(
      () => ({ execute: vi.fn().mockResolvedValue({ txHash: 's1_lp_hash', ledger: 1 }) }) as any
    );
    vi.mocked(SponsoredAccountTool).mockImplementation(
      () =>
        ({
          execute: vi.fn().mockResolvedValue({
            txHash: 's1_sponsored_hash',
            ledger: 1,
            newAccountPublicKey: DEST,
            startingBalance: '5',
          }),
        }) as any
    );
    agent = new PayFiAgent();
  });

  it('rejects a multisig_payment above MAINNET_SPENDING_CAP', async () => {
    const result = await agent.run({
      type: 'multisig_payment',
      payload: { destination: DEST, amount: '12000', additionalSigners: [], minSignatures: 1 },
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/mainnet spending cap/);
  });

  it('rejects a batch_payment whose aggregate exceeds MAINNET_SPENDING_CAP', async () => {
    const result = await agent.run({
      type: 'batch_payment',
      payload: {
        payments: [
          { destination: DEST, amount: '6000', assetCode: 'USDC', assetIssuer: ISSUER },
          { destination: DEST, amount: '6000', assetCode: 'USDC', assetIssuer: ISSUER },
        ],
      },
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/mainnet spending cap/);
  });

  it('rejects a path_payment (sendAmount) above MAINNET_SPENDING_CAP', async () => {
    const result = await agent.run({
      type: 'path_payment',
      payload: {
        destination: DEST,
        sendAsset: { code: 'XLM' },
        sendAmount: '11000',
        destAsset: { code: 'USDC', issuer: ISSUER },
        destMinAmount: '1',
      },
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/mainnet spending cap/);
  });

  it('rejects a swap (sellAmount) above MAINNET_SPENDING_CAP', async () => {
    const result = await agent.run({
      type: 'swap',
      payload: {
        sellAsset: { code: 'XLM' },
        buyAsset: { code: 'USDC', issuer: ISSUER },
        sellAmount: '11000',
        maxSlippagePct: 1,
      },
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/mainnet spending cap/);
  });

  it('rejects a dex_offer create above MAINNET_SPENDING_CAP', async () => {
    const result = await agent.run({
      type: 'dex_offer',
      payload: {
        action: 'create',
        selling: { code: 'XLM' },
        buying: { code: 'USDC', issuer: ISSUER },
        amount: '11000',
        price: '1',
      },
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/mainnet spending cap/);
  });

  it('does not apply the cap to a dex_offer delete (amount is forced to 0 on-chain)', async () => {
    const result = await agent.run({
      type: 'dex_offer',
      payload: {
        action: 'delete',
        selling: { code: 'XLM' },
        buying: { code: 'USDC', issuer: ISSUER },
        amount: '11000',
        price: '1',
        offerId: '42',
      },
    });
    expect(result.success).toBe(true);
  });

  it('rejects a liquidity_pool deposit above MAINNET_SPENDING_CAP', async () => {
    const result = await agent.run({
      type: 'liquidity_pool',
      payload: {
        action: 'deposit',
        liquidityPoolId: 'pool-1',
        maxAmountA: '11000',
        maxAmountB: '100',
        minPrice: '0.1',
        maxPrice: '10',
      },
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/mainnet spending cap/);
  });

  it('does not apply the cap to a liquidity_pool withdraw (funds return to the agent)', async () => {
    const result = await agent.run({
      type: 'liquidity_pool',
      payload: {
        action: 'withdraw',
        liquidityPoolId: 'pool-1',
        amount: '11000',
        minAmountA: '1',
        minAmountB: '1',
      },
    });
    expect(result.success).toBe(true);
  });

  it('rejects a sponsored_account startingBalance above MAINNET_SPENDING_CAP', async () => {
    const result = await agent.run({
      type: 'sponsored_account',
      payload: { newAccountPublicKey: DEST, startingBalance: '11000' },
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/mainnet spending cap/);
  });

  it('accepts each task type at an amount within the cap', async () => {
    const cases: Array<{ type: TaskType; payload: unknown }> = [
      {
        type: 'multisig_payment',
        payload: { destination: DEST, amount: '100', additionalSigners: [], minSignatures: 1 },
      },
      {
        type: 'path_payment',
        payload: {
          destination: DEST,
          sendAsset: { code: 'XLM' },
          sendAmount: '100',
          destAsset: { code: 'USDC', issuer: ISSUER },
          destMinAmount: '1',
        },
      },
      {
        type: 'sponsored_account',
        payload: { newAccountPublicKey: DEST, startingBalance: '5' },
      },
    ];

    for (const { type, payload } of cases) {
      const result = await agent.run({ type, payload });
      expect(result.success).toBe(true);
    }
  });
});

describe('AgentResult snapshot', () => {
  let agent: PayFiAgent;

  beforeEach(() => {
    spendingTracker.clear();
    vi.clearAllMocks();
    vi.mocked(StellarPaymentTool).mockImplementation(
      () =>
        ({
          execute: vi.fn().mockResolvedValue({ txHash: 'success_tx_hash', ledger: 1 }),
        }) as any
    );
    agent = new PayFiAgent();
  });

  it('AgentResult has expected shape on success', async () => {
    const result = await agent.run({
      type: 'stellar_payment',
      payload: {
        destination: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
        amount: '100',
        assetCode: 'USDC',
        assetIssuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
      },
      correlationId: 'fixed-test-id-success',
    });

    expect(result).toMatchSnapshot();
    expect(result).toHaveProperty('success', true);
    expect(result).toHaveProperty('taskType', 'stellar_payment');
    expect(result).toHaveProperty('data');
  });

  it('adds network metadata to payment task results', async () => {
    const result = await agent.run({
      type: 'stellar_payment',
      payload: {
        destination: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
        amount: '100',
        assetCode: 'USDC',
        assetIssuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
      },
    });

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({ network: 'mainnet' });
  });

  it('AgentResult has expected shape on failure', async () => {
    const mockInstance = vi.mocked(StellarPaymentTool).mock.results[0]!.value;
    mockInstance.execute.mockRejectedValueOnce(new Error('Test error'));

    const result = await agent.run({
      type: 'stellar_payment',
      payload: {
        destination: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
        amount: '100',
        assetCode: 'USDC',
        assetIssuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
      },
      correlationId: 'fixed-test-id-failure',
    });

    expect(result).toMatchSnapshot();
    expect(result).toHaveProperty('success', false);
    expect(result).toHaveProperty('taskType', 'stellar_payment');
    expect(result).toHaveProperty('error');
  });
});

describe('PayFiAgent — new task types', () => {
  let agent: PayFiAgent;

  beforeEach(() => {
    spendingTracker.clear();
    vi.clearAllMocks();
    vi.mocked(StellarPaymentTool).mockImplementation(
      () =>
        ({
          execute: vi.fn().mockResolvedValue({ txHash: 'mock_hash', ledger: 1 }),
        }) as any
    );
    vi.mocked(BalanceCheckTool).mockImplementation(
      () =>
        ({
          getBalance: vi.fn().mockResolvedValue({ publicKey: DEST, balances: [] }),
        }) as any
    );
    vi.mocked(PathPaymentTool).mockImplementation(
      () =>
        ({
          execute: vi.fn().mockResolvedValue({ txHash: 'path_mock_hash', ledger: 1 }),
        }) as any
    );
    vi.mocked(FeeBumpTool).mockImplementation(
      () =>
        ({
          execute: vi.fn().mockResolvedValue({ txHash: 'fee_bump_mock_hash', ledger: 1 }),
        }) as any
    );
    vi.mocked(DexOfferTool).mockImplementation(
      () =>
        ({
          execute: vi.fn().mockResolvedValue({ txHash: 'dex_mock_hash', ledger: 1, offerId: '0' }),
        }) as any
    );
    agent = new PayFiAgent();
  });

  it('dispatches balance_check and returns success', async () => {
    const result = await agent.run({
      type: 'balance_check',
      payload: { publicKey: DEST },
    });
    expect(result.success).toBe(true);
    expect(result.taskType).toBe('balance_check');
  });

  it('dispatches path_payment and returns success', async () => {
    const result = await agent.run({
      type: 'path_payment',
      payload: {
        destination: DEST,
        sendAsset: { code: 'XLM' },
        sendAmount: '10',
        destAsset: { code: 'USDC', issuer: ISSUER },
        destMinAmount: '9',
      },
    });
    expect(result.success).toBe(true);
    expect(result.taskType).toBe('path_payment');
  });

  it('dispatches fee_bump and returns success', async () => {
    const result = await agent.run({
      type: 'fee_bump',
      payload: { innerTxXdr: 'AAAA' },
    });
    expect(result.success).toBe(true);
    expect(result.taskType).toBe('fee_bump');
  });

  it('dispatches dex_offer and returns success', async () => {
    const result = await agent.run({
      type: 'dex_offer',
      payload: {
        action: 'create',
        selling: { code: 'XLM' },
        buying: { code: 'USDC', issuer: ISSUER },
        amount: '100',
        price: '0.25',
      },
    });
    expect(result.success).toBe(true);
    expect(result.taskType).toBe('dex_offer');
  });

  it('startContractListener starts the listener and stopContractListener stops it', () => {
    const onEvent = vi.fn();
    agent.startContractListener(
      'CDPVBHPSVYKWSI5ECEA4DASBG3RBNU5EHEE3DHNFX7RMBCZV66CSC7NH',
      [],
      onEvent
    );
    agent.stopContractListener();
    // No error thrown — listener lifecycle works
  });

  it('destroy() cleans up the contract listener', () => {
    const onEvent = vi.fn();
    agent.startContractListener(
      'CDPVBHPSVYKWSI5ECEA4DASBG3RBNU5EHEE3DHNFX7RMBCZV66CSC7NH',
      [],
      onEvent
    );
    expect(() => agent.destroy()).not.toThrow();
  });
});

describe('PayFiAgent — drain / waitForPendingTasks', () => {
  let agent: PayFiAgent;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(StellarPaymentTool).mockImplementation(
      () =>
        ({
          execute: vi.fn().mockResolvedValue({ txHash: 'mock_hash', ledger: 1 }),
        }) as any
    );
    agent = new PayFiAgent();
  });

  it('rejects new tasks after drain() is called', async () => {
    agent.drain();

    const result = await agent.run({
      type: 'stellar_payment',
      payload: { destination: DEST, amount: '100', assetCode: 'USDC', assetIssuer: ISSUER },
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/shutting down/i);
  });

  it('waitForPendingTasks() resolves when activeTasks reaches 0', async () => {
    let resolveExecute!: (value: unknown) => void;
    const pending = new Promise((resolve) => {
      resolveExecute = resolve;
    });
    const mockInstance = vi.mocked(StellarPaymentTool).mock.results[0]!.value;
    mockInstance.execute.mockReturnValueOnce(pending);

    const runPromise = agent.run({
      type: 'stellar_payment',
      payload: { destination: DEST, amount: '100', assetCode: 'USDC', assetIssuer: ISSUER },
    });

    // Let run() reach the `activeTasks++` before checking wait behaviour.
    await Promise.resolve();

    let waitResolved = false;
    const waitPromise = agent.waitForPendingTasks().then(() => {
      waitResolved = true;
    });

    // Task is still in flight — waitForPendingTasks() must still be pending.
    await new Promise((r) => setTimeout(r, 50));
    expect(waitResolved).toBe(false);

    resolveExecute({ txHash: 'mock_hash', ledger: 1 });
    await runPromise;
    await waitPromise;

    expect(waitResolved).toBe(true);
  });

  it('waitForPendingTasks() resolves immediately if no tasks are active', async () => {
    const setIntervalSpy = vi.spyOn(global, 'setInterval');

    await agent.waitForPendingTasks();

    expect(setIntervalSpy).not.toHaveBeenCalled();
    setIntervalSpy.mockRestore();
  });
});

describe('PayFiAgent — middleware system', () => {
  let agent: PayFiAgent;

  beforeEach(() => {
    spendingTracker.clear();
    vi.clearAllMocks();
    vi.mocked(StellarPaymentTool).mockImplementation(
      () =>
        ({
          execute: vi.fn().mockResolvedValue({ txHash: 'mock_hash', ledger: 1 }),
        }) as any
    );
    agent = new PayFiAgent();
  });

  it('registers middleware via use() method', () => {
    const middleware = vi.fn(async (task, next) => next());
    agent.use(middleware);
    // Middleware is registered - verified by internal state
    expect(agent).toBeDefined();
  });

  it('executes middleware in registration order', async () => {
    const executionOrder: string[] = [];

    agent.use(async (task, next) => {
      executionOrder.push('middleware1');
      return next();
    });

    agent.use(async (task, next) => {
      executionOrder.push('middleware2');
      return next();
    });

    const result = await agent.run({
      type: 'stellar_payment',
      payload: { destination: DEST, amount: '100', assetCode: 'USDC', assetIssuer: ISSUER },
    });

    expect(result.success).toBe(true);
    expect(executionOrder).toEqual(['middleware1', 'middleware2']);
  });

  it('allows middleware to short-circuit task execution', async () => {
    agent.use(async (task, next) => {
      return {
        success: false,
        taskType: task.type,
        error: 'Short-circuited by middleware',
        correlationId: task.correlationId ?? 'test-correlation-id',
      };
    });

    const result = await agent.run({
      type: 'stellar_payment',
      payload: { destination: DEST, amount: '100', assetCode: 'USDC', assetIssuer: ISSUER },
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe('Short-circuited by middleware');
    // Tool should not have been called
    const mockInstance = vi.mocked(StellarPaymentTool).mock.results[0]?.value;
    if (mockInstance) {
      expect(mockInstance.execute).not.toHaveBeenCalled();
    }
  });

  it('middleware can inspect and modify task before execution', async () => {
    agent.use(async (task, next) => {
      // Modify the task payload
      if (task.type === 'stellar_payment') {
        (task.payload as Record<string, unknown>).amount = '50';
      }
      return next();
    });

    const result = await agent.run({
      type: 'stellar_payment',
      payload: { destination: DEST, amount: '100', assetCode: 'USDC', assetIssuer: ISSUER },
    });

    expect(result.success).toBe(true);
    // Verify the tool was called with modified payload
    const mockInstance = vi.mocked(StellarPaymentTool).mock.results[0]?.value;
    if (mockInstance) {
      expect(mockInstance.execute).toHaveBeenCalledWith(expect.objectContaining({ amount: '50' }));
    }
  });

  it('middleware handles errors thrown in middleware', async () => {
    agent.use(async (task, next) => {
      throw new Error('Middleware error');
    });

    const result = await agent.run({
      type: 'stellar_payment',
      payload: { destination: DEST, amount: '100', assetCode: 'USDC', assetIssuer: ISSUER },
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Middleware error');
  });

  it('middleware executes after task completion (post-execution)', async () => {
    const postExecutionLog: string[] = [];

    agent.use(async (task, next) => {
      const result = await next();
      postExecutionLog.push('after-execution');
      return result;
    });

    const result = await agent.run({
      type: 'stellar_payment',
      payload: { destination: DEST, amount: '100', assetCode: 'USDC', assetIssuer: ISSUER },
    });

    expect(result.success).toBe(true);
    expect(postExecutionLog).toEqual(['after-execution']);
  });

  it('pass-through middleware with no modifications', async () => {
    agent.use(async (task, next) => {
      // Just pass through without modification
      return next();
    });

    const result = await agent.run({
      type: 'stellar_payment',
      payload: { destination: DEST, amount: '100', assetCode: 'USDC', assetIssuer: ISSUER },
    });

    expect(result.success).toBe(true);
  });
});

describe('PayFiAgent — payload sanitisation', () => {
  let agent: PayFiAgent;

  beforeEach(() => {
    spendingTracker.clear();
    vi.clearAllMocks();
    vi.mocked(StellarPaymentTool).mockImplementation(
      () =>
        ({
          execute: vi.fn().mockResolvedValue({ txHash: 'mock_hash', ledger: 1 }),
        }) as any
    );
    agent = new PayFiAgent();
  });

  it('scrubs secretKey from payload before logging on failure', async () => {
    const mockInstance = vi.mocked(StellarPaymentTool).mock.results[0]?.value;
    if (!mockInstance) throw new Error('Mock instance not found');
    mockInstance.execute.mockRejectedValueOnce(new Error('simulated payment failure'));

    const result = await agent.run({
      type: 'stellar_payment',
      payload: {
        destination: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
        amount: '100',
        assetCode: 'USDC',
        assetIssuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
        secretKey: 'SABCDEFGHIJKLMNOPQRSTUVWXYZ234567',
      },
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe('simulated payment failure');
    expect(result.error).not.toContain('SABCDEFGHIJKLMNOPQRSTUVWXYZ234567');
  });

  it('recursively redacts nested sensitive keys in deeply nested objects', async () => {
    const mockInstance = vi.mocked(StellarPaymentTool).mock.results[0]?.value;
    if (!mockInstance) throw new Error('Mock instance not found');
    mockInstance.execute.mockRejectedValueOnce(new Error('simulated nested payload failure'));

    const result = await agent.run({
      type: 'stellar_payment',
      payload: {
        destination: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
        amount: '100',
        assetCode: 'USDC',
        assetIssuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
        signer: {
          secretKey: 'SABCDEFGHIJKLMNOPQRSTUVWXYZ234567',
          address: 'GXYZ',
        },
        nested: {
          level2: {
            privateKey: 'SABCDEFGHIJKLMNOPQRSTUVWXYZ234567',
            mnemonic: 'word1 word2 word3',
          },
        },
      },
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe('simulated nested payload failure');
  });

  it('includes errorType in AgentResult for structured errors', async () => {
    const mockInstance = vi.mocked(StellarPaymentTool).mock.results[0]?.value;
    if (!mockInstance) throw new Error('Mock instance not found');
    mockInstance.execute.mockRejectedValueOnce(new ValidationError('Invalid payment parameters'));

    const result = await agent.run({
      type: 'stellar_payment',
      payload: {
        destination: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
        amount: '100',
        assetCode: 'USDC',
        assetIssuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
      },
    });

    expect(result.success).toBe(false);
    expect(result.errorType).toBe('VALIDATION_ERROR');
    expect(result.error).toBe('Invalid payment parameters');
  });
});

// ─── Mutation-killing assertions for backend/agent.ts (#456) ─────────────────
// These tests are specifically designed to eliminate surviving mutants that
// Stryker identifies in the spending-limit guards, spending-cap boundary checks,
// and task-dispatch branching in PayFiAgent.

describe('PayFiAgent — mutation-killing: spending-limit boundary conditions', () => {
  let agent: PayFiAgent;

  beforeEach(() => {
    spendingTracker.clear();
    vi.clearAllMocks();
    vi.mocked(StellarPaymentTool).mockImplementation(
      () => ({ execute: vi.fn().mockResolvedValue({ txHash: 'ok', ledger: 1 }) }) as any
    );
    agent = new PayFiAgent();
  });

  it('rejects a payment exactly equal to AGENT_SPENDING_LIMIT (boundary — must fail)', async () => {
    // AGENT_SPENDING_LIMIT is set to "15000" in test config; MAINNET_SPENDING_CAP is 10_000.
    // A payment of exactly 10001 should be blocked by the mainnet cap (> 10_000).
    const result = await agent.run({
      type: 'stellar_payment',
      payload: { destination: DEST, amount: '10001', assetCode: 'XLM' },
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/mainnet spending cap/i);
  });

  it('rejects a payment one unit above MAINNET_SPENDING_CAP (10001)', async () => {
    const result = await agent.run({
      type: 'stellar_payment',
      payload: { destination: DEST, amount: '10002', assetCode: 'XLM' },
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/mainnet spending cap/i);
  });

  it('allows a payment strictly below MAINNET_SPENDING_CAP (9999)', async () => {
    const result = await agent.run({
      type: 'stellar_payment',
      payload: { destination: DEST, amount: '9999', assetCode: 'XLM' },
    });
    // The mock resolves, so this should succeed (assuming spending tracker starts empty)
    expect(result.success).toBe(true);
  });

  it('result.taskType always equals the dispatched task type', async () => {
    const result = await agent.run({
      type: 'stellar_payment',
      payload: { destination: DEST, amount: '1', assetCode: 'XLM' },
    });
    // Mutants that swap or delete the taskType assignment would break this.
    expect(result.taskType).toBe('stellar_payment');
  });

  it('result.success is exactly false (not truthy-falsy) when the payment fails', async () => {
    vi.mocked(StellarPaymentTool).mockImplementation(
      () => ({ execute: vi.fn().mockRejectedValue(new Error('forced failure')) }) as any
    );
    const agent2 = new PayFiAgent();
    const result = await agent2.run({
      type: 'stellar_payment',
      payload: { destination: DEST, amount: '1', assetCode: 'XLM' },
    });
    expect(result.success).toBe(false); // strict false, not just falsy
    expect(result.success).not.toBe(true);
  });

  it('result.success is exactly true (not truthy) when the payment succeeds', async () => {
    const result = await agent.run({
      type: 'stellar_payment',
      payload: { destination: DEST, amount: '1', assetCode: 'XLM' },
    });
    expect(result.success).toBe(true); // strict true
    expect(result.success).not.toBe(false);
  });

  it('run() rejects unknown task types with an error result (not a thrown exception)', async () => {
    const result = await agent.run({
      type: 'unknown_type' as any,
      payload: {},
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/unknown task type/i);
  });

  it('correlationId is always a non-empty string on success', async () => {
    const result = await agent.run({
      type: 'stellar_payment',
      payload: { destination: DEST, amount: '1', assetCode: 'XLM' },
    });
    expect(typeof result.correlationId).toBe('string');
    expect(result.correlationId!.length).toBeGreaterThan(0);
  });

  it('correlationId is always a non-empty string on failure', async () => {
    vi.mocked(StellarPaymentTool).mockImplementation(
      () => ({ execute: vi.fn().mockRejectedValue(new Error('forced')) }) as any
    );
    const a2 = new PayFiAgent();
    const result = await a2.run({
      type: 'stellar_payment',
      payload: { destination: DEST, amount: '1', assetCode: 'XLM' },
    });
    expect(typeof result.correlationId).toBe('string');
    expect(result.correlationId!.length).toBeGreaterThan(0);
  });
});

describe('PayFiAgent — mutation-killing: StellarPaymentTool data passthrough', () => {
  let agent: PayFiAgent;

  beforeEach(() => {
    spendingTracker.clear();
    vi.clearAllMocks();
    vi.mocked(StellarPaymentTool).mockImplementation(
      () =>
        ({ execute: vi.fn().mockResolvedValue({ txHash: 'hash_passthrough', ledger: 42 }) }) as any
    );
    agent = new PayFiAgent();
  });

  it('result.data.txHash matches the value returned by StellarPaymentTool.execute', async () => {
    const result = await agent.run({
      type: 'stellar_payment',
      payload: { destination: DEST, amount: '1', assetCode: 'XLM' },
    });
    expect(result.success).toBe(true);
    expect((result.data as any).txHash).toBe('hash_passthrough');
  });

  it('result.data.ledger matches the value returned by StellarPaymentTool.execute', async () => {
    const result = await agent.run({
      type: 'stellar_payment',
      payload: { destination: DEST, amount: '1', assetCode: 'XLM' },
    });
    expect((result.data as any).ledger).toBe(42);
  });
});

// ─── Issue #450: Parameterized agent task dispatch matrix ────────────────────
//
// Covers all 14 registered TaskType values in the PayFiAgent.run() dispatch
// switch. Each row verifies that:
//   1. The correct tool method is invoked (via the existing vi.mock stubs).
//   2. result.taskType echoes back the dispatched type.
//   3. result.success is true when the tool stub resolves.
//
// Tool mocks for the 7 task types not exercised by earlier test suites
// (LiquidityPoolTool, StellarTomlTool, DataEntryTool, SequenceNumberTool,
//  SponsoredAccountTool, AnchorQuoteTool, InflationTool) are declared in the
// vi.mock() section at the top of this file.

type DispatchRow = [taskType: TaskType, payload: Record<string, unknown>, description: string];

/**
 * Minimal valid payloads for each TaskType.
 *
 * Payloads are kept as small as possible — they only need to satisfy the
 * tool mock's input path (which ignores them entirely) and any spending-limit
 * guard that inspects payload.amount.  Amounts are set to "1" to stay below
 * MAINNET_SPENDING_CAP (10 000) configured in the mock above.
 */
const DISPATCH_MATRIX: DispatchRow[] = [
  [
    'stellar_payment',
    { destination: DEST, amount: '1', assetCode: 'XLM' },
    'routes stellar_payment to StellarPaymentTool',
  ],
  [
    'soroban_invoke',
    { contractId: 'C'.repeat(56), method: 'ping', args: [] },
    'routes soroban_invoke to SorobanInvokeTool',
  ],
  [
    'soroban_query',
    { contractId: 'C'.repeat(56), method: 'get_state', args: [] },
    'routes soroban_query to SorobanQueryTool',
  ],
  [
    'x402_respond',
    {
      resource: 'https://api.example.com/resource',
      amount: '1',
      assetCode: 'USDC',
      assetIssuer: ISSUER,
      payTo: DEST,
      nonce: '550e8400-e29b-41d4-a716-446655440000',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    },
    'routes x402_respond to X402PaymentTool',
  ],
  ['account_info', {}, 'routes account_info to AccountInfoTool'],
  [
    'change_trust',
    { assetCode: 'USDC', assetIssuer: ISSUER, action: 'add' },
    'routes change_trust to TrustlineTool',
  ],
  [
    'multisig_payment',
    {
      destination: DEST,
      amount: '1',
      assetCode: 'XLM',
      additionalSigners: [DEST],
      minSignatures: 2,
    },
    'routes multisig_payment to MultiSigPaymentTool',
  ],
  [
    'batch_payment',
    { payments: [{ destination: DEST, amount: '1', assetCode: 'XLM' }] },
    'routes batch_payment to BatchPaymentTool',
  ],
  ['balance_check', { publicKey: DEST }, 'routes balance_check to BalanceCheckTool'],
  [
    'path_payment',
    {
      destination: DEST,
      sendAsset: { code: 'XLM' },
      sendAmount: '1',
      destAsset: { code: 'USDC', issuer: ISSUER },
      destMinAmount: '0.9',
    },
    'routes path_payment to PathPaymentTool',
  ],
  ['fee_bump', { innerTxXdr: 'AAAA' }, 'routes fee_bump to FeeBumpTool'],
  [
    'dex_offer',
    {
      action: 'create',
      selling: { code: 'XLM' },
      buying: { code: 'USDC', issuer: ISSUER },
      amount: '1',
      price: '0.25',
    },
    'routes dex_offer to DexOfferTool',
  ],
  [
    'liquidity_pool',
    {
      action: 'deposit',
      assetA: { code: 'XLM' },
      assetB: { code: 'USDC', issuer: ISSUER },
      maxAmountA: '100',
      maxAmountB: '100',
      minPrice: '0.1',
      maxPrice: '10',
    },
    'routes liquidity_pool to LiquidityPoolTool',
  ],
  ['inflation', { action: 'set', inflationDestination: DEST }, 'routes inflation to InflationTool'],
];

describe('PayFiAgent — task dispatch matrix (#450)', () => {
  let agent: PayFiAgent;

  beforeEach(() => {
    spendingTracker.clear();
    vi.clearAllMocks();

    // Re-apply default mock implementations after vi.clearAllMocks() resets them.
    vi.mocked(StellarPaymentTool).mockImplementation(
      () => ({ execute: vi.fn().mockResolvedValue({ txHash: 'dispatch_hash', ledger: 1 }) }) as any
    );
    vi.mocked(BalanceCheckTool).mockImplementation(
      () => ({ getBalance: vi.fn().mockResolvedValue({ publicKey: DEST, balances: [] }) }) as any
    );
    vi.mocked(PathPaymentTool).mockImplementation(
      () =>
        ({ execute: vi.fn().mockResolvedValue({ txHash: 'path_dispatch_hash', ledger: 1 }) }) as any
    );
    vi.mocked(FeeBumpTool).mockImplementation(
      () =>
        ({
          execute: vi.fn().mockResolvedValue({ txHash: 'fee_bump_dispatch_hash', ledger: 1 }),
        }) as any
    );
    vi.mocked(DexOfferTool).mockImplementation(
      () =>
        ({
          execute: vi
            .fn()
            .mockResolvedValue({ txHash: 'dex_dispatch_hash', ledger: 1, offerId: '0' }),
        }) as any
    );
    vi.mocked(LiquidityPoolTool).mockImplementation(
      () => ({ execute: vi.fn().mockResolvedValue({ poolId: 'pool_dispatch_id' }) }) as any
    );
    vi.mocked(StellarTomlTool).mockImplementation(
      () => ({ fetchToml: vi.fn().mockResolvedValue({ VERSION: '2.0.0' }) }) as any
    );
    vi.mocked(DataEntryTool).mockImplementation(
      () =>
        ({
          execute: vi.fn().mockResolvedValue({ txHash: 'data_entry_dispatch_hash', ledger: 1 }),
        }) as any
    );
    vi.mocked(SequenceNumberTool).mockImplementation(
      () => ({ execute: vi.fn().mockResolvedValue({ sequence: '12345678' }) }) as any
    );
    vi.mocked(SponsoredAccountTool).mockImplementation(
      () =>
        ({
          execute: vi.fn().mockResolvedValue({ txHash: 'sponsored_dispatch_hash', ledger: 1 }),
        }) as any
    );
    vi.mocked(AnchorQuoteTool).mockImplementation(
      () =>
        ({
          execute: vi.fn().mockResolvedValue({ quoteId: 'quote_dispatch_id', price: '1.0' }),
        }) as any
    );
    vi.mocked(InflationTool).mockImplementation(
      () =>
        ({
          execute: vi.fn().mockResolvedValue({ txHash: 'inflation_dispatch_hash', ledger: 1 }),
        }) as any
    );

    // The remaining 7 dispatch types (soroban_invoke, soroban_query, x402_respond,
    // account_info, change_trust, multisig_payment, batch_payment) are declared
    // in the top-level vi.mock() factories, but — unlike the tools mocked above —
    // their classes were never also `import`ed by name into this file. Without a
    // live binding to hang a `vi.mocked(...).mockImplementation(...)` call on,
    // `new SorobanInvokeTool(...)` (etc.) inside agent.ts's constructor resolved
    // to the bare mock spy misbehaving as a constructor instead of the factory's
    // `{ execute: vi.fn() }` object, so `this.sorobanTool.execute` (etc.) was
    // undefined at call time. Importing the classes here (see imports above) and
    // giving each an explicit resolved value fixes both problems at once.
    vi.mocked(SorobanInvokeTool).mockImplementation(
      () =>
        ({
          execute: vi.fn().mockResolvedValue({ status: 'SUCCESS', ledger: 1 }),
        }) as any
    );
    vi.mocked(SorobanQueryTool).mockImplementation(
      () =>
        ({
          query: vi.fn().mockResolvedValue({ result: 'dispatch_state_value' }),
        }) as any
    );
    vi.mocked(X402PaymentTool).mockImplementation(
      () =>
        ({
          respond: vi.fn().mockResolvedValue({ txHash: 'x402_dispatch_hash', ledger: 1 }),
        }) as any
    );
    vi.mocked(AccountInfoTool).mockImplementation(
      () =>
        ({
          fetch: vi.fn().mockResolvedValue({ publicKey: DEST, balances: [] }),
        }) as any
    );
    vi.mocked(TrustlineTool).mockImplementation(
      () =>
        ({
          execute: vi.fn().mockResolvedValue({ txHash: 'trustline_dispatch_hash', ledger: 1 }),
        }) as any
    );
    vi.mocked(MultiSigPaymentTool).mockImplementation(
      () =>
        ({
          execute: vi.fn().mockResolvedValue({ txHash: 'multisig_dispatch_hash', ledger: 1 }),
        }) as any
    );
    vi.mocked(BatchPaymentTool).mockImplementation(
      () =>
        ({
          execute: vi
            .fn()
            .mockResolvedValue({ results: [{ txHash: 'batch_dispatch_hash', ledger: 1 }] }),
        }) as any
    );

    agent = new PayFiAgent();
  });

  // Verify we are testing exactly 14 registered TaskType values.
  it('dispatch matrix covers exactly 14 TaskType entries', () => {
    expect(DISPATCH_MATRIX).toHaveLength(14);
    const taskTypes = DISPATCH_MATRIX.map(([type]) => type);
    // All entries must be unique — no accidental duplicates.
    expect(new Set(taskTypes).size).toBe(14);
  });

  test.each(DISPATCH_MATRIX)(
    "dispatches %s → result.taskType === '%s' and result.success === true",
    async (taskType, payload) => {
      const result = await agent.run({ type: taskType, payload });

      // The dispatched type must be reflected back in the result without mutation.
      expect(result.taskType).toBe(taskType);

      // The agent must report success when the underlying tool stub resolves.
      expect(result.success).toBe(true);
    }
  );
});

describe('PayFiAgent — unknown task type rejection (#450)', () => {
  let agent: PayFiAgent;

  beforeEach(() => {
    spendingTracker.clear();
    vi.clearAllMocks();
    vi.mocked(StellarPaymentTool).mockImplementation(
      () => ({ execute: vi.fn().mockResolvedValue({ txHash: 'mock_hash', ledger: 1 }) }) as any
    );
    agent = new PayFiAgent();
  });

  it("returns a failed AgentResult containing 'Unknown task type:' for an unregistered type", async () => {
    // Cast through `any` to bypass TypeScript's exhaustive type checking —
    // the runtime guard must catch values that slip past the type system.
    const result = await agent.run({
      type: 'totally_unknown_task_type' as any,
      payload: {},
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Unknown task type:/i);
    // The unrecognised type string must appear in the error message so
    // operators can diagnose dispatch misrouting without reading source code.
    expect(result.error).toContain('totally_unknown_task_type');
  });

  it('does not throw synchronously — always returns an AgentResult', async () => {
    // run() must never reject its Promise; the error must be captured in the result.
    await expect(agent.run({ type: 'another_unknown' as any, payload: {} })).resolves.toMatchObject(
      { success: false }
    );
  });
});
