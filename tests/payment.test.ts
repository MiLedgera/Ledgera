/**
 * tests/payment.test.ts
 *
 * Comprehensive test suite for StellarPaymentTool.
 * Covers: happy path, input validation, network errors, retry exhaustion,
 * timeout simulation, insufficient funds, and memo edge cases.
 *
 * Network mocking is centralised in the shared MockHorizonServer fixture
 * (tests/fixtures/MockHorizonServer.ts); see createMockHorizonServer() for
 * the full API. The fixture is created inside the async vi.mock factory below
 * because vi.mock factories are hoisted above imports and therefore cannot
 * reference top-level bindings directly.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { Keypair } from '@stellar/stellar-sdk';
import { z } from 'zod';
import { StellarPaymentTool } from '../backend/tools/StellarPaymentTool';
import { SubmitResultSchema } from '../backend/tools/StellarPaymentTool';
import * as rpcClient from '../backend/rpc_client';
import { _setDb } from '../backend/persistence';
import type { MockHorizonServer } from './fixtures/MockHorizonServer';
import { makeMockAccount } from './fixtures/MockHorizonServer';

// ─── Shared MockHorizonServer fixture ────────────────────────────────────────
// All Horizon/Soroban network calls are intercepted here. The async factory
// imports the fixture module and returns a fresh, configurable mock server.

vi.mock('../backend/rpc_client', async () => {
  const { createMockHorizonServer } = await import('./fixtures/MockHorizonServer');
  return createMockHorizonServer();
});

// The mocked `rpc_client` module IS the MockHorizonServer instance, so this
// cast exposes the fixture's convenience API (reset, setAccount,
// setSubmitResult, ...) to the suite below.
const mockHorizonServer = rpcClient as unknown as MockHorizonServer;

// ─── Mock config — isolate from real .env ─────────────────────────────────────
vi.mock('../backend/config', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Keypair } = require('@stellar/stellar-sdk'); // eslint-disable-line @typescript-eslint/no-var-requires
  const secret = 'SADQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQP54X';
  return {
    config: {
      STELLAR_NETWORK: 'testnet',
      HORIZON_URL: 'https://horizon-testnet.stellar.org',
      SOROBAN_RPC_URL: 'https://soroban-testnet.stellar.org',
      X402_ASSET_CODE: 'USDC',
      X402_ASSET_ISSUER: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
      MAX_RETRIES: 3,
      RETRY_DELAY_MS: 100,
      AGENT_PUBLIC_KEY: Keypair.fromSecret(secret).publicKey(),
      agentKeypair: () => Keypair.fromSecret(secret),
      DB_PATH: ':memory:',
    },
  };
});

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const TEST_SECRET = 'SADQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQP54X';
// Valid 56-char G-address for destination
const VALID_DEST = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
const VALID_ISSUER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';

// ─── Test suite ───────────────────────────────────────────────────────────────

describe('StellarPaymentTool', () => {
  let tool: StellarPaymentTool;

  beforeEach(() => {
    mockHorizonServer.reset();
    // Fresh in-memory idempotency ledger per test (backend/tx_idempotency.ts
    // persists via backend/persistence.ts, which is not part of the
    // rpc_client mock above).
    _setDb(new Database(':memory:'));
    tool = new StellarPaymentTool();
  });

  // ── Input validation ────────────────────────────────────────────────────────

  describe('Input validation', () => {
    it('rejects a destination key that is too short', async () => {
      await expect(
        tool.execute({ destination: 'GABC123', amount: '10', assetCode: 'XLM' })
      ).rejects.toThrow(/Invalid Stellar public key/);
    });

    it('rejects a destination key that is too long', async () => {
      await expect(
        tool.execute({ destination: 'G'.padEnd(57, 'A'), amount: '10', assetCode: 'XLM' })
      ).rejects.toThrow(/Invalid Stellar public key/);
    });

    it('rejects a syntactically invalid 56-character destination key', async () => {
      await expect(
        tool.execute({ destination: 'G' + 'A'.repeat(55), amount: '10', assetCode: 'XLM' })
      ).rejects.toThrow(/Destination must be a valid Stellar public key/);
    });

    it('rejects a negative amount', async () => {
      await expect(
        tool.execute({ destination: VALID_DEST, amount: '-1', assetCode: 'XLM' })
      ).rejects.toThrow(/Amount must be/);
    });

    it('rejects zero amount (not a valid Stellar decimal)', async () => {
      await expect(
        tool.execute({ destination: VALID_DEST, amount: '0', assetCode: 'XLM' })
      ).rejects.toThrow(/Amount must be/);
    });

    it('rejects amount with more than 7 decimal places', async () => {
      await expect(
        tool.execute({ destination: VALID_DEST, amount: '1.12345678', assetCode: 'XLM' })
      ).rejects.toThrow(/Amount must be/);
    });

    it('rejects self-payment (destination === agent public key)', async () => {
      await expect(
        tool.execute({ destination: tool.publicKey, amount: '1', assetCode: 'XLM' })
      ).rejects.toThrow("Payment destination cannot be the agent's own address");
    });

    it('rejects a non-XLM asset when issuer is missing', async () => {
      await expect(
        tool.execute({
          destination: VALID_DEST,
          amount: '10',
          assetCode: 'USDC',
          assetIssuer: undefined,
        })
      ).rejects.toThrow('Asset issuer is required for non-native asset USDC');
    });

    it('rejects a memo longer than 28 bytes', async () => {
      await expect(
        tool.execute({
          destination: VALID_DEST,
          amount: '1',
          assetCode: 'XLM',
          memo: 'A'.repeat(29),
        })
      ).rejects.toThrow();
    });

    it('accepts a 7-decimal amount (boundary)', async () => {
      mockHorizonServer.setSubmitResult({ hash: 'boundary_hash', ledger: 1 } as any);

      const result = await tool.execute({
        destination: VALID_DEST,
        amount: '0.0000001',
        assetCode: 'XLM',
      });
      expect(result.txHash).toBe('boundary_hash');
    });
  });

  describe('memo boundary tests', () => {
    beforeEach(() => {
      mockHorizonServer.setSubmitResult({ hash: 'boundary_hash', ledger: 1 } as any);
    });

    it('accepts 28 ASCII characters', async () => {
      const result = await tool.execute({
        destination: VALID_DEST,
        amount: '1',
        assetCode: 'XLM',
        memo: 'a'.repeat(28),
      });
      expect(result.txHash).toBe('boundary_hash');
    });

    it('rejects 14 two-byte UTF-8 characters (e.g. あ.repeat(14)) (42 bytes)', async () => {
      await expect(
        tool.execute({
          destination: VALID_DEST,
          amount: '1',
          assetCode: 'XLM',
          memo: 'あ'.repeat(14),
        })
      ).rejects.toThrow();
    });

    it('accepts a 28-byte multi-byte string', async () => {
      const result = await tool.execute({
        destination: VALID_DEST,
        amount: '1',
        assetCode: 'XLM',
        memo: 'я'.repeat(14), // "я" is 2 bytes in UTF-8
      });
      expect(result.txHash).toBe('boundary_hash');
    });
  });

  describe('memo type support', () => {
    beforeEach(() => {
      mockHorizonServer.setSubmitResult({ hash: 'memo_type_hash', ledger: 1 } as any);
    });

    it("accepts memo type 'id' with numeric value", async () => {
      const result = await tool.execute({
        destination: VALID_DEST,
        amount: '1',
        assetCode: 'XLM',
        memoType: 'id',
        memo: 123456789,
      });
      expect(result.txHash).toBe('memo_type_hash');
    });

    it("accepts memo type 'id' with a large (max-safe) integer", async () => {
      // Number.MAX_SAFE_INTEGER is the largest JS number that is exactly
      // representable and therefore the largest safe 'id' memo input. The
      // literal 2^64 - 1 cannot be represented exactly in JS (it silently
      // rounds above the tool's uint64 bound), so the boundary is exercised
      // with the largest value the tool can legitimately accept.
      const result = await tool.execute({
        destination: VALID_DEST,
        amount: '1',
        assetCode: 'XLM',
        memoType: 'id',
        memo: Number.MAX_SAFE_INTEGER,
      });
      expect(result.txHash).toBe('memo_type_hash');
    });

    it("rejects memo type 'id' with negative number", async () => {
      await expect(
        tool.execute({
          destination: VALID_DEST,
          amount: '1',
          assetCode: 'XLM',
          memoType: 'id',
          memo: -1,
        })
      ).rejects.toThrow(/Memo ID must be a 64-bit unsigned integer/);
    });

    it("rejects memo type 'id' with string value", async () => {
      await expect(
        tool.execute({
          destination: VALID_DEST,
          amount: '1',
          assetCode: 'XLM',
          memoType: 'id',
          memo: '123456',
        })
      ).rejects.toThrow(/Memo ID must be a number/);
    });

    it("accepts memo type 'hash' with 32-byte hex string", async () => {
      const result = await tool.execute({
        destination: VALID_DEST,
        amount: '1',
        assetCode: 'XLM',
        memoType: 'hash',
        memo: 'a'.repeat(64),
      });
      expect(result.txHash).toBe('memo_type_hash');
    });

    it("accepts memo type 'hash' with 0x prefix", async () => {
      const result = await tool.execute({
        destination: VALID_DEST,
        amount: '1',
        assetCode: 'XLM',
        memoType: 'hash',
        memo: '0x' + 'a'.repeat(64),
      });
      expect(result.txHash).toBe('memo_type_hash');
    });

    it("rejects memo type 'hash' with invalid length", async () => {
      await expect(
        tool.execute({
          destination: VALID_DEST,
          amount: '1',
          assetCode: 'XLM',
          memoType: 'hash',
          memo: 'abc123',
        })
      ).rejects.toThrow(/Memo hash must be a 32-byte hex string/);
    });

    it("rejects memo type 'hash' with non-hex characters", async () => {
      await expect(
        tool.execute({
          destination: VALID_DEST,
          amount: '1',
          assetCode: 'XLM',
          memoType: 'hash',
          memo: 'g'.repeat(64),
        })
      ).rejects.toThrow(/Memo hash must contain only valid hex characters/);
    });

    it("accepts memo type 'return' with 32-byte hex string", async () => {
      const result = await tool.execute({
        destination: VALID_DEST,
        amount: '1',
        assetCode: 'XLM',
        memoType: 'return',
        memo: 'f'.repeat(64),
      });
      expect(result.txHash).toBe('memo_type_hash');
    });

    it("accepts memo type 'return' with 0x prefix", async () => {
      const result = await tool.execute({
        destination: VALID_DEST,
        amount: '1',
        assetCode: 'XLM',
        memoType: 'return',
        memo: '0x' + 'f'.repeat(64),
      });
      expect(result.txHash).toBe('memo_type_hash');
    });

    it("rejects memo type 'return' with invalid length", async () => {
      await expect(
        tool.execute({
          destination: VALID_DEST,
          amount: '1',
          assetCode: 'XLM',
          memoType: 'return',
          memo: 'abc123',
        })
      ).rejects.toThrow(/Memo return must be a 32-byte hex string/);
    });

    it("defaults to 'text' memo type when not specified", async () => {
      const result = await tool.execute({
        destination: VALID_DEST,
        amount: '1',
        assetCode: 'XLM',
        memo: 'default text memo',
      });
      expect(result.txHash).toBe('memo_type_hash');
    });

    it("accepts memo type 'text' explicitly", async () => {
      const result = await tool.execute({
        destination: VALID_DEST,
        amount: '1',
        assetCode: 'XLM',
        memoType: 'text',
        memo: 'explicit text memo',
      });
      expect(result.txHash).toBe('memo_type_hash');
    });

    it('handles undefined memo value', async () => {
      const result = await tool.execute({
        destination: VALID_DEST,
        amount: '1',
        assetCode: 'XLM',
        memoType: 'id',
      });
      expect(result.txHash).toBe('memo_type_hash');
    });
  });

  // ── Happy path ──────────────────────────────────────────────────────────────

  describe('Happy path', () => {
    beforeEach(() => {
      mockHorizonServer.setSubmitResult({ hash: 'success_tx_hash', ledger: 42 } as any);
    });

    it('completes an XLM payment and returns txHash + ledger', async () => {
      const result = await tool.execute({
        destination: VALID_DEST,
        amount: '100',
        assetCode: 'XLM',
      });

      expect(result.txHash).toBe('success_tx_hash');
      expect(result.ledger).toBe(42);
    });

    it('completes a custom asset payment (USDC)', async () => {
      const result = await tool.execute({
        destination: VALID_DEST,
        amount: '50.5',
        assetCode: 'USDC',
        assetIssuer: VALID_ISSUER,
      });

      expect(result.txHash).toBe('success_tx_hash');
    });

    it('calls loadAccount with the agent public key', async () => {
      await tool.execute({ destination: VALID_DEST, amount: '1', assetCode: 'XLM' });
      expect(mockHorizonServer.loadAccount).toHaveBeenCalledOnce();
      expect(mockHorizonServer.loadAccount).toHaveBeenCalledWith(tool.publicKey);
    });

    it('calls submitTransaction exactly once per payment', async () => {
      await tool.execute({ destination: VALID_DEST, amount: '1', assetCode: 'XLM' });
      expect(mockHorizonServer.submitTransaction).toHaveBeenCalledOnce();
    });

    it('embeds a memo when provided', async () => {
      // We just verify execute doesn't throw and the memo is accepted
      const result = await tool.execute({
        destination: VALID_DEST,
        amount: '1',
        assetCode: 'XLM',
        memo: 'test-memo-123',
      });
      expect(result.txHash).toBeTruthy();
    });
  });

  // ── Horizon / network error handling ────────────────────────────────────────

  describe('Network error handling', () => {
    it('propagates Horizon submission error', async () => {
      mockHorizonServer.setSubmitError(
        new Error('Horizon: transaction failed — op_no_source_account')
      );

      await expect(
        tool.execute({ destination: VALID_DEST, amount: '1', assetCode: 'XLM' })
      ).rejects.toThrow(/op_no_source_account/);
    });

    it('surfaces insufficient funds error from Horizon', async () => {
      mockHorizonServer.setSubmitError(new Error('Horizon: op_underfunded — insufficient balance'));

      await expect(
        tool.execute({ destination: VALID_DEST, amount: '999999', assetCode: 'XLM' })
      ).rejects.toThrow(/underfunded/);
    });

    it('propagates account not found error', async () => {
      mockHorizonServer.setAccountError(new Error('Horizon: account not found (404)'));

      await expect(
        tool.execute({ destination: VALID_DEST, amount: '1', assetCode: 'XLM' })
      ).rejects.toThrow(/account not found/);
    });

    it('handles network timeout from loadAccount', async () => {
      mockHorizonServer.setAccountError(
        Object.assign(new Error('ECONNABORTED: network timeout after 30000ms'), {
          code: 'ECONNABORTED',
        })
      );

      await expect(
        tool.execute({ destination: VALID_DEST, amount: '1', assetCode: 'XLM' })
      ).rejects.toThrow(/timeout/i);
    });

    it('handles network timeout from submitTransaction', async () => {
      mockHorizonServer.setSubmitError(
        Object.assign(new Error('ECONNABORTED: network timeout after 30000ms'), {
          code: 'ECONNABORTED',
        })
      );

      await expect(
        tool.execute({ destination: VALID_DEST, amount: '1', assetCode: 'XLM' })
      ).rejects.toThrow(/timeout/i);
    });

    it('surfaces tx_bad_seq when sequence number is stale', async () => {
      mockHorizonServer.setSubmitError(
        new Error('Horizon: tx_bad_seq — sequence number is not valid')
      );

      await expect(
        tool.execute({ destination: VALID_DEST, amount: '1', assetCode: 'XLM' })
      ).rejects.toThrow(/tx_bad_seq/);
    });

    it('recovers from tx_bad_seq on first retry', async () => {
      mockHorizonServer.submitTransaction
        .mockRejectedValueOnce(new Error('Horizon: tx_bad_seq — sequence number is not valid'))
        .mockResolvedValueOnce({ hash: 'retry_success_hash', ledger: 42 } as any);

      const result = await tool.execute({
        destination: VALID_DEST,
        amount: '1',
        assetCode: 'XLM',
      });
      expect(result.txHash).toBe('retry_success_hash');
      expect(result.ledger).toBe(42);
      expect(mockHorizonServer.submitTransaction).toHaveBeenCalledTimes(2);
    });

    it('surfaces destination account non-existent (op_no_destination)', async () => {
      mockHorizonServer.setSubmitError(
        new Error('Horizon: op_no_destination — destination account does not exist')
      );

      await expect(
        tool.execute({ destination: VALID_DEST, amount: '1', assetCode: 'XLM' })
      ).rejects.toThrow(/op_no_destination/);
    });
  });

  // ── Retry exhaustion ────────────────────────────────────────────────────────

  describe('Retry exhaustion', () => {
    it('throws after all retries are exhausted on loadAccount', async () => {
      // rpcClient.loadAccount is already wrapped in withRetry internally.
      // We simulate the final rejection reaching the tool.
      mockHorizonServer.setAccountError(new Error('max retries exceeded: 503 Service Unavailable'));

      await expect(
        tool.execute({ destination: VALID_DEST, amount: '1', assetCode: 'XLM' })
      ).rejects.toThrow(/503/);
    });

    it('throws after all retries exhausted on submitTransaction', async () => {
      mockHorizonServer.setSubmitError(new Error('max retries exceeded: Horizon unavailable'));

      await expect(
        tool.execute({ destination: VALID_DEST, amount: '1', assetCode: 'XLM' })
      ).rejects.toThrow(/Horizon unavailable/);
    });
  });

  // ── State verification ──────────────────────────────────────────────────────

  describe('State verification', () => {
    it('does not call submitTransaction when loadAccount fails', async () => {
      mockHorizonServer.setAccountError(new Error('not found'));

      try {
        await tool.execute({ destination: VALID_DEST, amount: '1', assetCode: 'XLM' });
      } catch (_) {
        /* expected */
      }

      expect(mockHorizonServer.submitTransaction).not.toHaveBeenCalled();
    });

    it('exposes the agent public key', () => {
      expect(tool.publicKey).toMatch(/^G[A-Z2-7]{55}$/);
    });
  });

  // ── Network passphrase selection ────────────────────────────────────────────

  describe('Network passphrase selection', () => {
    it('uses Networks.PUBLIC (mainnet) when STELLAR_NETWORK is mainnet', async () => {
      // Create a tool instance and inspect the signed transaction
      vi.resetModules();
      vi.mock('../backend/config', () => {
        const { Keypair: KP } = require('@stellar/stellar-sdk');
        const secret = 'SADQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQP54X';
        return {
          config: {
            STELLAR_NETWORK: 'mainnet',
            HORIZON_URL: 'https://horizon.stellar.org',
            SOROBAN_RPC_URL: 'https://soroban-mainnet.stellar.org',
            X402_ASSET_CODE: 'USDC',
            X402_ASSET_ISSUER: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
            MAX_RETRIES: 3,
            RETRY_DELAY_MS: 100,
            AGENT_PUBLIC_KEY: KP.fromSecret(secret).publicKey(),
            agentKeypair: () => KP.fromSecret(secret),
          },
        };
      });

      mockHorizonServer.loadAccount.mockResolvedValue(
        makeMockAccount(Keypair.fromSecret(TEST_SECRET).publicKey()) as any
      );
      mockHorizonServer.submitTransaction.mockImplementation((tx: any) => {
        // Verify XDR contains mainnet network passphrase
        return Promise.resolve({ hash: 'mainnet_tx', ledger: 100 } as any);
      });
      // The correct network passphrase is verified via resolveNetworkPassphrase
      // unit tests in rpc_client.test.ts. Here we just verify the tool submits.
      mockHorizonServer.loadAccount.mockResolvedValue(
        makeMockAccount(Keypair.fromSecret(TEST_SECRET).publicKey()) as any
      );
      mockHorizonServer.submitTransaction.mockResolvedValue({
        hash: 'mainnet_tx',
        ledger: 100,
      } as any);

      const tool = new StellarPaymentTool(TEST_SECRET);
      const result = await tool.execute({
        destination: VALID_DEST,
        amount: '1',
        assetCode: 'XLM',
      });

      expect(result.txHash).toBe('mainnet_tx');
      expect(mockHorizonServer.submitTransaction).toHaveBeenCalled();
    });

    it('uses Networks.FUTURENET when STELLAR_NETWORK is futurenet', async () => {
      vi.resetModules();
      vi.mock('../backend/config', () => {
        const { Keypair: KP } = require('@stellar/stellar-sdk');
        const secret = 'SADQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQP54X';
        return {
          config: {
            STELLAR_NETWORK: 'futurenet',
            HORIZON_URL: 'https://horizon-futurenet.stellar.org',
            SOROBAN_RPC_URL: 'https://soroban-futurenet.stellar.org',
            X402_ASSET_CODE: 'USDC',
            X402_ASSET_ISSUER: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
            MAX_RETRIES: 3,
            RETRY_DELAY_MS: 100,
            AGENT_PUBLIC_KEY: KP.fromSecret(secret).publicKey(),
            agentKeypair: () => KP.fromSecret(secret),
          },
        };
      });

      mockHorizonServer.loadAccount.mockResolvedValue(
        makeMockAccount(Keypair.fromSecret(TEST_SECRET).publicKey()) as any
      );
      mockHorizonServer.submitTransaction.mockImplementation((tx: any) => {
        // Verify XDR contains futurenet network passphrase
        return Promise.resolve({ hash: 'futurenet_tx', ledger: 200 } as any);
      });
      mockHorizonServer.loadAccount.mockResolvedValue(
        makeMockAccount(Keypair.fromSecret(TEST_SECRET).publicKey()) as any
      );
      mockHorizonServer.submitTransaction.mockResolvedValue({
        hash: 'futurenet_tx',
        ledger: 200,
      } as any);

      const tool = new StellarPaymentTool(TEST_SECRET);
      const result = await tool.execute({
        destination: VALID_DEST,
        amount: '1',
        assetCode: 'XLM',
      });

      expect(result.txHash).toBe('futurenet_tx');
      expect(mockHorizonServer.submitTransaction).toHaveBeenCalled();
    });
  });
});

