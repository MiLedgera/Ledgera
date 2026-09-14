/**
 * tests/fixtures/MockSorobanServer.ts
 *
 * Shared mock of the Soroban side of the `backend/rpc_client` module for
 * offline (network-free) tests (#438).
 *
 * ## Why this exists
 *
 * `tests/soroban_invoke.test.ts` previously hand-rolled its own inline
 * `vi.mock("../backend/rpc_client", ...)` factory and configured
 * `prepareSorobanTxWithEvents` / `sorobanServer.sendTransaction` /
 * `sorobanServer.getTransaction` per test with raw `vi.mocked(...)` calls.
 * That duplicated mock setup across files and made failure scenarios
 * (simulation failure, submit ERROR, poll timeout, signing no-op) verbose to
 * set up.
 *
 * `createMockSorobanServer()` centralises that setup. It returns a single
 * object shaped like the Soroban-facing part of the real `rpc_client` module,
 * ready to be returned directly from a `vi.mock` factory:
 *
 * ```ts
 * import { createMockSorobanServer } from "./fixtures/MockSorobanServer";
 *
 * const { mockSorobanServer } = vi.hoisted(() => {
 *   const { createMockSorobanServer } = require("./fixtures/MockSorobanServer");
 *   return { mockSorobanServer: createMockSorobanServer() };
 * });
 *
 * vi.mock("../backend/rpc_client", () => mockSorobanServer);
 * ```
 *
 * The mock supports configurable responses for the four Soroban RPC methods
 * named by the issue — `simulateTransaction`, `getLatestLedger`,
 * `getLedgerEntries`, `getEvents` — plus the higher-level `rpc_client`
 * functions the Soroban tools actually call (`loadAccount`,
 * `prepareSorobanTxWithEvents`, `sorobanServer.sendTransaction`,
 * `sorobanServer.getTransaction`).
 *
 * Failure scenarios are declarative via scenario configurators:
 * `failSimulation(message)`, `submitError(status)`, `stallPolling()`,
 * `signNoOp()`, and per-method `set*` configurators. Every mock is re-seeded
 * to its configured default in `reset()`, which is safe to call from
 * `beforeEach`.
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
  };
}

/** A prepared transaction the mock can sign with a real signature entry. */
export function makeMockPreparedTx(fee = 500_000): Record<string, unknown> {
  const obj: Record<string, unknown> = { signatures: [], fee, timeBounds: {} };
  obj.sign = vi.fn().mockImplementation(() => {
    (obj.signatures as unknown[]).push({
      hint: () => Buffer.alloc(4),
      signature: () => Buffer.alloc(64),
    });
  });
  return obj;
}

/** Shape of the per-response configuration accepted by the factory. */
export interface MockSorobanServerOverrides {
  /** Default resolved value for `loadAccount`. */
  account?: unknown;
  /** Default rejection for `loadAccount`. */
  accountError?: Error;
  /** Default resolved value for `prepareSorobanTxWithEvents` (`{ tx, events, retval? }`). */
  prepared?: { tx?: unknown; events?: unknown[]; retval?: unknown };
  /** Default rejection for `prepareSorobanTxWithEvents`. */
  simulationError?: Error;
  /** Default resolved value for `sorobanServer.sendTransaction`. */
  submitResult?: unknown;
  /** Default resolved value for `sorobanServer.getTransaction`. */
  transactionResult?: unknown;
  /** Default resolved values for the raw Soroban RPC server methods. */
  simulateTransaction?: unknown;
  getLatestLedger?: unknown;
  getLedgerEntries?: unknown;
  getEvents?: unknown;
}

/**
 * A configurable mock of the Soroban-facing part of the `rpc_client` module.
 *
 * The whole object is shaped like the real module's Soroban-facing exports so
 * it can be returned from a `vi.mock("../backend/rpc_client", ...)` factory,
 * while also carrying scenario configurators (`failSimulation`, `submitError`,
 * `stallPolling`, `signNoOp`) and the raw mock functions so tests can assert
 * on call history.
 */
