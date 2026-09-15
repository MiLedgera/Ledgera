/**
 * backend/tools/MemoAttachmentTool.ts
 * Shared memo construction utility with byte-length validation.
 */

import { Memo } from '@stellar/stellar-sdk';
import { ValidationError } from '../errors';

// Re-exported so existing importers keep working — this module previously
// declared its own local ValidationError class, distinct from backend/errors.ts's.
// That meant an error thrown from here was invisible to middleware/error_handler.ts's
// `instanceof StructuredError` check and got misclassified as a 500 instead of a
// 400 at any HTTP boundary that used it (audit finding Q-3).
export { ValidationError };

export type MemoType = 'MEMO_TEXT' | 'MEMO_HASH' | 'MEMO_ID' | 'MEMO_RETURN';

export interface MemoOptions {
  type: MemoType;
  value: string;
}

/**
 * Builds and validates a Stellar Memo object based on type and value.
 * Throws ValidationError on byte-length overflow or invalid format.
 */
export function buildMemo(options: MemoOptions): Memo {
  const { type, value } = options;

  switch (type) {
    case 'MEMO_TEXT': {
      const byteLength = Buffer.byteLength(value, 'utf8');
      if (byteLength > 28) {
        throw new ValidationError(
          `MEMO_TEXT exceeds maximum length of 28 bytes (got ${byteLength} bytes)`
        );
      }
      return Memo.text(value);
    }
    case 'MEMO_HASH': {
      const hexPattern = /^[0-9a-fA-F]{64}$/;
      if (!hexPattern.test(value)) {
        if (/^[0-9a-fA-F]*$/.test(value) && value.length !== 64) {
          throw new ValidationError(
            `MEMO_HASH must be a 32-byte hex string (64 characters, got ${value.length})`
          );
        }
        throw new ValidationError('MEMO_HASH must be a valid hex string');
      }
      const buffer = Buffer.from(value, 'hex');
      if (buffer.length !== 32) {
        throw new ValidationError('MEMO_HASH must be exactly 32 bytes');
      }
      return Memo.hash(buffer);
    }
    case 'MEMO_ID': {
      if (!/^\d+$/.test(value)) {
        throw new ValidationError('MEMO_ID must be a numeric string');
      }
      try {
        const bigIntValue = BigInt(value);
        if (bigIntValue < 0n || bigIntValue > 18446744073709551615n) {
          throw new ValidationError('MEMO_ID value out of 64-bit unsigned integer range');
        }
      } catch (err: any) {
        if (err instanceof ValidationError) throw err;
        throw new ValidationError('MEMO_ID invalid numeric value');
      }
      return Memo.id(value);
    }
    case 'MEMO_RETURN': {
      const hexPattern = /^[0-9a-fA-F]{64}$/;
      if (!hexPattern.test(value)) {
        if (/^[0-9a-fA-F]*$/.test(value) && value.length !== 64) {
          throw new ValidationError(
            `MEMO_RETURN must be a 32-byte hex string (64 characters, got ${value.length})`
          );
        }
        throw new ValidationError('MEMO_RETURN must be a valid hex string');
      }
      const buffer = Buffer.from(value, 'hex');
      if (buffer.length !== 32) {
        throw new ValidationError('MEMO_RETURN must be exactly 32 bytes');
      }
      // Memo.return() takes the hex string form, not the decoded Buffer —
      // the buffer above exists only to validate the byte length.
      return Memo.return(value);
    }
    default: {
      throw new ValidationError(`Unsupported memo type: ${(options as any).type}`);
    }
  }
}