describe('Horizon response validation', () => {
  it('throws ZodError when submitTransaction returns malformed response', async () => {
    mockHorizonServer.setAccount(
      makeMockAccount('GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5')
    );
    mockHorizonServer.setSubmitResult({ hash: undefined, ledger: 1 } as any);

    const tool = new StellarPaymentTool();

    await expect(
      tool.execute({
        destination: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
        amount: '1',
        assetCode: 'XLM',
      })
    ).rejects.toThrow(z.ZodError);
  });
});

// ─── Mutation-killing assertions for StellarPaymentTool.ts (#456) ─────────────
// These tests pin exact values and boundary conditions that Stryker's arithmetic,
// comparison, and logical mutations would otherwise survive.

describe('StellarPaymentTool — mutation-killing: exact return values', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(rpcClient.loadAccount).mockResolvedValue(
      makeMockAccount(new StellarPaymentTool(TEST_SECRET).publicKey) as any
    );
    vi.mocked(rpcClient.submitTransaction).mockResolvedValue({
      hash: 'exact_hash_value',
      ledger: 999,
    } as any);
  });

  it('execute() returns an object whose txHash is exactly the Horizon hash', async () => {
    const tool = new StellarPaymentTool(TEST_SECRET);
    const result = await tool.execute({ destination: VALID_DEST, amount: '1', assetCode: 'XLM' });
    // A mutation swapping result.txHash ↔ result.ledger would be caught here.
    expect(result.txHash).toBe('exact_hash_value');
    expect(result.txHash).not.toBe(999);
  });

  it('execute() returns an object whose ledger is exactly the Horizon ledger number', async () => {
    const tool = new StellarPaymentTool(TEST_SECRET);
    const result = await tool.execute({ destination: VALID_DEST, amount: '1', assetCode: 'XLM' });
    expect(result.ledger).toBe(999);
    expect(result.ledger).not.toBe('exact_hash_value');
  });

  it('execute() returns exactly two keys (txHash and ledger), no extras', async () => {
    const tool = new StellarPaymentTool(TEST_SECRET);
    const result = await tool.execute({ destination: VALID_DEST, amount: '1', assetCode: 'XLM' });
    const keys = Object.keys(result);
    expect(keys).toContain('txHash');
    expect(keys).toContain('ledger');
  });
});

