/**
 * tests/errors.test.ts
 *
 * Tests for structured error types in backend/errors.ts
 */

import { describe, it, expect } from 'vitest';
import {
  StructuredError,
  ErrorType,
  InsufficientFundsError,
  NetworkTimeoutError,
  ValidationError,
  RateLimitError,
  UnauthorizedError,
  ContractError,
  TransactionFailureError,
  ConfigError,
  getErrorType,
  sanitizeCause,
} from '../backend/errors';

describe('Structured Error Types', () => {
  it('creates an InsufficientFundsError with correct type', () => {
    const error = new InsufficientFundsError('Not enough funds');
    expect(error).toBeInstanceOf(StructuredError);
    expect(error.errorType).toBe(ErrorType.InsufficientFunds);
    expect(error.message).toBe('Not enough funds');
  });

  it('creates a NetworkTimeoutError with correct type', () => {
    const error = new NetworkTimeoutError('Request timed out');
    expect(error).toBeInstanceOf(StructuredError);
    expect(error.errorType).toBe(ErrorType.NetworkTimeout);
    expect(error.message).toBe('Request timed out');
  });

  it('creates a ValidationError with correct type', () => {
    const error = new ValidationError('Invalid input');
    expect(error).toBeInstanceOf(StructuredError);
    expect(error.errorType).toBe(ErrorType.ValidationError);
    expect(error.message).toBe('Invalid input');
  });

  it('creates a RateLimitError with retryAfterSeconds', () => {
    const error = new RateLimitError('Rate limited', 30);
    expect(error).toBeInstanceOf(StructuredError);
    expect(error.errorType).toBe(ErrorType.RateLimitError);
    expect(error.retryAfterSeconds).toBe(30);
    expect(error.message).toBe('Rate limited');
  });

  it('creates an UnauthorizedError with correct type', () => {
    const error = new UnauthorizedError('Access denied');
    expect(error).toBeInstanceOf(StructuredError);
    expect(error.errorType).toBe(ErrorType.UnauthorizedError);
    expect(error.message).toBe('Access denied');
  });

  it('creates a ContractError with contractId', () => {
    const contractId = 'CDPVBHPSVYKWSI5ECEA4DASBG3RBNU5EHEE3DHNFX7RMBCZV66CSC7NH';
    const error = new ContractError('Contract execution failed', contractId);
    expect(error).toBeInstanceOf(StructuredError);
    expect(error.errorType).toBe(ErrorType.ContractError);
    expect(error.contractId).toBe(contractId);
  });

  it('creates a TransactionFailureError with txHash', () => {
    const txHash = 'abcd1234';
    const error = new TransactionFailureError('Transaction failed', txHash);
    expect(error).toBeInstanceOf(StructuredError);
    expect(error.errorType).toBe(ErrorType.TransactionFailure);
    expect(error.txHash).toBe(txHash);
  });

  it('creates a ConfigError with correct type', () => {
    const error = new ConfigError('Missing required config');
    expect(error).toBeInstanceOf(StructuredError);
    expect(error.errorType).toBe(ErrorType.ConfigError);
  });

  it('preserves cause when provided', () => {
    const cause = new Error('Original error');
    const error = new InsufficientFundsError('Wrapped error', cause);
    expect(error.cause).toBe(cause);
  });

  it('getErrorType returns correct error type for StructuredError', () => {
    const error = new ValidationError('test');
    expect(getErrorType(error)).toBe(ErrorType.ValidationError);
  });

  it('getErrorType returns UNKNOWN_ERROR for non-StructuredError', () => {
    const error = new Error('generic error');
    expect(getErrorType(error)).toBe(ErrorType.UnknownError);
  });

  it('getErrorType returns UNKNOWN_ERROR for non-Error objects', () => {
    expect(getErrorType('string error')).toBe(ErrorType.UnknownError);
    expect(getErrorType(null)).toBe(ErrorType.UnknownError);
    expect(getErrorType(undefined)).toBe(ErrorType.UnknownError);
  });
});

describe('sanitizeCause', () => {
  it('strips secretKey from a plain object', () => {
    const cause = { secretKey: 'SASECRET', accountId: 'GABC' };
    const result = sanitizeCause(cause) as Record<string, unknown>;
    expect(result.secretKey).toBeUndefined();
    expect(result.accountId).toBe('GABC');
  });

  it('strips privateKey, seed, and _secretKey', () => {
    const cause = { privateKey: 'a', seed: 'b', _secretKey: 'c', safe: 'd' };
    const result = sanitizeCause(cause) as Record<string, unknown>;
    expect(result.privateKey).toBeUndefined();
    expect(result.seed).toBeUndefined();
    expect(result._secretKey).toBeUndefined();
    expect(result.safe).toBe('d');
  });

  it('strips sensitive keys nested inside objects and arrays', () => {
    const cause = { nested: { secretKey: 'x' }, list: [{ seed: 'y' }] };
    const result = sanitizeCause(cause) as {
      nested: { secretKey?: string };
      list: Array<{ seed?: string }>;
    };
    expect(result.nested.secretKey).toBeUndefined();
    expect(result.list[0]!.seed).toBeUndefined();
  });

  it('passes through primitives and non-object causes unchanged', () => {
    expect(sanitizeCause('plain string')).toBe('plain string');
    expect(sanitizeCause(null)).toBeNull();
    expect(sanitizeCause(undefined)).toBeUndefined();
    expect(sanitizeCause(42)).toBe(42);
  });

  // Audit finding S-3: the previous exact-match allow-list
  // (secretKey/privateKey/seed/_secretKey) missed field names it didn't
  // enumerate up front, such as SponsoredAccountTool's `newAccountSecret`.
  // sanitizeCause is now pattern-based, matching agent.ts's sanitizePayload().
  it('strips field names not covered by the old exact-match list, e.g. newAccountSecret', () => {
    const cause = { newAccountSecret: 'SASECRET', newAccountPublicKey: 'GABC', mnemonic: 'x' };
    const result = sanitizeCause(cause) as Record<string, unknown>;
    expect(result.newAccountSecret).toBeUndefined();
    expect(result.mnemonic).toBeUndefined();
    // Collateral over-redaction is the accepted tradeoff of pattern matching:
    // "PublicKey" contains "key" and gets stripped even though it's not
    // sensitive — consistent with sanitizePayload()'s existing behaviour.
    expect(result.newAccountPublicKey).toBeUndefined();
  });
});
