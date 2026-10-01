/**
 * tests/tx_idempotency.test.ts
 *
 * Coverage for backend/tx_idempotency.ts's double-spend guarantees (#484):
 *
 *   - An ambiguous submission failure (client-side timeout, breaker trip
 *     mid-flight) that actually landed on-chain is detected via a status
 *     check and never resubmitted.
 *   - Two concurrent calls racing the same idempotency key cannot both
 *     broadcast — Horizon sees exactly one submission either way.
 *   - Two different payments racing the same source account get distinct,
 *     non-colliding sequence numbers (withAccountLock).
 *   - A `pending` row left behind by a prior process (crash, or an earlier
 *     ambiguous failure) is resolved by checking its recorded hash rather
 *     than being rebuilt blindly — this is what "restart mid-window" safety
 *     means for a value-moving tool.
 *   - Multiple distinct (possibly multi-asset) payments are tracked
 *     independently under their own idempotency keys.
 *   - resubmitStuckTransaction fee-bumps a genuinely-stuck transaction, and
 *     does *not* fee-bump one that actually landed.
 *
 * Unlike tests/payment.test.ts (which mocks the whole `rpc_client` module),
 * this suite uses the *real* rpc_client.ts — including the real
 * `submitTransactionBreaker` and the real `withAccountLock` mutex — and only
 * spies on the underlying Horizon SDK calls. That's deliberate: the
 * properties under test (the breaker actually being in the submit path, the
 * lock actually serializing same-account submissions) only mean something if
 * the real wiring is exercised.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  Keypair,
  Account,
  TransactionBuilder,
  Operation,
  Asset,
  BASE_FEE,
  Networks,
  NotFoundError,
  type FeeBumpTransaction,
  type Transaction,
} from '@stellar/stellar-sdk';

// vi.mock factories are hoisted above all imports/top-level consts, so the
// secret is a literal here rather than a reference to the AGENT_SECRET
// constant declared below.
vi.mock('../backend/config', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { Keypair: KP } = require('@stellar/stellar-sdk');
  const secret = 'SADQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQP54X';
  return {
    config: {
      STELLAR_NETWORK: 'testnet',
      HORIZON_URL: 'https://horizon-testnet.stellar.org',
      SOROBAN_RPC_URL: 'https://soroban-testnet.stellar.org',
      AGENT_PUBLIC_KEY: KP.fromSecret(secret).publicKey(),
      agentKeypair: () => KP.fromSecret(secret),
      X402_ASSET_CODE: 'USDC',
      X402_ASSET_ISSUER: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
      // A single attempt per call — internal retry is not what's under test
      // here, and letting it run would mask how many times Horizon itself
      // was actually hit.
      MAX_RETRIES: 1,
      RETRY_DELAY_MS: 1,
      RPC_TIMEOUT_MS: 5_000,
      ACCOUNT_CACHE_TTL_MS: 0,
      MAX_X402_PAYMENTS_PER_MINUTE: 10,
      MAX_SOROBAN_FEE_STROOPS: 1_000_000,
      DB_PATH: ':memory:',
    },
  };
});

import {
  horizonServer,
  invalidateAccountCache,
  submitTransactionBreaker,
  resetBreakerStats,
} from '../backend/rpc_client';
import {
  submitIdempotent,
  resubmitStuckTransaction,
  TxSubmissionInFlightError,
} from '../backend/tx_idempotency';
import {
  _setDb,
  getTxSubmission,
  beginTxSubmission,
  attachTxSubmissionHash,
} from '../backend/persistence';

const AGENT_SECRET = 'SADQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQP54X';
const AGENT_KEYPAIR = Keypair.fromSecret(AGENT_SECRET);
const AGENT_PUBLIC_KEY = AGENT_KEYPAIR.publicKey();
const DEST = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
const USDC_ISSUER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';

function buildPayment(
  account: ConstructorParameters<typeof Account>[0] extends never ? never : Account,
  amount = '10',
  assetCode = 'XLM',
  assetIssuer?: string
): Transaction {
  const asset = assetCode === 'XLM' ? Asset.native() : new Asset(assetCode, assetIssuer);
  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(Operation.payment({ destination: DEST, asset, amount }))
    .setTimeout(30)
    .build();
  tx.sign(AGENT_KEYPAIR);
  return tx;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let loadAccountSpy: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let submitSpy: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let transactionsSpy: any;

/**
 * Point `horizonServer.transactions().transaction(hash).call()` at a fixed
 * outcome. `ledger_attr` matches the real Horizon SDK response shape — the
 * `ledger` field on this record is a lazy-loading link function, not the
 * sequence number itself (see rpc_client.ts's `getTransactionStatus`).
 */