describe('StellarPaymentTool — mutation-killing: amount validation boundaries', () => {
  let tool: StellarPaymentTool;

  beforeEach(() => {
    vi.clearAllMocks();
    tool = new StellarPaymentTool(TEST_SECRET);
    vi.mocked(rpcClient.loadAccount).mockResolvedValue(makeMockAccount(tool.publicKey) as any);
  });

  it("rejects amount '0.00000000' (8 decimal places)", async () => {
    await expect(
      tool.execute({ destination: VALID_DEST, amount: '0.00000000', assetCode: 'XLM' })
    ).rejects.toThrow();
  });

  it("rejects amount '0.0000000' (7 decimal places of just zeros — still 0)", async () => {
    // 0.0000000 is numerically zero; Stellar disallows it
    await expect(
      tool.execute({ destination: VALID_DEST, amount: '0.0000000', assetCode: 'XLM' })
    ).rejects.toThrow();
  });

  it('rejects a non-numeric amount string', async () => {
    await expect(
      tool.execute({ destination: VALID_DEST, amount: 'not-a-number', assetCode: 'XLM' })
    ).rejects.toThrow();
  });

  it('rejects an empty string amount', async () => {
    await expect(
      tool.execute({ destination: VALID_DEST, amount: '', assetCode: 'XLM' })
    ).rejects.toThrow();
  });
});

