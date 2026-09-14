/**
 * backend/rpc_client.ts
 * Thin wrapper around Horizon + Soroban RPC with retry logic and rate-limit awareness.
 */

import {
  Horizon,
  Networks,
  rpc,
  Transaction,
  FeeBumpTransaction,
  xdr,
  StrKey,
} from '@stellar/stellar-sdk';
import { randomUUID } from 'crypto';
import CircuitBreaker from 'opossum';
import { ZodError } from 'zod';
import { config } from './config';
import {
  sanitizeCause,
  SimulationBudgetError,
  UnauthorizedError,
  ConfigError,
  ContractError,
} from './errors';
import { logger } from './logger';
import { validateXDR } from './types/xdr';
import { createLogger } from './utils/logger';
import { isThrottled, handleRateLimitResponse, withBackoffGuard } from './network';
import { withSpan } from './telemetry';

const log = createLogger('rpc-client');
// Exported so the breaker's behaviour can be asserted against the real
// thresholds rather than a copy that silently drifts from them (#244).
export const RPC_BREAKER_OPTIONS = {
  errorThresholdPercentage: 50,
  resetTimeout: 30_000,
  timeout: 10_000,
  volumeThreshold: 5,
  rollingCountTimeout: 30_000,
  rollingCountBuckets: 10,
};

class RpcServiceUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RpcServiceUnavailableError';
  }
}

type HorizonAccount = Awaited<ReturnType<Horizon.Server['loadAccount']>>;
type HorizonSubmitResult = Awaited<ReturnType<Horizon.Server['submitTransaction']>>;
type SorobanSimulationResult = Awaited<ReturnType<rpc.Server['simulateTransaction']>>;

type CachedAccount = { account: HorizonAccount; expiresAt: number };

// Keyed by public key. Entries carry their own expiry rather than relying on a
// sweep, so a key that is never read again simply goes stale in place instead
// of being served indefinitely.
const accountCache = new Map<string, CachedAccount>();

/** Drop a cached account, or the whole cache when no key is given. */
export function invalidateAccountCache(publicKey?: string): void {
  if (publicKey === undefined) {
    accountCache.clear();
    return;
  }
  accountCache.delete(publicKey);
}

// opossum's Status class exposes no public API to clear its rolling stats
// window, so a closed breaker keeps stale failure counts that can trip it
// back open on the very next request. Zero the buckets directly.
function resetBreakerStats<TArgs extends unknown[], TResult>(
  breaker: CircuitBreaker<TArgs, TResult>
): void {
  const status = breaker.status as unknown as Record<string | symbol, unknown>;
  const windowSymbol = Object.getOwnPropertySymbols(status).find(
    (s) => s.toString() === 'Symbol(window)'
  );
  if (!windowSymbol) return;

  const window = status[windowSymbol] as Array<Record<string, unknown>> | undefined;
  if (!window) return;

  for (const bucket of window) {
    bucket.failures = 0;
    bucket.fallbacks = 0;
    bucket.successes = 0;
    bucket.rejects = 0;
    bucket.fires = 0;
    bucket.timeouts = 0;
    bucket.cacheHits = 0;
    bucket.cacheMisses = 0;
    bucket.semaphoreRejections = 0;
    bucket.percentiles = {};
    bucket.latencyTimes = [];
  }
}

export function attachBreakerTelemetry<TArgs extends unknown[], TResult>(
  breaker: CircuitBreaker<TArgs, TResult>,
  name: string
): CircuitBreaker<TArgs, TResult> {
  breaker.on('open', () => {
    log.warn(
      {
        circuit: name,
        failures: breaker.stats.failures,
        successes: breaker.stats.successes,
        timeout: RPC_BREAKER_OPTIONS.timeout,
        resetTimeout: RPC_BREAKER_OPTIONS.resetTimeout,
      },
      'RPC circuit opened'
    );
  });

  breaker.on('halfOpen', () => {
    log.info(
      {
        circuit: name,
      },
      'RPC circuit half-open'
    );
  });

  breaker.on('close', () => {
    resetBreakerStats(breaker);
    log.info(
      {
        circuit: name,
        failures: breaker.stats.failures,
        successes: breaker.stats.successes,
      },
      'RPC circuit closed'
    );
  });

  return breaker;
}

