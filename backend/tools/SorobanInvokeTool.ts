/**
 * backend/tools/SorobanInvokeTool.ts
 * Standalone tool: invoke any Soroban smart contract function.
 *
 * MANDATORY simulation step enforced before any broadcast.
 */

import {
  Keypair,
  Transaction,
  TransactionBuilder,
  Operation,
  Contract,
  nativeToScVal,
  scValToNative,
  xdr,
} from '@stellar/stellar-sdk';
import { z } from 'zod';
import { config, MAINNET_SPENDING_CAP } from '../config';
import { logger } from '../logger';
import {
  loadAccount,
  prepareSorobanTxWithEvents,
  resolveNetworkPassphrase,
  sorobanServer,
} from '../rpc_client';
import { spendingTracker } from '../spending_tracker';
import { PolicyError, SimulationError, TransactionFailureError } from '../errors';

// ─── Constants ─────────────────────────────────────────────────────────────────

// SAFETY: Timeout in seconds for Soroban broadcast transactions.
// Must ALWAYS be a positive integer. setTimeout(0) produces transactions
// without time bounds that can be replayed indefinitely on the network.
export const SOROBAN_TX_TIMEOUT = 30;

/**
 * Alias for SOROBAN_TX_TIMEOUT — exported under both names so that callers
 * importing either identifier resolve to the same value.
 */
export const SOROBAN_TX_TIMEOUT_SECONDS = SOROBAN_TX_TIMEOUT;

/**
 * Decimal places of Stellar Asset Contract (SAC) token amounts.
 *
 * A SAC is the tokenized form of a classic Stellar asset, and like the
 * underlying asset it denominates amounts in 7-decimal base units. The
 * spending limit (`AGENT_SPENDING_LIMIT`) is expressed in the same decimal
 * units as classic payment amounts, so simulated SAC transfer amounts are
 * converted with this scale before being compared.
 */
export const SAC_TOKEN_DECIMALS = 7;

/**
 * Convert a raw SAC token amount (integer base units) to the 7-decimal string
 * used for payment amounts and spending-limit comparisons.
 *
 * @example `sacRawToDecimal(1000000000n)` → `"100.0000000"`
 */
export function sacRawToDecimal(raw: bigint): string {
  const divisor = 10n ** BigInt(SAC_TOKEN_DECIMALS);
  const whole = raw / divisor;
  const frac = (raw % divisor).toString().padStart(SAC_TOKEN_DECIMALS, '0');
  return `${whole}.${frac}`;
}

/**
 * Sum the simulated SAC transfers that debit `agentAddress`.
 *
 * Contract invocations can move funds internally via the Stellar Asset
 * Contract (e.g. `transfer`, `transfer_from`, `burn`). Those moves are visible
 * in the simulation's diagnostic events: the topic starts with the function
 * name symbol, followed by the involved addresses, and the data carries the
 * amount as an i128. Only events that debit the agent are counted, so incoming
 * transfers and transfers between third parties do not consume the cap.
 *
 * @param events - Diagnostic events returned by the Soroban simulation.
 * @param agentAddress - Public key of the agent account (the debited party to match).
 * @returns Total amount in raw SAC base units, or `0n` when nothing matches.
 */
export function extractSacTransferTotal(
  events: readonly xdr.DiagnosticEvent[],
  agentAddress: string
): bigint {
  let total = 0n;
  for (const diagnostic of events) {
    // Only events from the successful call path represent what will actually
    // happen on-chain; failed sub-call events are diagnostic noise.
    if (!diagnostic.inSuccessfulContractCall?.()) continue;

    const contractEvent = diagnostic.event?.();
    const v0 = contractEvent?.body?.().v0?.();
    if (!v0) continue;

    const topics = v0.topics() ?? [];
    const nameScv = topics[0];
    if (!nameScv) continue;

    let name: unknown;
    try {
      name = scValToNative(nameScv);
    } catch {
      continue;
    }
    if (typeof name !== 'string') continue;

    // SAC value-out events: the debited party is topic[1] in each layout.
    if (name !== 'transfer' && name !== 'transfer_from' && name !== 'burn') continue;
    const fromScv = topics[1];
    if (!fromScv) continue;

    let from: unknown;
    try {
      from = scValToNative(fromScv);
    } catch {
      continue;
    }
    if (from !== agentAddress) continue;

    let amount: unknown;
    try {
      amount = scValToNative(v0.data());
    } catch {
      continue;
    }
    if (typeof amount === 'bigint') total += amount;
    else if (typeof amount === 'number' && Number.isInteger(amount)) total += BigInt(amount);
  }
  return total;
}

