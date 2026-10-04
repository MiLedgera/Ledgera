/**
 * backend/tools/FriendBotTool.ts
 * Tool for programmatically funding testnet / futurenet accounts via Friendbot.
 */

import { z } from 'zod';
import { config } from '../config';
import { PolicyError } from '../errors';
import { createLogger } from '../utils/logger';

const log = createLogger('friendbot-tool');

// ─── Input Schema ─────────────────────────────────────────────────────────────

export const FriendBotInputSchema = z.object({
  /** 56-character Stellar public key (G… encoding). */
  publicKey: z
    .string()
    .length(56, 'Must be a 56-character Stellar public key (G…)')
    .refine((val) => val.startsWith('G'), { message: 'Public key must start with G' }),
});

export type FriendBotInput = z.infer<typeof FriendBotInputSchema>;

export interface FriendBotResult {
  funded: boolean;
  txHash?: string;
}

// ─── Tool Class ───────────────────────────────────────────────────────────────

export class FriendBotTool {
  /**
   * Request Friendbot test account funding.
   * Throws PolicyError if invoked on mainnet.
   */
  async execute(rawInput: unknown): Promise<FriendBotResult> {
    const input = FriendBotInputSchema.parse(rawInput);

    if (config.STELLAR_NETWORK === 'mainnet') {
      throw new PolicyError('Friendbot funding is not available on mainnet');
    }

    log.info(
      { publicKey: input.publicKey, network: config.STELLAR_NETWORK },
      'Requesting Friendbot account funding'
    );

    const baseUrl =
      config.STELLAR_NETWORK === 'futurenet'
        ? 'https://friendbot-futurenet.stellar.org'
        : 'https://friendbot.stellar.org';

    const url = `${baseUrl}?addr=${encodeURIComponent(input.publicKey)}`;

    const response = await fetch(url);
    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      throw new Error(`Friendbot request failed with status ${response.status}: ${errorText}`);
    }

    const json: any = await response.json();
    const txHash: string | undefined = json.hash ?? json.txHash;

    log.info({ publicKey: input.publicKey, txHash }, 'Friendbot account funding succeeded');

    return {
      funded: true,
      ...(txHash ? { txHash } : {}),
    };
  }
}