export function createRpcBreaker<TArgs extends unknown[], TResult>(
  name: string,
  action: (...args: TArgs) => Promise<TResult>
): CircuitBreaker<TArgs, TResult> {
  return attachBreakerTelemetry(
    new CircuitBreaker(action, {
      ...RPC_BREAKER_OPTIONS,
      name,
    }),
    name
  );
}

export function resolveNetworkPassphrase(network: string): string {
  if (network === 'mainnet') return Networks.PUBLIC;
  if (network === 'futurenet') return Networks.FUTURENET;
  if (network === 'testnet') return Networks.TESTNET;
  throw new ConfigError(`Unsupported network: ${network}`);
}

export class TimeoutError extends Error {
  constructor(ms: number) {
    super(`Transaction Timeout: request did not complete within ${ms}ms`);
    this.name = 'TimeoutError';
  }
}

export class StellarRPCError extends Error {
  readonly cause: unknown;
  constructor(message: string, cause: unknown) {
    super(message);
    this.name = 'StellarRPCError';
    this.cause = sanitizeCause(cause);
  }
}

export class RateLimitError extends Error {
  readonly retryAfterSeconds: number;
  constructor(retryAfterSeconds: number) {
    super(`Rate limited. Retry after ${retryAfterSeconds} seconds`);
    this.name = 'RateLimitError';
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

const SUBMIT_TIMEOUT_MS = 30_000;

export function DEFAULT_IS_RETRYABLE(err: unknown): boolean {
  if (err instanceof ZodError) return false;
  if (err instanceof TypeError) return false;
  if (err instanceof RateLimitError) return true;
  if (
    err instanceof Error &&
    (err.message.includes('budget_exceeded') || err.message.includes('simulation failed'))
  ) {
    return false;
  }
  return true;
}

// Horizon/Soroban clients surface the underlying HTTP response as an
// axios-style `response.headers` object on the thrown error.
function extractRetryAfterHeader(err: Error): string | null {
  const response = (err as { response?: { headers?: Record<string, string> } }).response;
  return response?.headers?.['retry-after'] ?? null;
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  retries = config.MAX_RETRIES,
  delayMs = config.RETRY_DELAY_MS,
  isRetryable: (err: unknown) => boolean = DEFAULT_IS_RETRYABLE,
  maxDelayMs = 30_000
): Promise<T> {
  return withSpan(
    'withRetry',
    async () => {
      let lastErr: unknown;
      for (let attempt = 1; attempt <= retries; attempt++) {
        logger.debug(`[withRetry] Attempt ${attempt}/${retries}: calling...`);
        try {
          // Check backoff before each attempt
          if (isThrottled()) {
            throw new RateLimitError(30);
          }
          return await fn();
        } catch (err) {
          // Detect 429 from Horizon/Soroban responses
          if (err instanceof Error && err.message.includes('429')) {
            handleRateLimitResponse(extractRetryAfterHeader(err));
            lastErr = new RateLimitError(30);
          } else {
            lastErr = err;
          }

          if (!isRetryable(err) && !(err instanceof RateLimitError)) {
            throw err;
          }

          logger.warn('Retry attempt failed', {
            attempt,
            maxRetries: retries,
            error: (err as Error).message,
          });

          if (attempt < retries) {
            const exponential = delayMs * Math.pow(2, attempt - 1);
            const capped = Math.min(exponential, maxDelayMs);
            const jitter = Math.random() * 0.2 * capped;
            await new Promise((r) => setTimeout(r, capped + jitter));
          }
        }
      }
      const lastErrorMessage =
        lastErr instanceof Error ? lastErr.message : String(lastErr ?? 'unknown error');
      throw new StellarRPCError(
        `RPC call failed after ${retries} attempt(s): ${lastErrorMessage}`,
        lastErr
      );
    },
    { 'rpc.maxRetries': retries }
  );
}

export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const id = setTimeout(() => reject(new TimeoutError(ms)), ms);
    promise.then(
      (value) => {
        clearTimeout(id);
        resolve(value);
      },
      (err) => {
        clearTimeout(id);
        reject(err);
      }
    );
  });
}

