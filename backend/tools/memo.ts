/**
 * backend/tools/memo.ts
 *
 * Shared memo-building helper for Horizon Classic payment tools that accept
 * a `memoType` ("text" | "id" | "hash" | "return") + `memoValue` pair
 * straight from their Zod-validated input schema (StellarPaymentTool,
 * PathPaymentTool). Extracted from two byte-for-byte identical copies of
 * this function (see audit finding Q-3).
 *
 * `MemoAttachmentTool.ts` intentionally does not share this implementation:
 * it accepts a different input shape (`{ type: "MEMO_TEXT" | ...; value: string }`)
 * for a different caller (x402 memo derivation from a raw hex string) and
 * always throws `ValidationError` rather than returning `null`/plain `Error`.
 */

import { Memo } from '@stellar/stellar-sdk';

/**
 * Build a Stellar Memo object based on memoType and value.
 *
 * @param memoType - Type of memo: "text", "id", "hash", or "return"
 * @param memoValue - Memo value (string for text/return/hash, number for id)
 * @returns Memo instance or null if memoValue is undefined
 */
export function buildMemo(memoType: string, memoValue: string | number | undefined): Memo | null {
  if (memoValue === undefined) {
    return null;
  }

  switch (memoType) {
    case 'id': {
      if (typeof memoValue !== 'number') {
        throw new Error('Memo ID must be a number');
      }
      // Convert to unsigned 64-bit integer
      const id = BigInt(memoValue);
      if (id < 0n || id > 18446744073709551615n) {
        throw new Error('Memo ID must be a 64-bit unsigned integer (0 to 2^64-1)');
      }
      return Memo.id(id.toString());
    }
    case 'hash': {
      if (typeof memoValue !== 'string') {
        throw new Error('Memo hash must be a string');
      }
      // Remove 0x prefix if present and validate length
      const hashHex = memoValue.replace(/^0x/, '');
      if (hashHex.length !== 64) {
        throw new Error('Memo hash must be a 32-byte hex string (64 hex characters)');
      }
      if (!/^[0-9a-fA-F]{64}$/.test(hashHex)) {
        throw new Error('Memo hash must contain only valid hex characters');
      }
      return Memo.hash(hashHex);
    }
    case 'return': {
      if (typeof memoValue !== 'string') {
        throw new Error('Memo return must be a string');
      }
      // Remove 0x prefix if present and validate length
      const returnHex = memoValue.replace(/^0x/, '');
      if (returnHex.length !== 64) {
        throw new Error('Memo return must be a 32-byte hex string (64 hex characters)');
      }
      if (!/^[0-9a-fA-F]{64}$/.test(returnHex)) {
        throw new Error('Memo return must contain only valid hex characters');
      }
      return Memo.return(returnHex);
    }
    case 'text':
    default: {
      if (typeof memoValue !== 'string') {
        throw new Error('Memo text must be a string');
      }
      if (Buffer.byteLength(memoValue, 'utf8') > 28) {
        throw new Error('Memo text must be at most 28 bytes');
      }
      return Memo.text(memoValue);
    }
  }
}