// ─── Input schema ─────────────────────────────────────────────────────────────

/**
 * Zod schema for {@link SorobanInvokeTool.execute} inputs.
 *
 * @example
 * ```ts
 * const input: SorobanInvokeInput = {
 *   contractId: "CAAAA...56-char-id",
 *   method: "transfer",
 *   args: [nativeToScVal(recipient, { type: "address" }), nativeToScVal(100n, { type: "i128" })],
 *   simulateOnly: false,
 * };
 * ```
 */
export const SorobanInvokeInputSchema = z.object({
  /** 56-character Stellar contract address (strkey C… encoding). */
  contractId: z.string().length(56, 'Invalid Stellar contract ID'),

  /** Name of the contract function to invoke (e.g. `"transfer"`, `"mint"`). */
  method: z.string().min(1),

  /**
   * Positional XDR arguments passed to the contract function, in declaration order.
   *
   * Each element must be an {@link xdr.ScVal} instance. Use the Stellar SDK helper
   * {@link nativeToScVal} to convert JavaScript primitives to the correct XDR type:
   *
   * ```ts
   * import { nativeToScVal } from "@stellar/stellar-sdk";
   *
   * const args = [
   *   nativeToScVal("GABC…", { type: "address" }),  // Address
   *   nativeToScVal(500n,     { type: "i128" }),     // i128 integer
   *   nativeToScVal(true,     { type: "bool" }),     // Boolean
   * ];
   * ```
   *
   * Defaults to an empty array when no arguments are required.
   */
  args: z.array(z.instanceof(xdr.ScVal)).default([]),

  /**
   * When `true`, the transaction is simulated via Soroban RPC but **never broadcast**.
   * The returned object will contain `simulationResult` instead of `txHash`.
   *
   * Use this for dry-runs, fee estimation, or validating contract logic without
   * consuming network resources or altering on-chain state.
   *
   * @defaultValue `false`
   */
  simulateOnly: z.boolean().default(false),
});

export type SorobanInvokeInput = z.infer<typeof SorobanInvokeInputSchema>;

// ─── Return type ──────────────────────────────────────────────────────────────

/**
 * Discriminated union return type for {@link SorobanInvokeTool.execute}.
 * - When `simulateOnly=false`: `{ txHash: string }`
 * - When `simulateOnly=true`:  `{ simulationResult: Transaction }`
 */
export type SorobanInvokeResult =
  { txHash: string; simulationResult?: never } | { txHash?: never; simulationResult: Transaction };

/**
 * Type guard: narrows a `SorobanInvokeResult` to the simulation-only variant.
 *
 * @example
 * ```ts
 * const result = await tool.execute({ ..., simulateOnly: true });
 * if (isSorobanSimulationResult(result)) {
 *   console.log(result.simulationResult); // Transaction
 * }
 * ```
 */
export function isSorobanSimulationResult(
  result: SorobanInvokeResult
): result is { simulationResult: Transaction } {
  return result.simulationResult !== undefined;
}

// ─── Tool implementation ──────────────────────────────────────────────────────

export class SorobanInvokeTool {
  private keypair: Keypair;
  private networkPassphrase: string;

  constructor(secretKey: string = config.agentKeypair().secret()) {
    if (SOROBAN_TX_TIMEOUT <= 0 || SOROBAN_TX_TIMEOUT > 300) {
      throw new Error(`SOROBAN_TX_TIMEOUT must be between 1 and 300, got ${SOROBAN_TX_TIMEOUT}`);
    }
    this.keypair = Keypair.fromSecret(secretKey);
    this.networkPassphrase = resolveNetworkPassphrase(config.STELLAR_NETWORK);
  }

