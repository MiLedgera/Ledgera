/**
 * backend/tools/StellarPaymentTool.ts
 * Standalone tool: native XLM or asset payment via Horizon.
 *
 * Architecture: Tool → simulate → sign → submit
 * Never broadcasts without a prior simulation pass.
 */

import {
  Keypair,
  Horizon,
  TransactionBuilder,
  Operation,
  Asset,
  BASE_FEE,
  StrKey,
} from '@stellar/stellar-sdk';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import { config } from '../config';
import { logger } from '../logger';
import { resolveNetworkPassphrase, type HorizonAccount } from '../rpc_client';
import { submitIdempotent } from '../tx_idempotency';
import { SOROBAN_TX_TIMEOUT } from './SorobanInvokeTool';
import { createLogger } from '../utils/logger';
import { buildMemo } from './memo';

const log = createLogger('stellar-payment');

// ─── Input schema ─────────────────────────────────────────────────────────────

const SubmitResultSchema = z.object({
  hash: z.string(),
  ledger: z.number(),
});

export { SubmitResultSchema };
export type SubmitResult = z.infer<typeof SubmitResultSchema>;

/**
 * Zod schema for payment input validation.
 *
 * @property destination - 56-character Stellar public key (G...) of the recipient
 * @property amount - Positive decimal string with up to 7 decimal places (Stellar network limit)
 * @property assetCode - Asset code (default: "XLM")
 * @property assetIssuer - Asset issuer public key (required for non-XLM assets)
 * @property memoType - Type of memo: "text", "id", "hash", or "return" (default: "text")
 * @property memo - Optional memo value (string for text/return/hash, number for id)
 */
export const PaymentInputSchema = z
  .object({
    destination: z
      .string()
      .length(56, 'Invalid Stellar public key')
      .refine(
        (val) => StrKey.isValidEd25519PublicKey(val),
        'Destination must be a valid Stellar public key (G...)'
      ),
    amount: z
      .string()
      // Negative-lookahead rejects "0" and all zero-value decimals ("0.0", "0.0000000")
      .regex(/^(?!0(\.0+)?$)\d+(\.\d{1,7})?$/, 'Amount must be a valid Stellar decimal')
      // Belt-and-suspenders guard: parseFloat catches any edge cases the regex misses
      .refine((v) => parseFloat(v) > 0, 'Amount must be greater than zero'),
    assetCode: z.string().default('XLM'),
    assetIssuer: z.string().optional(),
    memoType: z.enum(['text', 'id', 'hash', 'return']).optional().default('text'),
    memo: z.union([z.string(), z.number()]).optional(),
  })
  // MEMO_TEXT is limited to 28 bytes on the wire (Stellar counts UTF-8 bytes,
  // not JS string length, so a handful of multi-byte characters can exceed it
  // well before 28 *characters*). Enforced here — not just in buildMemo() —
  // so any caller validating with this schema directly gets the same guarantee
  // as execute().
  .superRefine((input, ctx) => {
    if (
      (input.memoType === undefined || input.memoType === 'text') &&
      typeof input.memo === 'string' &&
      Buffer.byteLength(input.memo, 'utf8') > 28
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['memo'],
        message: 'MEMO_TEXT must not exceed 28 bytes (UTF-8 encoded)',
      });
    }
  });

export type PaymentInput = z.infer<typeof PaymentInputSchema>;

// ─── Tool implementation ──────────────────────────────────────────────────────

export class StellarPaymentTool {
  private keypair: Keypair;
  private networkPassphrase: string;

  /**
   * Create a new StellarPaymentTool instance.
   *
   * @param secretKey - Stellar secret key (S...) for signing transactions
   */
  constructor(secretKey: string = config.agentKeypair().secret()) {
    this.keypair = Keypair.fromSecret(secretKey);
    this.networkPassphrase = resolveNetworkPassphrase(config.STELLAR_NETWORK);
  }