export interface MockSorobanServer {
  /** Mock of `rpc_client.loadAccount`. */
  loadAccount: MockedFn;
  /** Mock of `rpc_client.submitTransaction`. */
  submitTransaction: MockedFn;
  /** Mock of `rpc_client.simulateSorobanTx`. */
  simulateSorobanTx: MockedFn;
  /** Mock of `rpc_client.prepareSorobanTx`. */
  prepareSorobanTx: MockedFn;
  /** Mock of `rpc_client.prepareSorobanTxWithEvents`. */
  prepareSorobanTxWithEvents: MockedFn;
  /** Real network-passphrase resolver, matching `rpc_client.resolveNetworkPassphrase`. */
  resolveNetworkPassphrase: (network: string) => string;
  /** Mock of `rpc_client.horizonServer` (unused by Soroban-only paths). */
  horizonServer: Record<string, never>;
  /** Mock of `rpc_client.sorobanServer`. */
  sorobanServer: {
    sendTransaction: MockedFn;
    getTransaction: MockedFn;
    /** Raw Soroban RPC: `simulateTransaction` (#438). */
    simulateTransaction: MockedFn;
    /** Raw Soroban RPC: `getLatestLedger` (#438). */
    getLatestLedger: MockedFn;
    /** Raw Soroban RPC: `getLedgerEntries` (#438). */
    getLedgerEntries: MockedFn;
    /** Raw Soroban RPC: `getEvents` (#438). */
    getEvents: MockedFn;
  };

  /** Configure the default `loadAccount` resolution. */
  setAccount(account: unknown): MockSorobanServer;
  /** Configure the default `loadAccount` rejection. */
  setAccountError(error: Error): MockSorobanServer;
  /** Configure the default `prepareSorobanTxWithEvents` resolution. */
  setPrepared(prepared: { tx?: unknown; events?: unknown[]; retval?: unknown }): MockSorobanServer;
  /** Configure the default `prepareSorobanTxWithEvents` rejection. */
  setSimulationError(error: Error): MockSorobanServer;
  /** Configure the default `sendTransaction` resolution. */
  setSubmitResult(result: unknown): MockSorobanServer;
  /** Configure the default `getTransaction` resolution. */
  setTransactionResult(result: unknown): MockSorobanServer;
  /** Configure raw Soroban RPC method responses (#438). */
  setSimulateTransaction(result: unknown): MockSorobanServer;
  setGetLatestLedger(result: unknown): MockSorobanServer;
  setGetLedgerEntries(result: unknown): MockSorobanServer;
  setGetEvents(result: unknown): MockSorobanServer;

  /** Scenario: every simulation fails with the given error. */
  failSimulation(error: Error): MockSorobanServer;
  /** Scenario: `sendTransaction` resolves with the given status payload. */
  submitResult(status: 'PENDING' | 'ERROR', hash: string): MockSorobanServer;
  /** Scenario: `sendTransaction` resolves with an ERROR payload. */
  submitError(hash: string): MockSorobanServer;
  /** Scenario: every poll returns NOT_FOUND (stalled transaction). */
  stallPolling(): MockSorobanServer;
  /** Scenario: the prepared tx's `sign()` is a no-op (empty signatures). */
  signNoOp(): MockSorobanServer;

  /** Re-seed every mock to its configured default and clear call history. */
  reset(): void;
}

/**
 * Create a shared, configurable mock of the Soroban-facing `rpc_client` module.
 *
 * @param overrides - Optional default responses. See {@link MockSorobanServerOverrides}.
 * @returns A {@link MockSorobanServer} ready for use as the value of a
 * `vi.mock("../backend/rpc_client", ...)` factory.
 *
 * @example
 * ```ts
 * const server = createMockSorobanServer();
 * server.failSimulation(new Error("Soroban simulation failed: budget"));
 * server.reset(); // restores the configured defaults for the next test
 * ```
 */
