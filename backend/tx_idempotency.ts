/**
 * backend/tx_idempotency.ts
 *
 * Idempotent transaction submission for value-moving tools (#484).
 *
 * ## The problem
 *
 * A tool's build→sign→submit path can be interrupted at the worst possible
 * moment: the client times out (SUBMIT_TIMEOUT_MS, or the opossum breaker's
 * own shorter internal timeout — see rpc_client.ts's `submitTransactionBreaker`)
 * *after* Horizon has already applied the transaction to a ledger, but before
 * the success response reaches the caller. If the caller — or an automated
 * retry, or a second concurrent `PayFiAgent.run()` call — responds to that
 * ambiguity by simply building and broadcasting a *new* transaction for the
 * same logical payment, the result is a real double payment: two distinct,
 * both-successful transactions for what was meant to be one instruction.
 *
 * ## The fix
 *
 * Callers identify a logical operation with a stable `idempotencyKey` (for
 * `PayFiAgent`, this is `AgentTask.correlationId` — the caller must reuse the
 * *same* correlationId across a retry for idempotency to apply; a fresh one
 * each attempt is indistinguishable from a fresh operation). `submitIdempotent`
 * then guarantees, for a given key:
 *
 *   1. The transaction's hash is recorded in SQLite *before* it is broadcast
 *      (`attachTxSubmissionHash`), so a later attempt — even after a process
 *      restart — knows exactly which on-chain transaction to check.
 *   2. A retry (same key) never blindly rebuilds and resubmits. It first
 *      checks the recorded hash's on-chain status via
 *      {@link getTransactionStatus}. If it already landed, the cached/looked-up
 *      result is returned and nothing new is broadcast.
 *   3. The check-then-record step for a *new* key is atomic
 *      (`beginTxSubmission`'s immediate SQLite transaction), so two concurrent
 *      callers racing on the same key cannot both decide to build and submit.
 *   4. All build→sign→submit work for one source account is serialized via
 *      {@link withAccountLock}, so concurrent *different* payments from the
 *      same account (the common case — one agent, one keypair) cannot race
 *      on the sequence number.
 */

import { Transaction, TransactionBuilder } from '@stellar/stellar-sdk';
import { z } from 'zod';
import {
  loadAccount,
  submitTransaction,
  getTransactionStatus,
  withAccountLock,
  resolveNetworkPassphrase,
  type HorizonAccount,
} from './rpc_client';
import {
  beginTxSubmission,
  attachTxSubmissionHash,
  completeTxSubmission,
  failTxSubmission,
  resetTxSubmissionToPending,
  getTxSubmission,
  type TxSubmissionRecord,
} from './persistence';
import { TransactionFailureError } from './errors';
import { config } from './config';
import { createLogger } from './utils/logger';
import { computeFeeBumpFee } from './tools/FeeBumpTool';

const log = createLogger('tx-idempotency');

export interface SubmitResult {
  txHash: string;
  ledger: number;
}

// Mirrors `StellarPaymentTool.SubmitResultSchema` — kept as its own copy
// rather than imported to avoid a circular dependency (StellarPaymentTool.ts
// imports submitIdempotent from this module). Validates the raw Horizon
// response shape before it's trusted as a real result.
const RawSubmitResultSchema = z.object({
  hash: z.string(),
  ledger: z.number(),
});