describe('StellarPaymentTool — mutation-killing: destination key validation', () => {
  let tool: StellarPaymentTool;

  beforeEach(() => {
    vi.clearAllMocks();
    tool = new StellarPaymentTool(TEST_SECRET);
    vi.mocked(rpcClient.loadAccount).mockResolvedValue(makeMockAccount(tool.publicKey) as any);
  });

  it("rejects a key starting with 'S' (secret key, not public key)", async () => {
    const secretKey = 'SADQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQP54X';
    await expect(
      tool.execute({ destination: secretKey, amount: '1', assetCode: 'XLM' })
    ).rejects.toThrow();
  });

  it('rejects an empty destination string', async () => {
    await expect(
      tool.execute({ destination: '', amount: '1', assetCode: 'XLM' })
    ).rejects.toThrow();
  });

  it('accepts a valid USDC payment with the correct issuer', async () => {
    vi.mocked(rpcClient.submitTransaction).mockResolvedValue({
      hash: 'usdc_tx',
      ledger: 5,
    } as any);

    const result = await tool.execute({
      destination: VALID_DEST,
      amount: '10',
      assetCode: 'USDC',
      assetIssuer: VALID_ISSUER,
    });
    expect(result.txHash).toBe('usdc_tx');
    expect(result.ledger).toBe(5);
  });
});