function createHorizonServer(): Horizon.Server {
  const requestId = randomUUID();
  return new Horizon.Server(config.HORIZON_URL, {
    allowHttp: config.STELLAR_NETWORK === 'testnet' || config.STELLAR_NETWORK === 'futurenet',
    headers: {
      'X-Request-ID': requestId,
    },
  });
}

export const horizonServer = createHorizonServer();

/**
 * Load a Horizon account, serving a cached copy when one is still fresh.
 *
 * **The cache is bypassed with `forceRefresh` on the sequence-recovery paths,
 * and cleared after every submission.** A Horizon account carries the source
 * sequence number, and `TransactionBuilder` increments it in place while
 * building. Serving one cached record to two builders would hand out the same
 * (or a locally-drifted) sequence, which is the `tx_bad_seq` failure this cache
 * is meant to reduce. Anything that can move the sequence therefore drops the
 * entry — the cache exists to collapse bursts of *read-only* lookups
 * (balances, trustlines, account info), not to survive a transaction.
 */
export async function loadAccount(
  publicKey: string,
  options?: { forceRefresh?: boolean }
): Promise<HorizonAccount> {
  const ttl = config.ACCOUNT_CACHE_TTL_MS;

  if (options?.forceRefresh) {
    accountCache.delete(publicKey);
  } else if (ttl > 0) {
    const cached = accountCache.get(publicKey);
    // Compare against the read time, not the write time: an entry is stale the
    // instant it passes expiresAt, even if it was only just written.
    if (cached && cached.expiresAt > Date.now()) {
      return cached.account;
    }
    // Expired entries are removed on the miss that finds them, so a failed
    // refresh below cannot leave a stale record behind to be served later.
    if (cached) accountCache.delete(publicKey);
  }

  const account = await withBackoffGuard(() =>
    withTimeout(
      withRetry(
        () => horizonServer.loadAccount(publicKey),
        config.MAX_RETRIES,
        config.RETRY_DELAY_MS,
        DEFAULT_IS_RETRYABLE
      ),
      config.RPC_TIMEOUT_MS
    )
  );

  if (ttl > 0) {
    accountCache.set(publicKey, { account, expiresAt: Date.now() + ttl });
  }

  return account;
}

export async function submitTransaction(tx: Transaction | FeeBumpTransaction) {
  validateXDR(tx.toEnvelope().toXDR('base64'));

  // Any submission may move the source account's sequence forward, and a failed
  // one leaves it uncertain, so no cached record survives a submit attempt.
  // Clearing every key (rather than just the source) keeps this correct for
  // fee-bump and multi-signer envelopes without having to unpick which account
  // actually advanced.
  try {
    return await withBackoffGuard(() =>
      withRetry(() => {
        const controller = new AbortController();
        let timeoutId: ReturnType<typeof setTimeout>;
        const timeoutPromise = new Promise<never>((_, reject) => {
          timeoutId = setTimeout(() => {
            controller.abort();
            reject(new TimeoutError(SUBMIT_TIMEOUT_MS));
          }, SUBMIT_TIMEOUT_MS);
        });
        return Promise.race([horizonServer.submitTransaction(tx), timeoutPromise]).finally(() =>
          clearTimeout(timeoutId)
        );
      })
    );
  } finally {
    invalidateAccountCache();
  }
}

function createSorobanServer(): rpc.Server {
  const requestId = randomUUID();
  return new rpc.Server(config.SOROBAN_RPC_URL, {
    allowHttp: config.STELLAR_NETWORK === 'testnet' || config.STELLAR_NETWORK === 'futurenet',
    headers: {
      'X-Request-ID': requestId,
    },
  });
}

export const sorobanServer = createSorobanServer();

