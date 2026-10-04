/**
 * backend/tools/FeeBumpTool.ts
 * Wraps any failed transaction in a fee-bump envelope for sponsored retry.
 * Allows the agent to pay fees on behalf of a transaction signed by a different account.
 */

import {
  Keypair,
  TransactionBuilder,
  FeeBumpTransaction,
  Transaction,
  Networks,
  BASE_FEE,
} from '@stellar/stellar-sdk';
import { z } from 'zod';
import { config } from '../config';
import { logger } from '../logger';
import { resolveNetworkPassphrase, submitTransaction } from '../rpc_client';
import { ValidationError } from '../errors';
import { validateXDR } from '../types/xdr';
import { createLogger } from '../utils/logger';
import { SubmitResultSchema } from './StellarPaymentTool';

const log = createLogger('fee-bump');

// ─── Input schema ─────────────────────────────────────────────────────────────

export const FeeBumpInputSchema = z.object({
  innerTxXdr: z.string().min(1, 'innerTxXdr must be a non-empty base64 XDR string'),
  feeAccount: z.string().length(56, 'Invalid Stellar public key').optional(),
  baseFeeMultiplier: z.number().int().min(2).default(2),
});

export type FeeBumpInput = z.infer<typeof FeeBumpInputSchema>;

/**
 * Compute the total fee-bump fee for wrapping `innerTx`, per Stellar's
 * fee-bump rules: the outer fee must cover every inner operation plus the
 * fee-bump operation itself, at a strictly higher per-operation rate than the
 * inner transaction paid (so it can't be rejected as `fee_insufficient`).
 *
 * Shared by {@link FeeBumpTool.execute} and
 * `backend/tx_idempotency.ts`'s stuck-transaction resubmission path, so the
 * two never drift apart on fee math.
 *
 * @param baseFeeMultiplier - Must be >= 2 (see {@link FeeBumpInputSchema}).
 */
export function computeFeeBumpFee(innerTx: Transaction, baseFeeMultiplier: number): string {
  const baseFee = parseInt(innerTx.fee, 10);
  const operationCount = innerTx.operations.length || 1;
  const feePerOp = Math.ceil(baseFee / operationCount);
  const newFeePerOp = Math.max(feePerOp * baseFeeMultiplier, parseInt(BASE_FEE, 10));
  return String((operationCount + 1) * newFeePerOp);
}

// ─── Tool implementation ──────────────────────────────────────────────────────

export class FeeBumpTool {
  private keypair: Keypair;
  private networkPassphrase: string;

  constructor(secretKey: string = config.agentKeypair().secret()) {
    this.keypair = Keypair.fromSecret(secretKey);
    this.networkPassphrase = resolveNetworkPassphrase(config.STELLAR_NETWORK);
  }

  get publicKey(): string {
    return this.keypair.publicKey();
  }

  async execute(rawInput: unknown): Promise<{ txHash: string; ledger: number }> {
    const input = FeeBumpInputSchema.parse(rawInput);

    try {
      validateXDR(input.innerTxXdr);
    } catch (err) {
      throw new ValidationError(
        err instanceof Error ? err.message : 'Invalid inner transaction XDR',
        err
      );
    }

    const feeAccount = input.feeAccount ?? this.keypair.publicKey();

    // Deserialize the inner transaction from XDR
    let innerTx: Transaction;
    try {
      innerTx = TransactionBuilder.fromXDR(input.innerTxXdr, this.networkPassphrase) as Transaction;
    } catch (err) {
      throw new ValidationError(`Invalid inner transaction XDR: unable to deserialize`, err);
    }

    if (innerTx instanceof FeeBumpTransaction) {
      throw new Error('Inner transaction must not itself be a fee-bump transaction');
    }

    // ── Network passphrase guard ──────────────────────────────────────────────
    // XDR does not embed the network passphrase, so TransactionBuilder.fromXDR()
    // will successfully deserialize a transaction signed for any network.
    // We detect cross-network XDRs by verifying the source account's signature
    // against the transaction hash computed with the current network passphrase.
    // If the signature is invalid for our hash, the inner tx was signed for a
    // different network and must be rejected before we build or submit the
    // fee-bump envelope.
    if (innerTx.signatures.length > 0) {
      const sourceKeypair = Keypair.fromPublicKey(innerTx.source);
      const sourceHint = sourceKeypair.signatureHint();
      const sourceSig = innerTx.signatures.find((d) => d.hint().equals(sourceHint));

      if (sourceSig) {
        const sigValid = sourceKeypair.verify(innerTx.hash(), sourceSig.signature());
        if (!sigValid) {
          throw new Error(
            'Inner transaction was signed for a different network passphrase. ' +
              'Ensure the inner XDR originates from the same network as the agent ' +
              `(${this.networkPassphrase}).`
          );
        }
      }
    }

    const feeBumpFee = computeFeeBumpFee(innerTx, input.baseFeeMultiplier);

    logger.info('Building fee-bump transaction', {
      feeAccount,
      innerTxHash: innerTx.hash().toString('hex'),
      baseFeeMultiplier: input.baseFeeMultiplier,
      feeBumpFee,
    });

    const feeBumpTx = TransactionBuilder.buildFeeBumpTransaction(
      feeAccount,
      feeBumpFee,
      innerTx,
      this.networkPassphrase
    );

    feeBumpTx.sign(this.keypair);

    const result = SubmitResultSchema.parse(await submitTransaction(feeBumpTx));
    return { txHash: result.hash, ledger: result.ledger };
  }
}
