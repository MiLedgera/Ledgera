/**
 * tests/batch_payment.test.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ZodError } from 'zod';
import { BatchPaymentTool } from '../backend/tools/BatchPaymentTool';
import * as rpcClient from '../backend/rpc_client';
import { config } from '../backend/config';

vi.mock('../backend/rpc_client', () => ({
  loadAccount: vi.fn(),
  submitTransaction: vi.fn(),
  horizonServer: {},
  sorobanServer: {},
  simulateSorobanTx: vi.fn(),
  prepareSorobanTx: vi.fn(),
  resolveNetworkPassphrase: (network: string) =>
    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
    require('@stellar/stellar-sdk').Networks[
      network === 'mainnet' ? 'PUBLIC' : network === 'futurenet' ? 'FUTURENET' : 'TESTNET'
    ],
}));

vi.mock('../backend/config', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
  const { Keypair } = require('@stellar/stellar-sdk');
  const secret = 'SADQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQP54X';
  return {
    config: {
      STELLAR_NETWORK: 'testnet',
      HORIZON_URL: 'https://horizon-testnet.stellar.org',
      SOROBAN_RPC_URL: 'https://soroban-testnet.stellar.org',
      X402_ASSET_CODE: 'USDC',
      X402_ASSET_ISSUER: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
      AGENT_SPENDING_LIMIT: '1000',
      AGENT_PUBLIC_KEY: Keypair.fromSecret(secret).publicKey(),
      agentKeypair: () => Keypair.fromSecret(secret),
    },
  };
});

vi.mock('../backend/persistence', () => ({ saveResult: vi.fn() }));

const DEST1 = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
const DEST2 = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';
const DEST3 = 'GDRIFTCEWUMA5IM6NUQPLA27YPHDMUNMPDXCQWCD3BRPVKMPX5KEM5F5';

function makeMockAccount(publicKey: string) {
  return {
    id: publicKey,
    accountId: () => publicKey,
    sequenceNumber: () => '100',
    incrementSequenceNumber: vi.fn(),
    sequence: '100',
    incrementedSequenceNumber: () => '101',
    thresholds: { low_threshold: 0, med_threshold: 0, high_threshold: 0 },
    flags: { auth_required: false, auth_revocable: false, auth_immutable: false },
    balances: [{ asset_type: 'native', balance: '10000.0000000' }],
    signers: [],
    data_attr: {},
    subentry_count: 0,
    home_domain: '',
    inflation_dest: null,
  };
}

describe('BatchPaymentTool', () => {
  let tool: BatchPaymentTool;

  beforeEach(() => {
    vi.clearAllMocks();
    tool = new BatchPaymentTool();
    vi.mocked(rpcClient.loadAccount).mockResolvedValue(
      makeMockAccount('GDRIFTCEWUMA5IM6NUQPLA27YPHDMUNMPDXCQWCD3BRPVKMPX5KEM5F5') as any
    );
    vi.mocked(rpcClient.submitTransaction).mockResolvedValue({
      hash: 'batch_tx_hash',
      ledger: 55,
    } as any);
  });

  it('executes a 3-payment batch and returns txHash + ledger', async () => {
    const result = await tool.execute({
      payments: [
        { destination: DEST1, amount: '10', assetCode: 'XLM' },
        { destination: DEST2, amount: '20', assetCode: 'XLM' },
        { destination: DEST3, amount: '30', assetCode: 'XLM' },
      ],
    });

    expect(result.txHash).toBe('batch_tx_hash');
    expect(result.ledger).toBe(55);
    expect(rpcClient.submitTransaction).toHaveBeenCalledOnce();
  });

  // Audit finding Q-5: StellarPaymentTool guards against paying the agent's
  // own address; BatchPaymentTool previously had no equivalent per-payment check.
  it('rejects a batch payment whose destination is the agent\'s own address (Q-5)', async () => {
    const { Keypair } = await import('@stellar/stellar-sdk');
    const ownPublicKey = Keypair.fromSecret(
      'SADQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQP54X'
    ).publicKey();

    await expect(
      tool.execute({
        payments: [
          { destination: DEST1, amount: '10', assetCode: 'XLM' },
          { destination: ownPublicKey, amount: '10', assetCode: 'XLM' },
        ],
      })
    ).rejects.toThrow(/own address/);
    expect(rpcClient.submitTransaction).not.toHaveBeenCalled();
  });

  it('rejects a batch with more than 100 payments', async () => {
    const payments = Array.from({ length: 101 }, (_, i) => ({
      destination: DEST1,
      amount: '1',
      assetCode: 'XLM',
    }));

    await expect(tool.execute({ payments })).rejects.toThrow();
  });

  it('rejects when the aggregate total exceeds AGENT_SPENDING_LIMIT', async () => {
    // AGENT_SPENDING_LIMIT is 1000; 3 × 400 = 1200
    await expect(
      tool.execute({
        payments: [
          { destination: DEST1, amount: '400', assetCode: 'XLM' },
          { destination: DEST2, amount: '400', assetCode: 'XLM' },
          { destination: DEST3, amount: '400', assetCode: 'XLM' },
        ],
      })
    ).rejects.toThrow(/AGENT_SPENDING_LIMIT/);
  });

  it('rejects a batch where total exceeds AGENT_SPENDING_LIMIT', async () => {
    // AGENT_SPENDING_LIMIT is 1000; 2 × 600 = 1200 > 1000
    const payments = [
      { destination: DEST1, amount: '600', assetCode: 'XLM' },
      { destination: DEST2, amount: '600', assetCode: 'XLM' },
    ];
    await expect(tool.execute({ payments })).rejects.toThrow(/exceeds AGENT_SPENDING_LIMIT/);
  });

  it('accepts a batch where the total exactly equals the spending limit', async () => {
    // 100 × 10 = 1000, which equals the limit
    const payments = Array.from({ length: 100 }, () => ({
      destination: DEST1,
      amount: '10',
      assetCode: 'XLM',
    }));

    const result = await tool.execute({ payments });
    expect(result.txHash).toBe('batch_tx_hash');
  });

  it('rejects an empty payments array', async () => {
    await expect(tool.execute({ payments: [] })).rejects.toThrow();
  });

  it('rejects a non-XLM payment missing assetIssuer', async () => {
    await expect(
      tool.execute({
        payments: [{ destination: DEST1, amount: '10', assetCode: 'USDC' }],
      })
    ).rejects.toThrow(/Asset issuer is required/);
  });

  describe('failFast', () => {
    const BAD = { destination: DEST2, amount: '10', assetCode: 'USDC' };
    const GOOD1 = { destination: DEST1, amount: '10', assetCode: 'XLM' };
    const GOOD2 = { destination: DEST3, amount: '10', assetCode: 'XLM' };

    it('defaults to false and reports every unusable payment at once', async () => {
      await expect(
        tool.execute({
          payments: [GOOD1, BAD, { ...BAD, assetCode: 'EURC' }],
        })
      ).rejects.toThrow(/USDC[\s\S]*EURC/);
    });

    it('reports nothing skipped when it checked the whole batch', async () => {
      await tool.execute({ payments: [GOOD1, BAD, GOOD2] }).catch((err: any) => {
        expect(err.skipped).toBe(0);
      });
      expect.assertions(1);
    });

    it('stops at the first unusable payment when failFast is set', async () => {
      await expect(
        tool.execute({
          payments: [GOOD1, BAD, { ...BAD, assetCode: 'EURC' }],
          failFast: true,
        })
      ).rejects.toThrow(/payment 1[\s\S]*USDC/);
    });

    it('counts the payments behind the failure as skipped', async () => {
      await tool
        .execute({ payments: [GOOD1, BAD, GOOD2, GOOD2], failFast: true })
        .catch((err: any) => {
          // index 1 failed, so indexes 2 and 3 were never looked at
          expect(err.skipped).toBe(2);
        });
      expect.assertions(1);
    });

    it('does not reach the network when a batch fails pre-flight', async () => {
      await expect(tool.execute({ payments: [BAD], failFast: true })).rejects.toThrow();

      expect(rpcClient.loadAccount).not.toHaveBeenCalled();
      expect(rpcClient.submitTransaction).not.toHaveBeenCalled();
    });

    it('submits normally with failFast set when every payment is usable', async () => {
      const result = await tool.execute({
        payments: [GOOD1, GOOD2],
        failFast: true,
      });

      expect(result.txHash).toBe('batch_tx_hash');
      expect(result.skipped).toBe(0);
      expect(rpcClient.submitTransaction).toHaveBeenCalledOnce();
    });

    it('reports skipped as 0 on a successful batch', async () => {
      const result = await tool.execute({ payments: [GOOD1, GOOD2] });
      expect(result.skipped).toBe(0);
    });
  });

  // #451 — boundary tests for the 100-payment ceiling and the aggregate
  // spending limit, plus a basic throughput check.
  describe('100-payment boundary and aggregate spend limit', () => {
    it('accepts exactly 100 payments and completes well under a second', async () => {
      const payments = Array.from({ length: 100 }, () => ({
        destination: DEST1,
        amount: '0.01',
        assetCode: 'XLM',
      }));

      const start = Date.now();
      const result = await tool.execute({ payments });
      const elapsedMs = Date.now() - start;

      expect(result.txHash).toBe('batch_tx_hash');
      expect(rpcClient.submitTransaction).toHaveBeenCalledOnce();
      // Fully mocked network calls — this is a smoke check that the 100-item
      // pre-flight loop has no accidental O(n^2) or leak-shaped slowdown.
      expect(elapsedMs).toBeLessThan(1000);
    });

    it('rejects 101 payments before ever touching the network', async () => {
      const payments = Array.from({ length: 101 }, () => ({
        destination: DEST1,
        amount: '0.01',
        assetCode: 'XLM',
      }));

      // Enforced by BatchPaymentInputSchema's `.max(100)` via Zod's own
      // .parse(), so the tool throws the raw ZodError rather than wrapping it
      // in the project's ValidationError — asserting the real thrown type.
      await expect(tool.execute({ payments })).rejects.toThrow(ZodError);
      expect(rpcClient.loadAccount).not.toHaveBeenCalled();
      expect(rpcClient.submitTransaction).not.toHaveBeenCalled();
    });

    it('rejects 100 payments of 0.11 XLM against a tightened AGENT_SPENDING_LIMIT of 10', async () => {
      // 100 × 0.11 = 11, which exceeds a limit of 10. Mutates the shared
      // mocked config for this one test and restores it, since every other
      // test in this file relies on the default limit of 1000.
      const original = (config as { AGENT_SPENDING_LIMIT: string }).AGENT_SPENDING_LIMIT;
      (config as { AGENT_SPENDING_LIMIT: string }).AGENT_SPENDING_LIMIT = '10';
      try {
        const payments = Array.from({ length: 100 }, () => ({
          destination: DEST1,
          amount: '0.11',
          assetCode: 'XLM',
        }));

        await expect(tool.execute({ payments })).rejects.toThrow(/AGENT_SPENDING_LIMIT/);
        expect(rpcClient.submitTransaction).not.toHaveBeenCalled();
      } finally {
        (config as { AGENT_SPENDING_LIMIT: string }).AGENT_SPENDING_LIMIT = original;
      }
    });
  });
});
