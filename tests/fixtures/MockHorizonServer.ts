/**
 * tests/fixtures/MockHorizonServer.ts
 *
 * Shared mock of the `backend/rpc_client` module for offline (network-free) tests.
 *
 * ## Why this exists
 *
 * Many test suites (e.g. `tests/payment.test.ts`) previously each declared their
 * own inline `vi.mock("../backend/rpc_client", ...)` factory with hand-rolled
 * `vi.fn()` stubs for Horizon/Soroban interactions. That duplicated mock setup
 * across files and made it easy for the mocked module surface to drift from the
 * real `rpc_client` exports.
 *
 * `createMockHorizonServer()` centralises that setup: it returns a single object
 * that is shaped like the real `rpc_client` module and is ready to be returned
 * directly from a `vi.mock` factory:
 *
 * ```ts
 * import { createMockHorizonServer } from "./fixtures/MockHorizonServer";
 *
 * const { mockHorizonServer } = vi.hoisted(() => {
 *   const { createMockHorizonServer } = require("./fixtures/MockHorizonServer");
 *   return { mockHorizonServer: createMockHorizonServer() };
 * });
 *
 * vi.mock("../backend/rpc_client", () => mockHorizonServer);
 * ```
 *
 * The returned mock exposes the underlying `vi.fn()` mocks so tests can assert
 * on call history (`toHaveBeenCalledWith`, `toHaveBeenCalledTimes`, ...) and a
 * set of convenience configurators for the four response categories the Stellar
 * SDK surface is most commonly exercised with:
 *
 * - `loadAccount`            — source-account lookups
 * - `submitTransaction`      — payment / transaction submission
 * - `payments().forAccount()` — payment-history queries
 * - `orderbook()`            — DEX order-book queries
 *
 * Every mock is re-seeded to its default resolved/rejected value in `reset()`,
 * which is safe to call from `beforeEach`.
 */

import { vi } from 'vitest';
import { Networks } from '@stellar/stellar-sdk';

/** A Vitest mock function (`vi.fn()`). */
export type MockedFn = ReturnType<typeof vi.fn>;

/** Default sequence-bearing account fixture usable by `TransactionBuilder`. */
export function makeMockAccount(publicKey: string): Record<string, unknown> {
  return {
    id: publicKey,
    accountId: () => publicKey,
    sequenceNumber: () => '100',
    incrementSequenceNumber: vi.fn(),
    sequence: '100',
    incrementedSequenceNumber: () => '101',
    thresholds: { low_threshold: 0, med_threshold: 0, high_threshold: 0 },
    flags: { auth_required: false, auth_revocable: false, auth_immutable: false },
    balances: [{ asset_type: 'native', balance: '10000.0000000' }],
    signers: [],
    data_attr: {},
    subentry_count: 0,
    home_domain: '',
    inflation_dest: null,
  };
}

/** Shape of the per-response configuration accepted by the factory. */
export interface MockHorizonServerOverrides {
  /** Default resolved value for `loadAccount`. */
  account?: unknown;
  /** Default rejection for `loadAccount`. */
  accountError?: Error;
  /** Default resolved value for `submitTransaction`. */
  submitResult?: unknown;
  /** Default rejection for `submitTransaction`. */
  submitError?: Error;
  /** Default records returned by `payments().forAccount().call()`. */
  paymentRecords?: unknown[];
  /** Default resolved value returned by `orderbook(...).call()`. */
  orderbookResponse?: { bids: unknown[]; asks: unknown[] };
}

/**
 * A configurable mock of the `backend/rpc_client` module.
 *
 * The whole object is shaped like the real module so it can be returned from a
 * `vi.mock("../backend/rpc_client", ...)` factory, while also carrying
 * convenience accessors (`setAccount`, `setSubmitResult`, ...) and the raw mock
 * functions so tests can configure per-case responses and assert on calls.
 */
