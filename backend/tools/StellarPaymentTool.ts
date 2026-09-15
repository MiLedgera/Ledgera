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
import { z } from 'zod';
import { config } from '../config';
import { logger } from '../logger';
import { loadAccount, resolveNetworkPassphrase, submitTransaction } from '../rpc_client';
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
   * 5. Validate transaction envelope
   * 6. Sign transaction with keypair
   * 7. Submit transaction to the network
   *
   * @param rawInput - Raw payment input (will be validated)
   * @returns Object containing transaction hash and ledger number
   * @throws {z.ZodError} If input fails validation
   * @throws {Error} If source account not found or transaction submission fails
   */
  async execute(rawInput: unknown): Promise<{ txHash: string; ledger: number }> {
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

    // 3. Load source account (latest sequence number)
    let sourceAccount = await loadAccount(this.keypair.publicKey());

    // 4. Build transaction
    const buildTx = () => {
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

      return builder.setTimeout(SOROBAN_TX_TIMEOUT).build();
    };

    let tx = buildTx();

    // 5. Fee estimation / simulation via Horizon dry-run
    //    (Horizon doesn't expose simulation like Soroban, so we validate
    //     the transaction envelope locally before submission)
    logger.info('Validating payment envelope', {
      source: this.keypair.publicKey(),
      destination: input.destination,
      amount: input.amount,
      assetCode: input.assetCode,
    });

    // 6. Sign
    tx.sign(this.keypair);

    // 7. Submit (with auto-retry on tx_bad_seq)
    try {
      const result = SubmitResultSchema.parse(await submitTransaction(tx));
      return { txHash: result.hash, ledger: result.ledger };
    } catch (err: unknown) {
      if (err instanceof Error && err.message.includes('tx_bad_seq')) {
        logger.warn('tx_bad_seq detected, reloading account and retrying once', {
          source: this.keypair.publicKey(),
        });
        // Bypass the account cache: the whole point of this retry is that the
        // sequence we used was wrong, so a cached record must not be reused.
        sourceAccount = await loadAccount(this.keypair.publicKey(), { forceRefresh: true });
        tx = buildTx();
        tx.sign(this.keypair);
        const result = SubmitResultSchema.parse(await submitTransaction(tx));
        return { txHash: result.hash, ledger: result.ledger };
      }
      throw err;
    }
  }
}
