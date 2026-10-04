/**
 * backend/errors.ts
 *
 * Typed error classes for tool failures and system errors.
 * Allows callers to programmatically distinguish between error types
 * rather than relying on brittle string matching.
 */

export enum ErrorType {
  InsufficientFunds = 'INSUFFICIENT_FUNDS',
  NetworkTimeout = 'NETWORK_TIMEOUT',
  ValidationError = 'VALIDATION_ERROR',
  RateLimitError = 'RATE_LIMIT_ERROR',
  UnauthorizedError = 'UNAUTHORIZED_ERROR',
  ContractError = 'CONTRACT_ERROR',
  TransactionFailure = 'TRANSACTION_FAILURE',
  ConfigError = 'CONFIG_ERROR',
  /**
   * A business-rule rejection: the request was well-formed and the network
   * was reachable, but a policy the agent enforces on itself (spending caps,
   * mainnet safety limits, x402 origin/nonce/rate-limit checks, the
   * Friendbot-mainnet guard) refused it. Distinguishes "you're not allowed
   * to do this" from a malformed request (ValidationError) or an upstream
   * failure (NetworkTimeout/TransactionFailure).
   */
  PolicyError = 'POLICY_ERROR',
  /**
   * A Soroban simulation failed, or its result was rejected before
   * broadcast (budget exceeded, fee over MAX_SOROBAN_FEE_STROOPS, no return
   * value where one was required). Distinct from TransactionFailure: nothing
   * was ever submitted to the network.
   */
  SimulationError = 'SIMULATION_ERROR',
  UnknownError = 'UNKNOWN_ERROR',
}

export class StructuredError extends Error {
  readonly errorType: ErrorType;
  readonly cause?: unknown;

  constructor(message: string, errorType: ErrorType, cause?: unknown) {
    super(message);
    this.name = this.constructor.name;
    this.errorType = errorType;
    this.cause = cause;
    Object.setPrototypeOf(this, StructuredError.prototype);
  }
}

export class InsufficientFundsError extends StructuredError {
  constructor(message: string, cause?: unknown) {
    super(message, ErrorType.InsufficientFunds, cause);
    Object.setPrototypeOf(this, InsufficientFundsError.prototype);
  }
}

export class NetworkTimeoutError extends StructuredError {
  constructor(message: string, cause?: unknown) {
    super(message, ErrorType.NetworkTimeout, cause);
    Object.setPrototypeOf(this, NetworkTimeoutError.prototype);
  }
}

export class ValidationError extends StructuredError {
  constructor(message: string, cause?: unknown) {
    super(message, ErrorType.ValidationError, cause);
    Object.setPrototypeOf(this, ValidationError.prototype);
  }
}

export class RateLimitError extends StructuredError {
  readonly retryAfterSeconds?: number | undefined;

  constructor(message: string, retryAfterSeconds?: number, cause?: unknown) {
    super(message, ErrorType.RateLimitError, cause);
    this.retryAfterSeconds = retryAfterSeconds;
    Object.setPrototypeOf(this, RateLimitError.prototype);
  }
}

export class UnauthorizedError extends StructuredError {
  constructor(message: string, cause?: unknown) {
    super(message, ErrorType.UnauthorizedError, cause);
    Object.setPrototypeOf(this, UnauthorizedError.prototype);
  }
}

export class ContractError extends StructuredError {
  readonly contractId?: string | undefined;

  constructor(message: string, contractId?: string, cause?: unknown) {
    const isContractId =
      typeof contractId === 'string' && contractId.length === 56 && contractId.startsWith('C');
    const actualContractId = isContractId
      ? contractId
      : cause !== undefined
        ? contractId
        : undefined;
    const actualCause = cause !== undefined ? cause : isContractId ? undefined : contractId;

    super(message, ErrorType.ContractError, actualCause);
    this.contractId = actualContractId;
    Object.setPrototypeOf(this, ContractError.prototype);
  }
}

export class TransactionFailureError extends StructuredError {
  readonly txHash?: string | undefined;

  constructor(message: string, txHash?: string, cause?: unknown) {
    super(message, ErrorType.TransactionFailure, cause);
    this.txHash = txHash;
    Object.setPrototypeOf(this, TransactionFailureError.prototype);
  }
}

export class ConfigError extends StructuredError {
  constructor(message: string, cause?: unknown) {
    super(message, ErrorType.ConfigError, cause);
    Object.setPrototypeOf(this, ConfigError.prototype);
  }
}

/**
 * A business-rule rejection — see {@link ErrorType.PolicyError}'s doc comment
 * for what belongs here vs. ValidationError/TransactionFailureError.
 */
export class PolicyError extends StructuredError {
  constructor(message: string, cause?: unknown) {
    super(message, ErrorType.PolicyError, cause);
    Object.setPrototypeOf(this, PolicyError.prototype);
  }
}

/**
 * A Soroban simulation failure, or a simulation result rejected before
 * broadcast. See {@link ErrorType.SimulationError}'s doc comment.
 */
export class SimulationError extends StructuredError {
  constructor(message: string, cause?: unknown) {
    super(message, ErrorType.SimulationError, cause);
    Object.setPrototypeOf(this, SimulationError.prototype);
  }
}

export class SimulationBudgetError extends SimulationError {
  constructor(message: string, cause?: unknown) {
    super(message, cause);
    Object.setPrototypeOf(this, SimulationBudgetError.prototype);
  }
}

function getErrorType(error: unknown): ErrorType {
  if (error instanceof StructuredError) {
    return error.errorType;
  }
  return ErrorType.UnknownError;
}

export { getErrorType };

// Pattern-based, not an exact-match allow-list — matches agent.ts's
// sanitizePayload() so both sanitisation layers catch the same field names.
// An exact-match set previously missed e.g. SponsoredAccountTool's
// `newAccountSecret` field, which could have survived into a logged/persisted
// cause even though sanitizePayload would have caught it on the task payload
// itself (see audit finding S-3).
const SENSITIVE_CAUSE_KEY_PATTERN = /secret|key|seed|mnemonic|private/i;

/**
 * Recursively strips keys that may carry Stellar signing material (anything
 * matching /secret|key|seed|mnemonic|private/i) from an error cause before it
 * is attached to a thrown error, so it can't be exfiltrated via
 * JSON-serialised logs/webhooks.
 */
export function sanitizeCause(cause: unknown): unknown {
  if (Array.isArray(cause)) {
    return cause.map(sanitizeCause);
  }
  if (cause !== null && typeof cause === 'object') {
    const sanitized: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(cause)) {
      if (SENSITIVE_CAUSE_KEY_PATTERN.test(key)) continue;
      sanitized[key] = sanitizeCause(value);
    }
    return sanitized;
  }
  return cause;
}