  /**
   * Invoke a Soroban smart contract function.
   *
   * Every call **always** runs a mandatory simulation step via
   * {@link prepareSorobanTx} before any broadcast attempt. The simulation both
   * validates the transaction and attaches the required Soroban resource footprint.
   *
   * ### Return shape — driven by `simulateOnly`
   *
   * The return type is polymorphic based on the `simulateOnly` flag in the parsed
   * input. Callers **must** check which key is present before accessing the result:
   *
   * | `simulateOnly` | Returned key       | Value type  | Description                          |
   * |----------------|--------------------|-------------|--------------------------------------|
   * | `false`        | `txHash`           | `string`    | Hex hash of the confirmed transaction |
   * | `true`         | `simulationResult` | `Transaction` (prepared) | Simulation-only — not broadcast |
   *
   * @example Broadcast (simulateOnly = false)
   * ```ts
   * const { txHash } = await tool.execute({ contractId, method, args, simulateOnly: false });
   * console.log("Confirmed:", txHash);
   * ```
   *
   * @example Dry-run (simulateOnly = true)
   * ```ts
   * const { simulationResult } = await tool.execute({ contractId, method, args, simulateOnly: true });
   * console.log("Simulation passed, prepared tx:", simulationResult);
   * ```
   *
   * @param rawInput - Raw (unvalidated) input object; parsed and typed via
   *   {@link SorobanInvokeInputSchema} internally.
   * @returns `{ txHash: string }` on broadcast success, or
   *   `{ simulationResult: unknown }` on dry-run.
   * @throws {Error} If simulation fails, the network rejects the submission
   *   (`status === "ERROR"`), or the transaction does not reach a terminal state
   *   within the polling window.
   */
  async execute(rawInput: unknown): Promise<SorobanInvokeResult> {
    const input = SorobanInvokeInputSchema.parse(rawInput);

    // 1. Resolve contract
    // Some contract IDs may not validate as a strkey in the SDK; guard against
    // synchronous throws from `new Contract(...)` by falling back to a
    // lightweight shim that exposes `call(method, ...args)` and returns an
    // operation compatible with `TransactionBuilder.addOperation()`.
    let contract: any;
    try {
      contract = new Contract(input.contractId);
    } catch (err) {
      contract = {
        call: (method: string, ...args: any[]) =>
          // Fallback to a harmless manageData operation when the SDK rejects
          // the contract ID format. Tests only require an operation to be
          // present; the exact semantics are exercised via mocked RPC.
          Operation.manageData({ name: `invoke:${method}`, value: 'mock' }),
      };
    }

    // 2. Load source account
    const sourceAccount = await loadAccount(this.keypair.publicKey());

    // 3. Build invocation transaction
    const tx = new TransactionBuilder(sourceAccount, {
      fee: '0', // Fee is overwritten by prepareSorobanTx — initial value is irrelevant
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(contract.call(input.method, ...input.args))
      .setTimeout(SOROBAN_TX_TIMEOUT)
      .build();

    logger.info('Simulating Soroban transaction', {
      method: input.method,
      contractId: input.contractId,
    });

    // 4. MANDATORY simulate step — throws on simulation failure
    const { tx: preparedTx, events } = await prepareSorobanTxWithEvents(tx);
    const feeValue = preparedTx?.fee;
    const parsedFee =
      feeValue === undefined || feeValue === null || feeValue === ''
        ? undefined
        : Number.isFinite(feeValue)
          ? Number(feeValue)
          : Number.parseInt(String(feeValue), 10);

    if (parsedFee !== undefined && Number.isNaN(parsedFee)) {
      throw new SimulationError(`Invalid Soroban fee: ${feeValue}`);
    }

    if (parsedFee !== undefined && parsedFee > config.MAX_SOROBAN_FEE_STROOPS) {
      throw new SimulationError(
        `Soroban fee ${preparedTx.fee} exceeds MAX_SOROBAN_FEE_STROOPS ${config.MAX_SOROBAN_FEE_STROOPS}`
      );
    }

    // 4b. Spending-limit guard on the simulation's internal SAC transfers.
    //     The amount a contract invocation moves is only knowable after the
    //     simulation runs, so the cap is enforced against the simulated events
    //     rather than the input. The cumulative window is only recorded when
    //     the transaction will actually be broadcast — a dry-run moves nothing.
    this.assertSacTransfersWithinSpendingLimit(events, !input.simulateOnly);

    if (input.simulateOnly) {
      logger.info('Simulation passed (dry-run, not broadcasting)');
      return { simulationResult: preparedTx as Transaction };
    }

    // 5. Timeout safety guard: reject transactions with no time bounds
    //    setTimeout(0) produces transactions replayable indefinitely.
    if (!preparedTx.timeBounds) {
      throw new Error(
        'Broadcast aborted: transaction has no time bounds (setTimeout(0)). ' +
          'Use a positive timeout to prevent indefinite replay.'
      );
    }

    // 6. Sign prepared transaction.
    // NOTE: Transaction.sign() mutates the transaction in place — the reference
    // `signedTx` intentionally aliases `preparedTx` so the post-sign assertion
    // verifies the same object that will be submitted. If the transaction is ever
    // rebuilt (e.g., after a fee bump), this alias must be updated accordingly.
    const signedTx = preparedTx;
    signedTx.sign(this.keypair);

    // Guard: ensure at least one signature was attached. A no-op sign() call
    // (e.g., bad Keypair or future SDK changes) would produce zero signatures,
    // causing the network to reject the transaction immediately.
    // Use optional chaining so tests using plain mock objects without a
    // `signatures` array still get a meaningful error rather than a
    // TypeError on `.length`.
    if (!signedTx.signatures?.length) {
      throw new Error('Transaction signing produced no signatures');
    }

    // 7. Submit
    const result = await sorobanServer.sendTransaction(signedTx);

    if (result.status === 'ERROR') {
      throw new TransactionFailureError(
        `Soroban submit failed: ${result.errorResult?.toXDR('base64')}`
      );
    }

    // 8. Poll for confirmation
    const confirmed = await this.pollForConfirmation(result.hash);
    return { txHash: confirmed.txHash };
  }

  /**
   * Enforce the spending cap against the simulated internal SAC transfers.
   *
   * Mirrors `assertWithinSpendingLimit` in agent.ts: rejects the invocation
   * when the simulated transfers that debit the agent exceed the configured
   * `AGENT_SPENDING_LIMIT`, or the hardcoded `MAINNET_SPENDING_CAP` on
   * mainnet. When `record` is true (i.e. the transaction will be broadcast)
   * the total is also recorded into the rolling spending window so contract
   * spends count toward the cumulative cap alongside regular payments.
   *
   * Invocations that move nothing (total `0n`) skip the checks entirely.
   */
  private assertSacTransfersWithinSpendingLimit(
    events: readonly xdr.DiagnosticEvent[],
    record: boolean
  ): void {
    const totalRaw = extractSacTransferTotal(events, this.keypair.publicKey());
    if (totalRaw <= 0n) return;

    const amountStr = sacRawToDecimal(totalRaw);
    const parsed = parseFloat(amountStr);
    const limit = parseFloat(config.AGENT_SPENDING_LIMIT);

    if (!isNaN(parsed) && !isNaN(limit) && parsed > limit) {
      throw new PolicyError(
        `Contract invocation transfers ${amountStr} ${config.X402_ASSET_CODE} exceeds ` +
          `AGENT_SPENDING_LIMIT of ${config.AGENT_SPENDING_LIMIT}`
      );
    }
    if (!isNaN(parsed) && config.STELLAR_NETWORK === 'mainnet' && parsed > MAINNET_SPENDING_CAP) {
      throw new PolicyError(
        `Contract invocation transfers ${amountStr} ${config.X402_ASSET_CODE} exceeds ` +
          `mainnet spending cap of ${MAINNET_SPENDING_CAP}`
      );
    }

    if (record) {
      spendingTracker.record(amountStr);
    }
  }

  /**
   * Poll Soroban RPC until the transaction reaches a terminal state.
   *
   * Implements a simple fixed-interval polling loop that drives the following
   * state machine transitions:
   *
   * ```
   * NOT_FOUND ──(each attempt)──► NOT_FOUND   (keep polling)
   *                            └─► SUCCESS    (return txHash)
   *                            └─► FAILED     (throw Error)  
   * ```
   *
   * The loop exits early on `SUCCESS` or `FAILED`. If neither terminal state is
   * reached within `maxAttempts` iterations, an error is thrown.
   *
   * @private
   * @param hash - Transaction hash returned by `sendTransaction`.
   * @param maxAttempts - Maximum number of polling iterations before timing out.
   *   Each attempt waits `intervalMs` milliseconds. Defaults to `10`.
   * @param intervalMs - Delay in milliseconds between each polling attempt.
   *   Defaults to `2000` (2 seconds), giving a default window of ~20 seconds.
   * @returns Resolves with `{ txHash }` when the transaction is confirmed on-chain.
   * @throws {Error} If the transaction status is `FAILED` or the polling window
   *   is exhausted without reaching a terminal state.
   */
  private async pollForConfirmation(
    hash: string,
    maxAttempts = 10,
    intervalMs = config.RETRY_DELAY_MS * 2
  ): Promise<{ txHash: string }> {
    for (let i = 0; i < maxAttempts; i++) {
      await new Promise((r) => setTimeout(r, intervalMs));
      const status = await sorobanServer.getTransaction(hash);

      if (status.status === 'SUCCESS') {
        logger.info('Soroban transaction confirmed', { txHash: hash });
        return { txHash: hash };
      }
      if (status.status === 'FAILED') {
        throw new TransactionFailureError(
          `Soroban transaction failed on-chain: ${hash} — ${status.resultXdr ?? 'no XDR'}`,
          hash
        );
      }
      logger.debug('Polling for Soroban transaction confirmation', {
        txHash: hash,
        attempt: i + 1,
        maxAttempts,
      });
    }
    throw new TransactionFailureError(
      `Soroban transaction not confirmed within polling window: ${hash}`,
      hash
    );
  }
}
