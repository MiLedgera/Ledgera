/**
 * backend/tools/PathPaymentTool.ts
 * Cross-asset path payment via Stellar's pathPaymentStrictSend operation.
 * Enables sending one asset and having the recipient receive a different asset
 * through the Stellar DEX (e.g., send XLM, recipient receives USDC).
 */

import { Keypair, TransactionBuilder, Operation, Asset, BASE_FEE } from '@stellar/stellar-sdk';
import { z } from 'zod';
import { config } from '../config';
import { logger } from '../logger';
import {
  horizonServer,
  loadAccount,
  resolveNetworkPassphrase,
  submitTransaction,
} from '../rpc_client';
import { ValidationError } from '../errors';
import { createLogger } from '../utils/logger';
import { SubmitResultSchema } from './StellarPaymentTool';
import { buildMemo } from './memo';

const log = createLogger('path-payment');

// ─── Input schema ─────────────────────────────────────────────────────────────

const AssetSchema = z.object({
  code: z.string(),
  issuer: z.string().optional(),
});

export const PathPaymentInputSchema = z.object({
  destination: z.string().length(56, 'Invalid Stellar public key'),
  sendAsset: AssetSchema,
  sendAmount: z
    .string()
    .regex(/^(?!0(\.0+)?$)\d+(\.\d{1,7})?$/, 'sendAmount must be a valid Stellar decimal')
    .refine((v) => parseFloat(v) > 0, 'sendAmount must be greater than zero'),
  destAsset: AssetSchema,
  destMinAmount: z
    .string()
    .regex(/^(?!0(\.0+)?$)\d+(\.\d{1,7})?$/, 'destMinAmount must be a valid Stellar decimal')
    .refine((v) => parseFloat(v) > 0, 'destMinAmount must be greater than zero'),
  path: z.array(AssetSchema).optional().default([]),
  allowSelfPayment: z.boolean().optional().default(false),
  memoType: z.enum(['text', 'id', 'hash', 'return']).optional().default('text'),
  memo: z.union([z.string(), z.number()]).optional(),
});

export type PathPaymentInput = z.infer<typeof PathPaymentInputSchema>;

// ─── Helper ───────────────────────────────────────────────────────────────────

function toAsset(a: { code: string; issuer?: string | undefined }): Asset {
  if (a.code === 'XLM') return Asset.native();
  if (!a.issuer) {
    throw new Error(`Asset issuer is required for non-native asset ${a.code}`);
  }
  return new Asset(a.code, a.issuer);
}

// ─── Tool implementation ──────────────────────────────────────────────────────

export class PathPaymentTool {
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
    const input = PathPaymentInputSchema.parse(rawInput);

    if (!input.allowSelfPayment && input.destination === this.keypair.publicKey()) {
      throw new Error("Payment destination cannot be the agent's own address");
    }

    const sendAsset = toAsset(input.sendAsset);
    const destAsset = toAsset(input.destAsset);
    let pathAssets = input.path.map(toAsset);

    if (pathAssets.length === 0 && typeof (horizonServer as any)?.strictSendPaths === 'function') {
      const paths = await horizonServer
        .strictSendPaths(sendAsset, input.sendAmount, [destAsset])
        .call();
      if (!paths || !paths.records || paths.records.length === 0) {
        throw new ValidationError('No path found between assets');
      }
      const bestRecord = paths.records[0];
      if (bestRecord && Array.isArray(bestRecord.path)) {
        pathAssets = bestRecord.path.map((p: any) => {
          if (p.asset_type === 'native' || p.code === 'XLM') return Asset.native();
          return new Asset(p.asset_code || p.code, p.asset_issuer || p.issuer);
        });
      }
    }

    let sourceAccount = await loadAccount(this.keypair.publicKey());

    const buildTx = () => {
      const builder = new TransactionBuilder(sourceAccount, {
        fee: BASE_FEE,
        networkPassphrase: this.networkPassphrase,
      }).addOperation(
        Operation.pathPaymentStrictSend({
          sendAsset,
          sendAmount: input.sendAmount,
          destination: input.destination,
          destAsset,
          destMin: input.destMinAmount,
          path: pathAssets,
        })
      );

      if (input.memo !== undefined) {
        const memo = buildMemo(input.memoType, input.memo);
        if (memo) {
          builder.addMemo(memo);
        }
      }

      return builder.setTimeout(30).build();
    };

    logger.info('Executing path payment', {
      source: this.keypair.publicKey(),
      destination: input.destination,
      sendAmount: input.sendAmount,
      sendAsset: input.sendAsset.code,
      destAsset: input.destAsset.code,
      destMinAmount: input.destMinAmount,
    });

    let tx = buildTx();
    tx.sign(this.keypair);

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