function mockTransactionStatus(outcome: { successful: boolean; ledger_attr?: number } | Error) {
  transactionsSpy = vi.spyOn(horizonServer, 'transactions').mockReturnValue({
    transaction: () => ({
      call: () =>
        outcome instanceof Error
          ? Promise.reject(outcome)
          : Promise.resolve(outcome as unknown as Record<string, unknown>),
    }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
}

beforeEach(() => {
  _setDb(new Database(':memory:'));
  invalidateAccountCache();
  // The breaker is a real, module-level singleton — reset its rolling
  // failure window so one test's failures can't trip it open for the next.
  resetBreakerStats(submitTransactionBreaker as unknown as Parameters<typeof resetBreakerStats>[0]);
  submitTransactionBreaker.close();

  loadAccountSpy = vi
    .spyOn(horizonServer, 'loadAccount')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .mockImplementation((async () => new Account(AGENT_PUBLIC_KEY, '100')) as any);
  submitSpy = vi.spyOn(horizonServer, 'submitTransaction');
  mockTransactionStatus(new NotFoundError('not found', {}));
});

afterEach(() => {
  loadAccountSpy.mockRestore();
  submitSpy.mockRestore();
  transactionsSpy?.mockRestore();
});

// ─── RPC timeout after successful ledger inclusion ─────────────────────────

describe('submitIdempotent — RPC timeout after successful ledger inclusion', () => {
  it('does not resubmit when the client sees an ambiguous failure but the transaction already landed', async () => {
    submitSpy.mockRejectedValue(
      Object.assign(new Error('ECONNABORTED: network timeout after 30000ms'), {
        code: 'ECONNABORTED',
      })
    );
    mockTransactionStatus({ successful: true, ledger_attr: 777 });

    const result = await submitIdempotent({
      idempotencyKey: 'pay-timeout-1',
      sourceAccountId: AGENT_PUBLIC_KEY,
      buildAndSign: (account) => buildPayment(account),
    });

    expect(result.ledger).toBe(777);
    // The crux of the guarantee: Horizon was only ever asked to broadcast once.
    expect(submitSpy).toHaveBeenCalledTimes(1);
    expect(getTxSubmission('pay-timeout-1')?.status).toBe('success');
  });

  it('propagates the original error when the status check also cannot resolve it (genuinely unknown)', async () => {
    submitSpy.mockRejectedValue(
      Object.assign(new Error('ECONNABORTED: network timeout'), { code: 'ECONNABORTED' })
    );
    mockTransactionStatus(new NotFoundError('not found', {}));

    await expect(
      submitIdempotent({
        idempotencyKey: 'pay-timeout-2',
        sourceAccountId: AGENT_PUBLIC_KEY,
        buildAndSign: (account) => buildPayment(account),
      })
    ).rejects.toThrow(/timeout/i);

    expect(submitSpy).toHaveBeenCalledTimes(1);
    expect(getTxSubmission('pay-timeout-2')?.status).toBe('failed');
  });
});

// ─── Concurrent calls, same idempotency key ────────────────────────────────

describe('submitIdempotent — concurrent calls with the same idempotency key', () => {
  it('lets exactly one of two simultaneous calls submit; Horizon sees one broadcast, not two', async () => {
    submitSpy.mockResolvedValue({ hash: 'concurrent_hash', ledger: 10 } as never);

    const call = () =>
      submitIdempotent({
        idempotencyKey: 'pay-concurrent-1',
        sourceAccountId: AGENT_PUBLIC_KEY,
        buildAndSign: (account) => buildPayment(account),
      });

    const results = await Promise.allSettled([call(), call()]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(TxSubmissionInFlightError);

    // Not two — this is the actual double-spend-prevention assertion.
    expect(submitSpy).toHaveBeenCalledTimes(1);
  });
});

// ─── Sequence-number safety under concurrency ──────────────────────────────

describe('submitIdempotent — sequence-number safety under concurrency (withAccountLock)', () => {
  it('serializes two different payments from the same source account onto distinct sequence numbers', async () => {
    let seq = 100;
    loadAccountSpy.mockImplementation(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (async () => new Account(AGENT_PUBLIC_KEY, String(seq))) as any
    );
    submitSpy.mockImplementation((async (tx: Transaction) => {
      // Simulate Horizon applying the transaction and advancing the account.
      seq += 1;
      return { hash: tx.hash().toString('hex'), ledger: 1 };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any);

    const sequencesUsed: string[] = [];
    const call = (key: string, amount: string) =>
      submitIdempotent({
        idempotencyKey: key,
        sourceAccountId: AGENT_PUBLIC_KEY,
        buildAndSign: (account) => {
          const tx = buildPayment(account, amount);
          sequencesUsed.push(tx.sequence);
          return tx;
        },
      });

    await Promise.all([call('pay-seq-a', '1'), call('pay-seq-b', '2')]);

    // Without the lock, both builders would race `loadAccount` and could both
    // read seq=100, producing the same sequence for both transactions.
    expect(sequencesUsed).toHaveLength(2);
    expect(sequencesUsed[0]).not.toBe(sequencesUsed[1]);
    expect(submitSpy).toHaveBeenCalledTimes(2);
  });
});

// ─── Restart mid-window: a pending row left by a prior process ─────────────

describe('submitIdempotent — resuming a pending row left by a prior process (restart safety)', () => {
  it('resolves via chain status instead of rebuilding when the recorded hash already landed', async () => {
    const priorHash = 'ab'.repeat(32);
    beginTxSubmission('pay-restart-1', AGENT_PUBLIC_KEY, Date.now());
    attachTxSubmissionHash('pay-restart-1', priorHash, 'AAAAAA==', Date.now());
    mockTransactionStatus({ successful: true, ledger_attr: 999 });

    const result = await submitIdempotent({
      idempotencyKey: 'pay-restart-1',
      sourceAccountId: AGENT_PUBLIC_KEY,
      buildAndSign: (account) => buildPayment(account),
    });

    expect(result).toEqual({ txHash: priorHash, ledger: 999 });
    expect(submitSpy).not.toHaveBeenCalled();
    expect(getTxSubmission('pay-restart-1')?.status).toBe('success');
  });

  it('rebuilds and submits fresh when the recorded hash is confirmed failed on-chain', async () => {
    const priorHash = 'cd'.repeat(32);
    beginTxSubmission('pay-restart-2', AGENT_PUBLIC_KEY, Date.now());
    attachTxSubmissionHash('pay-restart-2', priorHash, 'AAAAAA==', Date.now());
    mockTransactionStatus({ successful: false, ledger_attr: 999 });
    submitSpy.mockResolvedValue({ hash: 'fresh_hash', ledger: 1001 } as never);

    const result = await submitIdempotent({
      idempotencyKey: 'pay-restart-2',
      sourceAccountId: AGENT_PUBLIC_KEY,
      buildAndSign: (account) => buildPayment(account),
    });

    expect(result.txHash).toBe('fresh_hash');
    expect(submitSpy).toHaveBeenCalledTimes(1);
  });
});

// ─── Multi-asset payments ───────────────────────────────────────────────────

describe('submitIdempotent — multi-asset payments', () => {
  it('tracks an XLM payment and a USDC payment under separate idempotency keys independently', async () => {
    submitSpy
      .mockResolvedValueOnce({ hash: 'xlm_hash', ledger: 1 } as never)
      .mockResolvedValueOnce({ hash: 'usdc_hash', ledger: 2 } as never);

    const xlmResult = await submitIdempotent({
      idempotencyKey: 'pay-xlm-1',
      sourceAccountId: AGENT_PUBLIC_KEY,
      buildAndSign: (account) => buildPayment(account, '5', 'XLM'),
    });
    const usdcResult = await submitIdempotent({
      idempotencyKey: 'pay-usdc-1',
      sourceAccountId: AGENT_PUBLIC_KEY,
      buildAndSign: (account) => buildPayment(account, '5', 'USDC', USDC_ISSUER),
    });

    expect(xlmResult.txHash).toBe('xlm_hash');
    expect(usdcResult.txHash).toBe('usdc_hash');
    expect(getTxSubmission('pay-xlm-1')?.status).toBe('success');
    expect(getTxSubmission('pay-usdc-1')?.status).toBe('success');
    expect(submitSpy).toHaveBeenCalledTimes(2);
  });

  it('a timeout-then-landed USDC payment is deduplicated exactly like an XLM one', async () => {
    submitSpy.mockRejectedValue(
      Object.assign(new Error('ECONNABORTED: timeout'), { code: 'ECONNABORTED' })
    );
    mockTransactionStatus({ successful: true, ledger_attr: 321 });

    const result = await submitIdempotent({
      idempotencyKey: 'pay-usdc-timeout-1',
      sourceAccountId: AGENT_PUBLIC_KEY,
      buildAndSign: (account) => buildPayment(account, '5', 'USDC', USDC_ISSUER),
    });

    expect(result.ledger).toBe(321);
    expect(submitSpy).toHaveBeenCalledTimes(1);
  });
});

// ─── Fee-bump for stuck transactions ────────────────────────────────────────

describe('resubmitStuckTransaction — fee-bump support for stuck transactions', () => {
  it('fee-bumps and resubmits the same inner transaction when it is genuinely stuck (not found on-chain)', async () => {
    const account = new Account(AGENT_PUBLIC_KEY, '100');
    const innerTx = buildPayment(account, '5');
    const innerHash = innerTx.hash().toString('hex');
    const innerXdr = innerTx.toEnvelope().toXDR('base64');

    beginTxSubmission('pay-stuck-1', AGENT_PUBLIC_KEY, Date.now());
    attachTxSubmissionHash('pay-stuck-1', innerHash, innerXdr, Date.now());

    mockTransactionStatus(new NotFoundError('not found', {}));
    submitSpy.mockResolvedValue({ hash: 'feebump_hash', ledger: 42 } as never);

    const result = await resubmitStuckTransaction('pay-stuck-1');

    expect(result.txHash).toBe('feebump_hash');
    expect(submitSpy).toHaveBeenCalledTimes(1);

    // Must be a fee-bump of the *same* inner transaction — no new sequence
    // number consumed, so it can't itself create a second logical payment.
    const submittedTx = submitSpy.mock.calls[0]![0] as FeeBumpTransaction;
    expect(submittedTx.innerTransaction.sequence).toBe(innerTx.sequence);
    expect(Number(submittedTx.fee)).toBeGreaterThan(Number(innerTx.fee));

    expect(getTxSubmission('pay-stuck-1')?.status).toBe('success');
  });

  it('does not fee-bump when the original transaction is confirmed to have actually landed', async () => {
    const account = new Account(AGENT_PUBLIC_KEY, '100');
    const innerTx = buildPayment(account, '5');
    const innerHash = innerTx.hash().toString('hex');

    beginTxSubmission('pay-stuck-2', AGENT_PUBLIC_KEY, Date.now());
    attachTxSubmissionHash(
      'pay-stuck-2',
      innerHash,
      innerTx.toEnvelope().toXDR('base64'),
      Date.now()
    );
    mockTransactionStatus({ successful: true, ledger_attr: 55 });

    const result = await resubmitStuckTransaction('pay-stuck-2');

    expect(result).toEqual({ txHash: innerHash, ledger: 55 });
    expect(submitSpy).not.toHaveBeenCalled();
  });

  it('throws and records failure when the original transaction is confirmed failed (not just missing)', async () => {
    const account = new Account(AGENT_PUBLIC_KEY, '100');
    const innerTx = buildPayment(account, '5');
    const innerHash = innerTx.hash().toString('hex');

    beginTxSubmission('pay-stuck-3', AGENT_PUBLIC_KEY, Date.now());
    attachTxSubmissionHash(
      'pay-stuck-3',
      innerHash,
      innerTx.toEnvelope().toXDR('base64'),
      Date.now()
    );
    mockTransactionStatus({ successful: false, ledger_attr: 55 });

    await expect(resubmitStuckTransaction('pay-stuck-3')).rejects.toThrow(/failed on-chain/);
    expect(submitSpy).not.toHaveBeenCalled();
    expect(getTxSubmission('pay-stuck-3')?.status).toBe('failed');
  });
});