export async function simulateSorobanTx(tx: Transaction) {
  return withBackoffGuard(() =>
    withTimeout(
      withRetry(
        () => sorobanServer.simulateTransaction(tx),
        config.MAX_RETRIES,
        config.RETRY_DELAY_MS,
        DEFAULT_IS_RETRYABLE
      ),
      config.RPC_TIMEOUT_MS
    )
  );
}

function validateSorobanAuth(tx: Transaction | { operations?: Array<{ auth?: Array<unknown> }> }) {
  const operations = Array.isArray((tx as { operations?: unknown[] }).operations)
    ? ((tx as { operations?: Array<{ auth?: Array<unknown> }> }).operations ?? [])
    : [];

  for (const operation of operations) {
    const authEntries = Array.isArray(operation?.auth) ? operation.auth : [];
    for (const authEntry of authEntries) {
      const authObject = authEntry as {
        credentials?: () => {
          switch?: () => unknown;
          address?: () => {
            address?: () => {
              accountId?: () => {
                ed25519?: () => Uint8Array;
                muxedEd25519?: () => { ed25519?: () => Uint8Array };
              };
            };
          };
        };
      };

      const credentials = authObject.credentials?.();
      if (!credentials) continue;

      const hasAddressCredentials = typeof credentials.address === 'function';
      if (!hasAddressCredentials) {
        continue;
      }

      const address = credentials.address?.();
      const innerAddress = address?.address?.();
      const accountId = innerAddress?.accountId?.();
      const ed25519 = accountId?.ed25519?.();
      const muxedEd25519 = accountId?.muxedEd25519?.();
      const rawKey = ed25519 ?? muxedEd25519?.ed25519?.();

      if (!rawKey) {
        // No signer could be decoded at all, so there is nothing to report but
        // what was expected. `signer: null` distinguishes this from the
        // mismatch case below, where a real key was recovered.
        throw new UnauthorizedError('Unexpected Soroban auth signer format', {
          signer: null,
          expected: config.AGENT_PUBLIC_KEY,
        });
      }

      const signer = StrKey.encodeEd25519PublicKey(Buffer.from(rawKey));
      if (signer !== config.AGENT_PUBLIC_KEY) {
        throw new UnauthorizedError(`Unexpected Soroban auth signer: ${signer}`, {
          signer,
          expected: config.AGENT_PUBLIC_KEY,
        });
      }
    }
  }
}

/**
 * A simulated + assembled Soroban transaction alongside the diagnostic events
 * the simulation produced.
 *
 * The events are what the transaction would emit on-chain. Tools that move
 * value (e.g. contract invocations that internally call the Stellar Asset
 * Contract) inspect them to learn how much would actually be transferred
 * before signing or broadcasting — see {@link SorobanInvokeTool}.
 */
export interface PreparedSorobanTx {
  /** The transaction with the Soroban resource footprint attached. */
  tx: Transaction;
  /** Diagnostic events predicted by the simulation, in XDR form. */
  events: xdr.DiagnosticEvent[];
  /**
   * The host function's return value, when the invocation simulates one
   * (e.g. `uploadContractWasm`'s wasm hash, `createCustomContract`'s new
   * contract address). Undefined for operations with no return value.
   */
  retval?: xdr.ScVal | undefined;
}

export async function prepareSorobanTxWithEvents(tx: Transaction): Promise<PreparedSorobanTx> {
  const simResult = await simulateSorobanTx(tx);
  if (rpc.Api.isSimulationError(simResult)) {
    const simError = (simResult as { error?: string }).error ?? '';
    if (simError.includes('budget_exceeded')) {
      throw new SimulationBudgetError(`Soroban simulation failed: ${simError}`);
    }
    throw new ContractError(`Soroban simulation failed: ${simError}`, undefined, simError);
  }

  const builtTx = rpc.assembleTransaction(tx, simResult).build();
  validateSorobanAuth(builtTx as Transaction | { operations?: Array<{ auth?: Array<unknown> }> });

  return { tx: builtTx, events: simResult.events ?? [], retval: simResult.result?.retval };
}

export async function prepareSorobanTx(tx: Transaction): Promise<Transaction> {
  return (await prepareSorobanTxWithEvents(tx)).tx;
}