export function createMockSorobanServer(
  overrides: MockSorobanServerOverrides = {}
): MockSorobanServer {
  const DEFAULT_ACCOUNT = makeMockAccount(
    'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5'
  );
  const DEFAULT_PREPARED = { tx: makeMockPreparedTx(), events: [] };

  const loadAccount = vi.fn();
  const submitTransaction = vi.fn();
  const simulateSorobanTx = vi.fn();
  const prepareSorobanTx = vi.fn();
  const prepareSorobanTxWithEvents = vi.fn();

  const sendTransaction = vi.fn();
  const getTransaction = vi.fn();
  const simulateTransaction = vi.fn();
  const getLatestLedger = vi.fn();
  const getLedgerEntries = vi.fn();
  const getEvents = vi.fn();

  const defaults = {
    account: overrides.account !== undefined ? overrides.account : DEFAULT_ACCOUNT,
    accountError: overrides.accountError,
    prepared:
      overrides.prepared !== undefined
        ? { tx: makeMockPreparedTx(), events: [], ...overrides.prepared }
        : DEFAULT_PREPARED,
    simulationError: overrides.simulationError,
    submitResult:
      overrides.submitResult !== undefined
        ? overrides.submitResult
        : { status: 'PENDING', hash: 'mock_tx_hash' },
    transactionResult:
      overrides.transactionResult !== undefined
        ? overrides.transactionResult
        : { status: 'SUCCESS' },
    simulateTransaction: overrides.simulateTransaction,
    getLatestLedger: overrides.getLatestLedger,
    getLedgerEntries: overrides.getLedgerEntries,
    getEvents: overrides.getEvents,
  };

  const server: MockSorobanServer = {
    loadAccount,
    submitTransaction,
    simulateSorobanTx,
    prepareSorobanTx,
    prepareSorobanTxWithEvents,
    resolveNetworkPassphrase: (network: string): string => {
      if (network === 'mainnet') return Networks.PUBLIC;
      if (network === 'futurenet') return Networks.FUTURENET;
      return Networks.TESTNET;
    },
    horizonServer: {},
    sorobanServer: {
      sendTransaction,
      getTransaction,
      simulateTransaction,
      getLatestLedger,
      getLedgerEntries,
      getEvents,
    },
    setAccount(account: unknown): MockSorobanServer {
      loadAccount.mockResolvedValue(account);
      return server;
    },
    setAccountError(error: Error): MockSorobanServer {
      loadAccount.mockRejectedValue(error);
      return server;
    },
    setPrepared(prepared: {
      tx?: unknown;
      events?: unknown[];
      retval?: unknown;
    }): MockSorobanServer {
      prepareSorobanTxWithEvents.mockResolvedValue({
        tx: makeMockPreparedTx(),
        events: [],
        ...prepared,
      });
      return server;
    },
    setSimulationError(error: Error): MockSorobanServer {
      prepareSorobanTxWithEvents.mockRejectedValue(error);
      return server;
    },
    setSubmitResult(result: unknown): MockSorobanServer {
      sendTransaction.mockResolvedValue(result);
      return server;
    },
    setTransactionResult(result: unknown): MockSorobanServer {
      getTransaction.mockResolvedValue(result);
      return server;
    },
    setSimulateTransaction(result: unknown): MockSorobanServer {
      simulateTransaction.mockResolvedValue(result);
      return server;
    },
    setGetLatestLedger(result: unknown): MockSorobanServer {
      getLatestLedger.mockResolvedValue(result);
      return server;
    },
    setGetLedgerEntries(result: unknown): MockSorobanServer {
      getLedgerEntries.mockResolvedValue(result);
      return server;
    },
    setGetEvents(result: unknown): MockSorobanServer {
      getEvents.mockResolvedValue(result);
      return server;
    },
    failSimulation(error: Error): MockSorobanServer {
      prepareSorobanTxWithEvents.mockRejectedValue(error);
      return server;
    },
    submitResult(status, hash): MockSorobanServer {
      sendTransaction.mockResolvedValue(
        status === 'ERROR'
          ? { status, errorResult: { toXDR: () => 'base64_error_xdr' }, hash }
          : { status, hash }
      );
      return server;
    },
    submitError(hash): MockSorobanServer {
      sendTransaction.mockResolvedValue({
        status: 'ERROR',
        errorResult: { toXDR: () => 'base64_error_xdr' },
        hash,
      });
      return server;
    },
    stallPolling(): MockSorobanServer {
      getTransaction.mockResolvedValue({ status: 'NOT_FOUND' });
      return server;
    },
    signNoOp(): MockSorobanServer {
      prepareSorobanTxWithEvents.mockResolvedValue({
        tx: { sign: vi.fn(), signatures: [], fee: 500_000, timeBounds: {} },
        events: [],
      });
      return server;
    },
    reset(): void {
      vi.clearAllMocks();
      if (defaults.accountError !== undefined) {
        loadAccount.mockRejectedValue(defaults.accountError);
      } else {
        loadAccount.mockResolvedValue(defaults.account);
      }
      if (defaults.simulationError !== undefined) {
        prepareSorobanTxWithEvents.mockRejectedValue(defaults.simulationError);
      } else {
        prepareSorobanTxWithEvents.mockResolvedValue(defaults.prepared);
      }
      sendTransaction.mockResolvedValue(defaults.submitResult);
      getTransaction.mockResolvedValue(defaults.transactionResult);
      if (defaults.simulateTransaction !== undefined) {
        simulateTransaction.mockResolvedValue(defaults.simulateTransaction);
      }
      if (defaults.getLatestLedger !== undefined) {
        getLatestLedger.mockResolvedValue(defaults.getLatestLedger);
      }
      if (defaults.getLedgerEntries !== undefined) {
        getLedgerEntries.mockResolvedValue(defaults.getLedgerEntries);
      }
      if (defaults.getEvents !== undefined) {
        getEvents.mockResolvedValue(defaults.getEvents);
      }
    },
  };

  server.reset();
  return server;
}