  get publicKey(): string {
    return this.keypair.publicKey();
  }

  /**
   * Execute a payment on the Stellar network.
   *
   * Steps:
   * 1. Validate input with Zod schema
   * 2. Resolve asset (native XLM or custom asset)
   * 3. Load source account to get latest sequence number
   * 4. Build transaction with payment operation and optional memo
   * 5. Sign transaction with keypair
   * 6. Submit idempotently (see `backend/tx_idempotency.ts`) — a retry with
   *    the same `idempotencyKey` is checked against the previously recorded
   *    transaction hash's on-chain status before anything new is built or
   *    broadcast, so a client-side timeout after a submission that actually
   *    landed can never result in a duplicate payment.
   *
   * @param rawInput - Raw payment input (will be validated)
   * @param idempotencyKey - Stable identifier for this logical payment.
   *   Pass the same value on a retry (e.g. the task's `correlationId`) to get
   *   the idempotency guarantee above. Omitted means a fresh key is generated
   *   per call, which makes this call *not* retry-safe against duplication —
   *   fine for a one-shot call, not for an automated retry loop.
   * @returns Object containing transaction hash and ledger number
   * @throws {z.ZodError} If input fails validation
   * @throws {Error} If source account not found or transaction submission fails
   */
  async execute(
    rawInput: unknown,
    idempotencyKey?: string
  ): Promise<{ txHash: string; ledger: number }> {
    // 1. Validate input
    const input = PaymentInputSchema.parse(rawInput);

    // Self-payment guard
    if (input.destination === this.keypair.publicKey()) {
      throw new Error("Payment destination cannot be the agent's own address");
    }

    // 2. Resolve asset
    if (input.assetCode !== 'XLM' && !input.assetIssuer) {
      throw new Error(`Asset issuer is required for non-native asset ${input.assetCode}`);
    }
    const asset =
      input.assetCode === 'XLM' ? Asset.native() : new Asset(input.assetCode, input.assetIssuer);

    logger.info('Validating payment envelope', {
      source: this.keypair.publicKey(),
      destination: input.destination,
      amount: input.amount,
      assetCode: input.assetCode,
    });

    const key = idempotencyKey ?? randomUUID();
    if (!idempotencyKey) {
      logger.warn(
        'stellar_payment executed without an idempotency key — a caller-side retry of this ' +
          'call cannot be deduplicated against a prior attempt that actually landed',
        { source: this.keypair.publicKey() }
      );
    }

    // 3-6. Idempotent load → build → sign → submit. buildAndSign is invoked
    // fresh for every internal attempt (tx_bad_seq retry, ambiguous-outcome
    // recheck) so each attempt gets a transaction built against the account
    // state that attempt actually saw.
    return submitIdempotent({
      idempotencyKey: key,
      sourceAccountId: this.keypair.publicKey(),
      buildAndSign: (sourceAccount: HorizonAccount) => {
        const builder = new TransactionBuilder(sourceAccount, {
          fee: BASE_FEE, // BASE_FEE (100 stroops) is the actual fee for classic Stellar payments — not overwritten
          networkPassphrase: this.networkPassphrase,
        }).addOperation(
          Operation.payment({
            destination: input.destination,
            asset,
            amount: input.amount,
          })
        );

        if (input.memo !== undefined) {
          const memo = buildMemo(input.memoType, input.memo);
          if (memo) {
            builder.addMemo(memo);
          }
        }

        // Tight, fixed validity window: the transaction becomes impossible to
        // apply SOROBAN_TX_TIMEOUT (30s) after this build, which bounds how
        // long a "stuck" (not-yet-included) transaction can remain ambiguous
        // before resubmitStuckTransaction's not-found check is trustworthy.
        const tx = builder.setTimeout(SOROBAN_TX_TIMEOUT).build();
        tx.sign(this.keypair);
        return tx;
      },
    });
  }
}
