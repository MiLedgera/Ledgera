/**
 * tests/soroban_deploy.test.ts
 *
 * Tests for SorobanDeployTool and the soroban_deploy agent task.
 * Covers: upload, instantiate, deploy flow, schema validation, and error handling.
 *
 * The tool builds real `uploadContractWasm` / `createCustomContract` Soroban
 * operations and drives them through the standard build -> simulate -> sign ->
 * submit -> poll pipeline (see backend/tools/SorobanInvokeTool.ts for the same
 * pattern). This suite mocks that pipeline via the shared MockSorobanServer
 * fixture rather than fictional `sorobanServer.uploadContractWasm` /
 * `createContractFromWasm` methods — those never existed on the real
 * `@stellar/stellar-sdk` `rpc.Server` class (audit finding B-1).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Address } from '@stellar/stellar-sdk';
import * as crypto from 'crypto';
import { SorobanDeployTool, SorobanDeployInputSchema } from '../backend/tools/SorobanDeployTool';
import * as rpcClient from '../backend/rpc_client';
import type { MockSorobanServer } from './fixtures/MockSorobanServer';
import { ValidationError } from '../backend/errors';
import { PayFiAgent } from '../backend/agent';

// ─── Mocks ────────────────────────────────────────────────────────────────────
// Same pattern as tests/soroban_invoke.test.ts: the mock factory constructs the
// fixture (via a dynamic import so it runs after vi.mock's hoisting), and the
// mocked module namespace IS that fixture instance.

vi.mock('../backend/rpc_client', async () => {
  const { createMockSorobanServer } = await import('./fixtures/MockSorobanServer');
  return createMockSorobanServer();
});

const mockSorobanServer = rpcClient as unknown as MockSorobanServer;

vi.mock('../backend/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../backend/utils/logger', () => ({
  createLogger: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })),
  generateCorrelationId: vi.fn(() => 'mock-correlation-id'),
}));

vi.mock('../backend/persistence', () => ({
  saveResult: vi.fn(),
}));

vi.mock('../backend/webhook', () => ({
  dispatchWebhook: vi.fn(),
}));

vi.mock('../backend/config', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Keypair } = require('@stellar/stellar-sdk');
  const secret = 'SADQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQP54X';
  return {
    config: {
      STELLAR_NETWORK: 'testnet',
      HORIZON_URL: 'https://horizon-testnet.stellar.org',
      SOROBAN_RPC_URL: 'https://soroban-testnet.stellar.org',
      AGENT_PUBLIC_KEY: Keypair.fromSecret(secret).publicKey(),
      X402_ASSET_CODE: 'USDC',
      X402_ASSET_ISSUER: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
      MAX_RETRIES: 3,
      RETRY_DELAY_MS: 1,
      AGENT_SPENDING_LIMIT: '100',
      MAX_SOROBAN_FEE_STROOPS: 1_000_000,
      QUEUE_CAPACITY: 10,
      MAX_CONCURRENT_TASKS: 5,
      agentKeypair: () => Keypair.fromSecret(secret),
    },
    MAINNET_SPENDING_CAP: 10_000,
  };
});

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const MOCK_WASM_BUFFER = Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
const MOCK_WASM_HASH = crypto.createHash('sha256').update(MOCK_WASM_BUFFER).digest('hex');
const MOCK_CONTRACT_ADDRESS = Address.contract(crypto.randomBytes(32));
const MOCK_CONTRACT_ID = MOCK_CONTRACT_ADDRESS.toString();
const MOCK_CONTRACT_RETVAL = MOCK_CONTRACT_ADDRESS.toScVal();

describe('SorobanDeployTool', () => {
  let tool: SorobanDeployTool;

  beforeEach(() => {
    mockSorobanServer.reset();
    mockSorobanServer.setPrepared({ retval: MOCK_CONTRACT_RETVAL });
    mockSorobanServer.setTransactionResult({ status: 'SUCCESS' });
    tool = new SorobanDeployTool();
  });

  // ── Upload ──────────────────────────────────────────────────────────────────

  describe('upload action', () => {
    it('uploads WASM buffer and returns sha256(wasm) as the WASM hash', async () => {
      const result = await tool.execute({
        action: 'upload',
        wasm: MOCK_WASM_BUFFER,
      });

      expect(result.action).toBe('upload');
      expect(result.wasmHash).toBe(MOCK_WASM_HASH);
      expect(result.txHash).toBe('mock_tx_hash');
    });

    it('accepts wasmBuffer field as alternative to wasm', async () => {
      const result = await tool.execute({
        action: 'upload',
        wasmBuffer: MOCK_WASM_BUFFER,
      });

      expect(result.wasmHash).toBe(MOCK_WASM_HASH);
    });

    it('accepts hex string for WASM bytecode', async () => {
      const hex = MOCK_WASM_BUFFER.toString('hex');
      const result = await tool.execute({
        action: 'upload',
        wasm: hex,
      });

      expect(result.wasmHash).toBe(MOCK_WASM_HASH);
    });

    it('throws ValidationError when wasm bytecode is missing', async () => {
      await expect(
        tool.execute({
          action: 'upload',
        })
      ).rejects.toThrow(ValidationError);
    });

    it('propagates a simulation failure without submitting', async () => {
      mockSorobanServer.setSimulationError(new Error('Soroban simulation failed: budget_exceeded'));

      await expect(
        tool.execute({ action: 'upload', wasm: MOCK_WASM_BUFFER })
      ).rejects.toThrow('Soroban simulation failed');
      expect(mockSorobanServer.sorobanServer.sendTransaction).not.toHaveBeenCalled();
    });

    it('rejects when the simulated fee exceeds MAX_SOROBAN_FEE_STROOPS', async () => {
      mockSorobanServer.setPrepared({
        tx: {
          sign: vi.fn(),
          signatures: [{ hint: () => Buffer.alloc(4), signature: () => Buffer.alloc(64) }],
          fee: 2_000_000,
          timeBounds: {},
        },
      });

      await expect(
        tool.execute({ action: 'upload', wasm: MOCK_WASM_BUFFER })
      ).rejects.toThrow(/MAX_SOROBAN_FEE_STROOPS/);
    });
  });

  // ── Instantiate ─────────────────────────────────────────────────────────────

  describe('instantiate action', () => {
    it('instantiates a contract from a WASM hash and returns the contract ID', async () => {
      const result = await tool.execute({
        action: 'instantiate',
        wasmHash: MOCK_WASM_HASH,
      });

      expect(result.action).toBe('instantiate');
      expect(result.contractId).toBe(MOCK_CONTRACT_ID);
      expect(result.txHash).toBe('mock_tx_hash');
    });

    it('throws ValidationError when wasmHash is missing', async () => {
      await expect(
        tool.execute({
          action: 'instantiate',
        })
      ).rejects.toThrow(ValidationError);
    });

    it('throws ValidationError when wasmHash is not a 32-byte hex string', async () => {
      await expect(
        tool.execute({ action: 'instantiate', wasmHash: 'not-hex-and-wrong-length' })
      ).rejects.toThrow(ValidationError);
    });

    it('throws when the simulation returns no retval', async () => {
      mockSorobanServer.setPrepared({ retval: undefined });

      await expect(
        tool.execute({ action: 'instantiate', wasmHash: MOCK_WASM_HASH })
      ).rejects.toThrow('did not return a contract address');
    });
  });

  // ── Deploy ──────────────────────────────────────────────────────────────────

  describe('deploy action', () => {
    it('chains upload and instantiate in sequence and returns both wasmHash and contractId', async () => {
      const result = await tool.execute({
        action: 'deploy',
        wasm: MOCK_WASM_BUFFER,
      });

      expect(result.action).toBe('deploy');
      expect(result.wasmHash).toBe(MOCK_WASM_HASH);
      expect(result.contractId).toBe(MOCK_CONTRACT_ID);
    });

    it('propagates error if the upload step fails during deploy', async () => {
      mockSorobanServer.setSimulationError(new Error('Soroban RPC upload error'));

      await expect(
        tool.execute({
          action: 'deploy',
          wasm: MOCK_WASM_BUFFER,
        })
      ).rejects.toThrow('Soroban RPC upload error');
    });

    it('propagates error if the submit step fails during deploy', async () => {
      mockSorobanServer.submitError('failed_tx_hash');

      await expect(
        tool.execute({
          action: 'deploy',
          wasm: MOCK_WASM_BUFFER,
        })
      ).rejects.toThrow('Soroban submit failed');
    });
  });

  // ── Schema validation ───────────────────────────────────────────────────────

  describe('schema validation', () => {
    it('rejects unknown action', () => {
      const parsed = SorobanDeployInputSchema.safeParse({
        action: 'invalid_action',
      });
      expect(parsed.success).toBe(false);
    });
  });

  // ── PayFiAgent Integration ──────────────────────────────────────────────────

  describe('PayFiAgent integration', () => {
    it('executes soroban_deploy task through agent.run()', async () => {
      const agent = new PayFiAgent();
      const result = await agent.run({
        type: 'soroban_deploy',
        payload: {
          action: 'deploy',
          wasm: MOCK_WASM_BUFFER,
        },
      });

      expect(result.success).toBe(true);
      expect(result.taskType).toBe('soroban_deploy');
      expect(result.data).toMatchObject({
        action: 'deploy',
        wasmHash: MOCK_WASM_HASH,
        contractId: MOCK_CONTRACT_ID,
      });

      agent.destroy();
    });
  });
});
