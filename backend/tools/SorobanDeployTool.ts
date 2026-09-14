/**
 * backend/tools/SorobanDeployTool.ts
 *
 * Upload WASM bytecode and instantiate Soroban smart contracts.
 * Supports:
 *   - action: 'upload' -> uploads WASM bytecode and returns its hash
 *   - action: 'instantiate' -> creates a contract instance from a WASM hash and returns the contract ID
 *   - action: 'deploy' -> chains upload and instantiate in sequence
 *
 * Both operations go through the same build -> simulate (mandatory) -> sign ->
 * submit -> poll pipeline as every other Soroban tool in this codebase (see
 * SorobanInvokeTool). There is no dedicated "upload"/"deploy" RPC endpoint —
 * `@stellar/stellar-sdk`'s `rpc.Server` only exposes read/simulate/submit
 * primitives; contract upload and instantiation are themselves Soroban host
 * function invocations built via `Operation.uploadContractWasm` and
 * `Operation.createCustomContract`.
 */

import * as fs from 'fs';
import * as crypto from 'crypto';
import { z } from 'zod';
import {
  Address,
  Keypair,
  TransactionBuilder,
  Operation,
  scValToNative,
} from '@stellar/stellar-sdk';
import { config } from '../config';
import { loadAccount, prepareSorobanTxWithEvents, resolveNetworkPassphrase } from '../rpc_client';
import { sorobanServer } from '../rpc_client';
import { ValidationError } from '../errors';
import { createLogger } from '../utils/logger';
import { SOROBAN_TX_TIMEOUT } from './SorobanInvokeTool';

const log = createLogger('soroban-deploy');

// ─── Input Schema ─────────────────────────────────────────────────────────────

export const SorobanDeployInputSchema = z.object({
  action: z.enum(['upload', 'instantiate', 'deploy']),
  wasm: z.union([z.instanceof(Buffer), z.string()]).optional(),
  wasmBuffer: z.union([z.instanceof(Buffer), z.string()]).optional(),
  wasmHash: z.string().optional(),
});

export type SorobanDeployInput = z.infer<typeof SorobanDeployInputSchema>;

export interface SorobanDeployResult {
  action: 'upload' | 'instantiate' | 'deploy';
  wasmHash?: string;
  contractId?: string;
  txHash?: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function resolveWasmBuffer(input: SorobanDeployInput, actionName: string): Buffer {
  const raw = input.wasmBuffer ?? input.wasm;
  if (!raw) {
    throw new ValidationError(`WASM bytecode is required for action '${actionName}'`);
  }

  if (Buffer.isBuffer(raw)) {
    if (raw.length === 0) {
      throw new ValidationError(`WASM buffer cannot be empty for action '${actionName}'`);
    }
    return raw;
  }

  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) {
      throw new ValidationError(`WASM string cannot be empty for action '${actionName}'`);
    }

    // Check if it is an existing file path
    try {
      if (fs.existsSync(trimmed) && fs.statSync(trimmed).isFile()) {
        return fs.readFileSync(trimmed);
      }
    } catch {
      // Not a valid file path, continue with decoding
    }

    // Try hex if it looks like hex
    if (/^[0-9a-fA-F]+$/.test(trimmed) && trimmed.length % 2 === 0) {
      return Buffer.from(trimmed, 'hex');
    }

    // Try base64
    try {
      const buf = Buffer.from(trimmed, 'base64');
      if (buf.length > 0) return buf;
    } catch {
      // Fallback
    }

    return Buffer.from(trimmed, 'utf8');
  }

  throw new ValidationError(`Invalid WASM input type for action '${actionName}'`);
}

// ─── Tool Implementation ──────────────────────────────────────────────────────

export class SorobanDeployTool {
  private keypair: Keypair;
  private networkPassphrase: string;

  constructor(secretKey: string = config.agentKeypair().secret()) {
    this.keypair = Keypair.fromSecret(secretKey);
    this.networkPassphrase = resolveNetworkPassphrase(config.STELLAR_NETWORK);
  }