/** Thrown when a submission for the same idempotency key is genuinely concurrent and unresolved. */
export class TxSubmissionInFlightError extends Error {
  constructor(idempotencyKey: string) {
    super(
      `A submission for idempotency key "${idempotencyKey}" is already in flight; ` +
        `its outcome is not yet known`
    );
    this.name = 'TxSubmissionInFlightError';
  }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * A rejection is "definitive" when Horizon actually responded with a
 * structured rejection (its `extras.result_codes` body) — proof the network
 * evaluated and refused this specific envelope, so it is safe to conclude it
 * never landed without checking chain state.
 *
 * Everything else — a client-side TimeoutError, the opossum breaker's own
 * `ETIMEDOUT` (see rpc_client.ts), a dropped connection, retries exhausted
 * with an unclear last error — means the client simply doesn't know what
 * Horizon did with the request. Defaulting to "ambiguous" is the safe
 * direction: the worst it costs is one extra status-check call, whereas
 * defaulting to "definitive" risks a silent double-spend.
 */
function isAmbiguousOutcome(err: unknown): boolean {
  const code = (err as { code?: string } | undefined)?.code;
  if (code === 'EOPENBREAKER') return false; // never left the process
  const resultCodes = (err as { response?: { data?: { extras?: { result_codes?: unknown } } } })
    ?.response?.data?.extras?.result_codes;
  if (resultCodes !== undefined) return false; // Horizon definitively rejected it
  return true;
}

function isBadSequenceRejection(err: unknown): boolean {
  return err instanceof Error && err.message.includes('tx_bad_seq');
}

/**
 * Submit `hash` (already recorded via `attachTxSubmissionHash`) and settle
 * the idempotency row based on the outcome — including, for an ambiguous
 * failure, checking whether it actually landed before concluding it failed.
 */
async function finalizeSubmission(
  idempotencyKey: string,
  hash: string,
  submit: () => Promise<{ hash: string; ledger: number }>
): Promise<SubmitResult> {
  try {
    const result = RawSubmitResultSchema.parse(await submit());
    const parsed: SubmitResult = { txHash: result.hash, ledger: result.ledger };
    completeTxSubmission(idempotencyKey, JSON.stringify(parsed), Date.now());
    return parsed;
  } catch (err) {
    // A malformed-but-received response is a parsing problem, not an unknown
    // outcome — Horizon answered, just not with a shape we trust. No chain
    // check needed; rethrow as-is.
    if (err instanceof z.ZodError) throw err;
    if (!isAmbiguousOutcome(err)) throw err;

    log.warn(
      { idempotencyKey, hash, error: errMessage(err) },
      'Ambiguous submission outcome — checking on-chain status by hash before concluding failure'
    );
    const status = await getTransactionStatus(hash).catch(() => null);

    if (status?.status === 'success') {
      const parsed: SubmitResult = { txHash: hash, ledger: status.ledger ?? 0 };
      log.info(
        { idempotencyKey, hash },
        'Transaction had actually landed — no resubmission needed'
      );
      completeTxSubmission(idempotencyKey, JSON.stringify(parsed), Date.now());
      return parsed;
    }
    if (status?.status === 'failed') {
      throw new TransactionFailureError(`Transaction ${hash} failed on-chain`, hash, err);
    }
    // not_found, or the status check itself failed: genuinely unresolved.
    // Rethrow the original error — the caller marks the row 'failed' so a
    // future retry (same key) can rebuild.
    throw err;
  }
}

async function resolveExistingSubmission(record: TxSubmissionRecord): Promise<SubmitResult | null> {
  if (record.status === 'success' && record.resultJson) {
    return JSON.parse(record.resultJson) as SubmitResult;
  }

  if (record.status === 'pending') {
    if (!record.txHash) {
      // Another call with this key is between begin() and attachTxSubmissionHash()
      // right now — nothing to check yet.
      throw new TxSubmissionInFlightError(record.idempotencyKey);
    }
    // A prior attempt recorded a hash but never resolved to success/failed —
    // e.g. the process crashed, or an earlier ambiguous failure left it
    // unresolved. Check the chain before doing anything else.
    const status = await getTransactionStatus(record.txHash).catch(() => null);
    if (status?.status === 'success') {
      const parsed: SubmitResult = { txHash: record.txHash, ledger: status.ledger ?? 0 };
      completeTxSubmission(record.idempotencyKey, JSON.stringify(parsed), Date.now());
      return parsed;
    }
    if (status?.status === 'failed') {
      failTxSubmission(
        record.idempotencyKey,
        `Transaction ${record.txHash} failed on-chain`,
        Date.now()
      );
      return null; // caller resets to pending and rebuilds
    }
    throw new TxSubmissionInFlightError(record.idempotencyKey);
  }

  // status === 'failed': safe to reset and rebuild.
  return null;
}

export interface SubmitIdempotentOptions {
  /** Stable identifier for the logical operation — must be reused across retries to dedupe. */
  idempotencyKey: string;
  sourceAccountId: string;
  /** Build and sign a fresh transaction against the given account state. */
  buildAndSign: (account: HorizonAccount) => Transaction;
}

/**
 * Submit a transaction exactly once per `idempotencyKey`, safely across
 * restarts and concurrent callers. See the module doc comment for the full
 * guarantee.
 */
export async function submitIdempotent(opts: SubmitIdempotentOptions): Promise<SubmitResult> {
  const { idempotencyKey, sourceAccountId, buildAndSign } = opts;

  const { record, isNew } = beginTxSubmission(idempotencyKey, sourceAccountId, Date.now());
  if (!isNew) {
    const resolved = await resolveExistingSubmission(record);
    if (resolved) return resolved;
    resetTxSubmissionToPending(idempotencyKey, Date.now());
  }

  return withAccountLock(sourceAccountId, async () => {
    const attempt = async (forceRefresh: boolean): Promise<SubmitResult> => {
      const account = forceRefresh
        ? await loadAccount(sourceAccountId, { forceRefresh: true })
        : await loadAccount(sourceAccountId);
      const tx = buildAndSign(account);
      const hash = tx.hash().toString('hex');
      attachTxSubmissionHash(idempotencyKey, hash, tx.toEnvelope().toXDR('base64'), Date.now());
      return finalizeSubmission(idempotencyKey, hash, () => submitTransaction(tx));
    };

    try {
      return await attempt(false);
    } catch (err) {
      if (isBadSequenceRejection(err)) {
        log.warn(
          { idempotencyKey },
          'tx_bad_seq on idempotent submission — reloading account and retrying once'
        );
        try {
          return await attempt(true);
        } catch (retryErr) {
          failTxSubmission(idempotencyKey, errMessage(retryErr), Date.now());
          throw retryErr;
        }
      }
      failTxSubmission(idempotencyKey, errMessage(err), Date.now());
      throw err;
    }
  });
}

/**
 * Fee-bump and resubmit a submission whose transaction appears stuck (not
 * found on-chain, most likely because its timebounds lapsed before it was
 * included in a ledger).
 *
 * Always re-checks on-chain status first: "stuck" can only be concluded once
 * the original hash is confirmed absent, never assumed from local state
 * alone (the same ambiguity `submitIdempotent` guards against applies here).
 *
 * @param idempotencyKey - Key of an existing submission with a recorded
 *   `tx_hash`/`envelope_xdr` (i.e. `attachTxSubmissionHash` ran for it).
 * @param opts.baseFeeMultiplier - See {@link computeFeeBumpFee}. Defaults to 2.
 */
export async function resubmitStuckTransaction(
  idempotencyKey: string,
  opts: { baseFeeMultiplier?: number } = {}
): Promise<SubmitResult> {
  const record = getTxSubmission(idempotencyKey);
  if (!record) {
    throw new Error(`No submission recorded for idempotency key "${idempotencyKey}"`);
  }
  if (record.status === 'success' && record.resultJson) {
    return JSON.parse(record.resultJson) as SubmitResult;
  }
  if (!record.txHash || !record.envelopeXdr) {
    throw new Error(
      `Submission "${idempotencyKey}" has no recorded transaction yet — nothing to fee-bump`
    );
  }

  const status = await getTransactionStatus(record.txHash);
  if (status.status === 'success') {
    const parsed: SubmitResult = { txHash: record.txHash, ledger: status.ledger ?? 0 };
    completeTxSubmission(idempotencyKey, JSON.stringify(parsed), Date.now());
    return parsed;
  }
  if (status.status === 'failed') {
    failTxSubmission(idempotencyKey, `Transaction ${record.txHash} failed on-chain`, Date.now());
    throw new TransactionFailureError(
      `Transaction ${record.txHash} failed on-chain`,
      record.txHash
    );
  }

  // not_found: genuinely stuck. Wrap the original signed envelope in a
  // fee-bump (same inner tx, same sequence number — no new sequence is
  // consumed) and resubmit at a higher fee.
  const networkPassphrase = resolveNetworkPassphrase(config.STELLAR_NETWORK);
  const agentKeypair = config.agentKeypair();
  const baseFeeMultiplier = opts.baseFeeMultiplier ?? 2;

  return withAccountLock(record.sourceAccount, async () => {
    const innerTx = TransactionBuilder.fromXDR(
      record.envelopeXdr!,
      networkPassphrase
    ) as Transaction;
    const feeBumpFee = computeFeeBumpFee(innerTx, baseFeeMultiplier);
    const feeBumpTx = TransactionBuilder.buildFeeBumpTransaction(
      agentKeypair,
      feeBumpFee,
      innerTx,
      networkPassphrase
    );
    feeBumpTx.sign(agentKeypair);
    const hash = feeBumpTx.hash().toString('hex');

    attachTxSubmissionHash(
      idempotencyKey,
      hash,
      feeBumpTx.toEnvelope().toXDR('base64'),
      Date.now()
    );
    try {
      return await finalizeSubmission(idempotencyKey, hash, () => submitTransaction(feeBumpTx));
    } catch (err) {
      failTxSubmission(idempotencyKey, errMessage(err), Date.now());
      throw err;
    }
  });
}