export interface MockHorizonServer {
  /** Mock of `rpc_client.loadAccount`. */
  loadAccount: MockedFn;
  /** Mock of `rpc_client.submitTransaction`. */
  submitTransaction: MockedFn;
  /** Mock of `rpc_client.getTransactionStatus`. Defaults to `{ status: 'not_found' }`. */
  getTransactionStatus: MockedFn;
  /** Mock of `rpc_client.withAccountLock`. Defaults to a pass-through (no real serialization). */
  withAccountLock: MockedFn;
  /** Nested Horizon server mock exposing `payments` / `orderbook`. */
  horizonServer: {
    /** `horizonServer.payments()` returns `{ forAccount }`. */
    payments: MockedFn;
    /** `horizonServer.orderbook(selling, buying)` returns a chainable query. */
    orderbook: MockedFn;
  };
  /** Mock of `rpc_client.sorobanServer` (unused by classic payment paths). */
  sorobanServer: Record<string, never>;
  /** Mock of `rpc_client.simulateSorobanTx`. */
  simulateSorobanTx: MockedFn;
  /** Mock of `rpc_client.prepareSorobanTx`. */
  prepareSorobanTx: MockedFn;
  /** Real network-passphrase resolver, matching `rpc_client.resolveNetworkPassphrase`. */
  resolveNetworkPassphrase: (network: string) => string;

  /** `horizonServer.payments().forAccount(pk)` mock. */
  forAccount: MockedFn;
  /** Final `.call()` on the payments query returned by `forAccount`. */
  paymentsCall: MockedFn;
  /** Final `.call()` on the order-book builder returned by `orderbook`. */
  orderbookCall: MockedFn;

  /** Configure the default `loadAccount` resolution. */
  setAccount(account: unknown): MockHorizonServer;
  /** Configure the default `loadAccount` rejection. */
  setAccountError(error: Error): MockHorizonServer;
  /** Configure the default `submitTransaction` resolution. */
  setSubmitResult(result: unknown): MockHorizonServer;
  /** Configure the default `submitTransaction` rejection. */
  setSubmitError(error: Error): MockHorizonServer;
  /** Configure the records resolved by `payments().forAccount().call()`. */
  setPaymentRecords(records: unknown[]): MockHorizonServer;
  /** Configure the response resolved by `orderbook(...).call()`. */
  setOrderbookResponse(response: { bids: unknown[]; asks: unknown[] }): MockHorizonServer;
  /** Configure the default `getTransactionStatus` resolution (default: `{ status: 'not_found' }`). */
  setTransactionStatus(result: {
    status: 'success' | 'failed' | 'not_found';
    ledger?: number;
  }): MockHorizonServer;

  /** Re-seed every mock to its configured default and clear call history. */
  reset(): void;
}

/**
 * Create a shared, configurable mock of the `backend/rpc_client` module.
 *
 * @param overrides - Optional default responses for the four supported
 * endpoints (`loadAccount`, `submitTransaction`, `payments().forAccount()`,
 * `orderbook()`). See {@link MockHorizonServerOverrides}.
 *
 * @returns A {@link MockHorizonServer} ready for use as the value of a
 * `vi.mock("../backend/rpc_client", ...)` factory.
 *
 * @example
 * ```ts
 * const server = createMockHorizonServer({
 *   submitResult: { hash: "abc123", ledger: 42 },
 * });
 * server.setAccountError(new Error("Horizon: account not found (404)"));
 * server.reset(); // restores the configured defaults for the next test
 * ```
 */