  /**
   * Upload WASM bytecode to the network via a `uploadContractWasm` host
   * function invocation. The resulting hash is `sha256(wasm)` — that is how
   * Soroban identifies uploaded WASM, so it's computed locally rather than
   * parsed out of the simulation/submission response.
   */
  async upload(wasmBuffer: Buffer): Promise<{ wasmHash: string; txHash: string }> {
    log.info({ sizeBytes: wasmBuffer.length }, 'Uploading contract WASM bytecode');

    const sourceAccount = await loadAccount(this.keypair.publicKey());
    const tx = new TransactionBuilder(sourceAccount, {
      fee: '0', // Overwritten by simulation-derived fee once prepared
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(Operation.uploadContractWasm({ wasm: wasmBuffer }))
      .setTimeout(SOROBAN_TX_TIMEOUT)
      .build();

    const { tx: preparedTx } = await prepareSorobanTxWithEvents(tx);
    this.assertFeeWithinBudget(preparedTx.fee);

    if (!preparedTx.timeBounds) {
      throw new Error(
        'Broadcast aborted: transaction has no time bounds (setTimeout(0)). ' +
          'Use a positive timeout to prevent indefinite replay.'
      );
    }

    preparedTx.sign(this.keypair);
    if (!preparedTx.signatures?.length) {
      throw new Error('Transaction signing produced no signatures');
    }

    const result = await sorobanServer.sendTransaction(preparedTx);
    if (result.status === 'ERROR') {
      throw new Error(`Soroban submit failed: ${result.errorResult?.toXDR('base64')}`);
    }

    await this.pollForConfirmation(result.hash);

    const wasmHash = crypto.createHash('sha256').update(wasmBuffer).digest('hex');
    log.info({ wasmHash, txHash: result.hash }, 'Contract WASM uploaded successfully');
    return { wasmHash, txHash: result.hash };
  }

  /**
   * Instantiate a contract from an already-uploaded WASM hash via a
   * `createCustomContract` host function invocation. The new contract's
   * address is read from the simulation's return value — Soroban's contract
   * ID derivation (network ID + source address + salt) is deterministic, so
   * the simulated address is the address the contract will actually have
   * once the transaction is confirmed.
   */
  async instantiate(wasmHash: string): Promise<{ contractId: string; txHash: string }> {
    if (!wasmHash || typeof wasmHash !== 'string' || wasmHash.trim() === '') {
      throw new ValidationError('wasmHash is required for instantiate action');
    }

    let wasmHashBuffer: Buffer;
    try {
      wasmHashBuffer = Buffer.from(wasmHash, 'hex');
    } catch {
      throw new ValidationError('wasmHash must be a hex-encoded string');
    }
    if (wasmHashBuffer.length !== 32) {
      throw new ValidationError('wasmHash must be a 32-byte hex string (64 hex characters)');
    }

    log.info({ wasmHash }, 'Instantiating contract from WASM hash');

    const sourceAccount = await loadAccount(this.keypair.publicKey());
    const tx = new TransactionBuilder(sourceAccount, {
      fee: '0',
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(
        Operation.createCustomContract({
          wasmHash: wasmHashBuffer,
          address: new Address(this.keypair.publicKey()),
        })
      )
      .setTimeout(SOROBAN_TX_TIMEOUT)
      .build();

    const { tx: preparedTx, retval } = await prepareSorobanTxWithEvents(tx);
    this.assertFeeWithinBudget(preparedTx.fee);

    if (!retval) {
      throw new Error('Soroban simulation did not return a contract address');
    }
    const contractId = scValToNative(retval) as string;

    if (!preparedTx.timeBounds) {
      throw new Error(
        'Broadcast aborted: transaction has no time bounds (setTimeout(0)). ' +
          'Use a positive timeout to prevent indefinite replay.'
      );
    }

    preparedTx.sign(this.keypair);
    if (!preparedTx.signatures?.length) {
      throw new Error('Transaction signing produced no signatures');
    }

    const result = await sorobanServer.sendTransaction(preparedTx);
    if (result.status === 'ERROR') {
      throw new Error(`Soroban submit failed: ${result.errorResult?.toXDR('base64')}`);
    }

    await this.pollForConfirmation(result.hash);

    log.info({ contractId, wasmHash, txHash: result.hash }, 'Contract instantiated successfully');
    return { contractId, txHash: result.hash };
  }

  /**
   * Deploy flow: upload WASM and instantiate contract in sequence.
   * Returns both wasmHash and contractId.
   */
  async deploy(
    wasmBuffer: Buffer
  ): Promise<{ wasmHash: string; contractId: string; txHash: string }> {
    const { wasmHash } = await this.upload(wasmBuffer);
    const { contractId, txHash } = await this.instantiate(wasmHash);
    return { wasmHash, contractId, txHash };
  }

  /**
   * Execute the requested deploy action.
   */
  async execute(rawInput: unknown): Promise<SorobanDeployResult> {
    const input = SorobanDeployInputSchema.parse(rawInput);

    switch (input.action) {
      case 'upload': {
        const wasmBuffer = resolveWasmBuffer(input, 'upload');
        const { wasmHash, txHash } = await this.upload(wasmBuffer);
        return { action: 'upload', wasmHash, txHash };
      }

      case 'instantiate': {
        if (!input.wasmHash) {
          throw new ValidationError('wasmHash is required for instantiate action');
        }
        const { contractId, txHash } = await this.instantiate(input.wasmHash);
        return { action: 'instantiate', contractId, wasmHash: input.wasmHash, txHash };
      }

      case 'deploy': {
        const wasmBuffer = resolveWasmBuffer(input, 'deploy');
        const { wasmHash, contractId, txHash } = await this.deploy(wasmBuffer);
        return { action: 'deploy', wasmHash, contractId, txHash };
      }

      default:
        throw new ValidationError(`Unknown action: ${(input as { action: string }).action}`);
    }
  }

  /** Mirrors SorobanInvokeTool's fee guard against MAX_SOROBAN_FEE_STROOPS. */
  private assertFeeWithinBudget(feeValue: string | undefined): void {
    const parsedFee =
      feeValue === undefined || feeValue === null || feeValue === ''
        ? undefined
        : Number.parseInt(String(feeValue), 10);

    if (parsedFee !== undefined && Number.isNaN(parsedFee)) {
      throw new Error(`Invalid Soroban fee: ${feeValue}`);
    }
    if (parsedFee !== undefined && parsedFee > config.MAX_SOROBAN_FEE_STROOPS) {
      throw new Error(
        `Soroban fee ${feeValue} exceeds MAX_SOROBAN_FEE_STROOPS ${config.MAX_SOROBAN_FEE_STROOPS}`
      );
    }
  }

  /** Poll Soroban RPC until the transaction reaches a terminal state. Mirrors SorobanInvokeTool. */
  private async pollForConfirmation(
    hash: string,
    maxAttempts = 10,
    intervalMs = config.RETRY_DELAY_MS * 2
  ): Promise<{ txHash: string }> {
    for (let i = 0; i < maxAttempts; i++) {
      await new Promise((r) => setTimeout(r, intervalMs));
      const status = await sorobanServer.getTransaction(hash);

      if (status.status === 'SUCCESS') {
        log.info({ txHash: hash }, 'Soroban transaction confirmed');
        return { txHash: hash };
      }
      if (status.status === 'FAILED') {
        throw new Error(
          `Soroban transaction failed on-chain: ${hash} — ${status.resultXdr ?? 'no XDR'}`
        );
      }
      log.debug({ txHash: hash, attempt: i + 1, maxAttempts }, 'Polling for confirmation');
    }
    throw new Error(`Soroban transaction not confirmed within polling window: ${hash}`);
  }
}