export function createMockHorizonServer(
  overrides: MockHorizonServerOverrides = {}
): MockHorizonServer {
  const { account, accountError, submitResult, submitError, paymentRecords, orderbookResponse } =
    overrides;

  const loadAccount = vi.fn();
  const submitTransaction = vi.fn();
  const simulateSorobanTx = vi.fn();
  const prepareSorobanTx = vi.fn();
  const getTransactionStatus = vi.fn();
  // Pass-through by default: callers (e.g. submitIdempotent) run fn()
  // immediately rather than being serialized, which is fine for tests that
  // don't exercise real cross-call concurrency at this layer.
  const withAccountLock = vi.fn((_key: string, fn: () => unknown) => fn());

  // Chainable payment-history query: order()/limit()/cursor() return the query
  // itself, call() resolves to the configured records.
  const paymentsCall = vi.fn();
  const paymentsQuery = {
    order: vi.fn(),
    limit: vi.fn(),
    cursor: vi.fn(),
    call: paymentsCall,
  };
  paymentsQuery.order.mockReturnValue(paymentsQuery);
  paymentsQuery.limit.mockReturnValue(paymentsQuery);
  paymentsQuery.cursor.mockReturnValue(paymentsQuery);

  // Chainable order-book builder: limit() returns the builder, call() resolves
  // to the configured bids/asks.
  const orderbookCall = vi.fn();
  const orderbookBuilder = {
    limit: vi.fn(),
    call: orderbookCall,
  };
  orderbookBuilder.limit.mockReturnValue(orderbookBuilder);

  const forAccount = vi.fn(() => paymentsQuery);
  const payments = vi.fn(() => ({ forAccount }));
  const orderbook = vi.fn(() => orderbookBuilder);

  const horizonServer = { payments, orderbook };

  const defaults = {
    account:
      account !== undefined
        ? account
        : makeMockAccount('GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5'),
    accountError: accountError,
    submitResult: submitResult !== undefined ? submitResult : { hash: 'mock_tx_hash', ledger: 1 },
    submitError: submitError,
    paymentRecords: paymentRecords !== undefined ? paymentRecords : [],
    orderbookResponse: orderbookResponse !== undefined ? orderbookResponse : { bids: [], asks: [] },
    transactionStatus: { status: 'not_found' as const },
  };

  const server: MockHorizonServer = {
    loadAccount,
    submitTransaction,
    getTransactionStatus,
    withAccountLock,
    horizonServer,
    sorobanServer: {},
    simulateSorobanTx,
    prepareSorobanTx,
    resolveNetworkPassphrase: (network: string): string => {
      if (network === 'mainnet') return Networks.PUBLIC;
      if (network === 'futurenet') return Networks.FUTURENET;
      return Networks.TESTNET;
    },
    forAccount,
    paymentsCall,
    orderbookCall,
    setAccount(next: unknown): MockHorizonServer {
      loadAccount.mockResolvedValue(next);
      return server;
    },
    setAccountError(error: Error): MockHorizonServer {
      loadAccount.mockRejectedValue(error);
      return server;
    },
    setSubmitResult(result: unknown): MockHorizonServer {
      submitTransaction.mockResolvedValue(result);
      return server;
    },
    setSubmitError(error: Error): MockHorizonServer {
      submitTransaction.mockRejectedValue(error);
      return server;
    },
    setPaymentRecords(records: unknown[]): MockHorizonServer {
      paymentsCall.mockResolvedValue({ records });
      return server;
    },
    setOrderbookResponse(response: { bids: unknown[]; asks: unknown[] }): MockHorizonServer {
      orderbookCall.mockResolvedValue(response);
      return server;
    },
    setTransactionStatus(result: {
      status: 'success' | 'failed' | 'not_found';
      ledger?: number;
    }): MockHorizonServer {
      getTransactionStatus.mockResolvedValue(result);
      return server;
    },
    reset(): void {
      vi.clearAllMocks();
      paymentsQuery.order.mockReturnValue(paymentsQuery);
      paymentsQuery.limit.mockReturnValue(paymentsQuery);
      paymentsQuery.cursor.mockReturnValue(paymentsQuery);
      orderbookBuilder.limit.mockReturnValue(orderbookBuilder);
      forAccount.mockReturnValue(paymentsQuery);
      payments.mockReturnValue({ forAccount });
      orderbook.mockReturnValue(orderbookBuilder);
      withAccountLock.mockImplementation((_key: string, fn: () => unknown) => fn());
      getTransactionStatus.mockResolvedValue(defaults.transactionStatus);

      if (defaults.accountError !== undefined) {
        loadAccount.mockRejectedValue(defaults.accountError);
      } else {
        loadAccount.mockResolvedValue(defaults.account);
      }
      if (defaults.submitError !== undefined) {
        submitTransaction.mockRejectedValue(defaults.submitError);
      } else {
        submitTransaction.mockResolvedValue(defaults.submitResult);
      }
      paymentsCall.mockResolvedValue({ records: defaults.paymentRecords });
      orderbookCall.mockResolvedValue(defaults.orderbookResponse);
    },
  };

  server.reset();
  return server;
}
