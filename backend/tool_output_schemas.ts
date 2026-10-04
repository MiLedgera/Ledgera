/**
 * backend/tool_output_schemas.ts
 *
 * Zod schemas describing each tool's *current* return shape, written by
 * mirroring the existing `*Result`/return-type interfaces in backend/tools/
 * (built for backend/tool_definitions.ts — see backend/tool_contract.ts for
 * how these are used: soft, warn-only validation plus JSON Schema
 * generation, never a hard runtime gate).
 *
 * A few tools return SDK types that don't have a meaningful JSON Schema
 * representation (a Soroban `Transaction` object, raw `xdr`/`rpc.Api` event
 * records) — those fields are deliberately `z.unknown()` rather than an
 * approximated shape that could drift from the real SDK type and silently
 * stop matching.
 */

import { z } from 'zod';

// ─── Shared fragments ──────────────────────────────────────────────────────

/** The common on-chain submission result shared by most value-moving/destructive tools. */
export const TxSubmitOutputSchema = z.object({
  txHash: z.string(),
  ledger: z.number(),
});

/** Tools with no input (e.g. `account_info`) take an empty parameters object. */
export const NoInputSchema = z.object({}).strict();

// ─── stellar_payment ────────────────────────────────────────────────────────

export const StellarPaymentOutputSchema = TxSubmitOutputSchema.extend({
  network: z.string(),
});

// ─── soroban_invoke ─────────────────────────────────────────────────────────

export const SorobanInvokeOutputSchema = z.union([
  z.object({ txHash: z.string() }),
  z.object({ simulationResult: z.unknown() }),
]);

// ─── soroban_query ──────────────────────────────────────────────────────────

export const SorobanQueryOutputSchema = z.object({
  simulationResult: z.unknown(),
});

// ─── x402_respond ───────────────────────────────────────────────────────────

export const X402PaymentProofOutputSchema = z.object({
  protocol: z.literal('x402'),
  network: z.string(),
  txHash: z.string(),
  nonce: z.string(),
  payer: z.string(),
  signedAt: z.string(),
});

// ─── account_info ───────────────────────────────────────────────────────────

export const AccountInfoOutputSchema = z.object({
  publicKey: z.string(),
  balances: z.array(z.object({ asset: z.string(), balance: z.string() })),
  sequenceNumber: z.string(),
  subentryCount: z.number(),
});

// ─── multisig_payment ───────────────────────────────────────────────────────

export const MultiSigOutputSchema = z.object({
  unsignedXDR: z.string().optional(),
  txHash: z.string().optional(),
  ledger: z.number().optional(),
});

// ─── batch_payment ──────────────────────────────────────────────────────────

export const BatchPaymentOutputSchema = TxSubmitOutputSchema.extend({
  skipped: z.number(),
});

// ─── balance_check ──────────────────────────────────────────────────────────

export const BalanceCheckOutputSchema = z.string();

// ─── dex_offer ──────────────────────────────────────────────────────────────

export const DexOfferOutputSchema = TxSubmitOutputSchema.extend({
  offerId: z.string(),
});

// ─── liquidity_pool ─────────────────────────────────────────────────────────

export const LiquidityPoolInfoOutputSchema = z.object({
  id: z.string(),
  pagingToken: z.string(),
  feeBP: z.number(),
  type: z.string(),
  totalShares: z.string(),
  totalTrustlines: z.string(),
  reserves: z.array(z.object({ asset: z.string(), amount: z.string() })),
});

export const LiquidityPoolOutputSchema = z.object({
  txHash: z.string().optional(),
  ledger: z.number().optional(),
  poolInfo: LiquidityPoolInfoOutputSchema.optional(),
});

// ─── stellar_toml ───────────────────────────────────────────────────────────

/** SEP-0001 fields are caller-defined TOML content; shape is not knowable statically. */
export const StellarTomlOutputSchema = z.record(z.string(), z.unknown());

// ─── data_entry ─────────────────────────────────────────────────────────────

export const DataEntryGetOutputSchema = z.object({
  name: z.string(),
  accountId: z.string(),
  exists: z.boolean(),
  value: z.string().nullable(),
  utf8: z.string().nullable().optional(),
  hex: z.string().nullable().optional(),
  rawBase64: z.string().nullable().optional(),
});

export const DataEntryMutationOutputSchema = TxSubmitOutputSchema.extend({
  name: z.string(),
  action: z.enum(['set', 'delete']),
});

export const DataEntryOutputSchema = z.union([
  DataEntryGetOutputSchema,
  DataEntryMutationOutputSchema,
]);

// ─── sequence_number ────────────────────────────────────────────────────────

export const SequenceNumberGetOutputSchema = z.object({
  accountId: z.string(),
  sequence: z.string(),
});

export const SequenceNumberBumpOutputSchema = TxSubmitOutputSchema.extend({
  bumpedTo: z.string(),
  sequence: z.string(),
});

export const SequenceNumberOutputSchema = z.union([
  SequenceNumberGetOutputSchema,
  SequenceNumberBumpOutputSchema,
]);

// ─── sponsored_account ──────────────────────────────────────────────────────

export const SponsoredAccountOutputSchema = TxSubmitOutputSchema.extend({
  newAccountPublicKey: z.string(),
  startingBalance: z.string(),
});

// ─── inflation ──────────────────────────────────────────────────────────────

export const InflationSetOutputSchema = z.object({
  action: z.literal('set'),
  txHash: z.string(),
  ledger: z.number(),
  inflationDestination: z.string(),
});

export const InflationGetOutputSchema = z.object({
  action: z.literal('get'),
  accountId: z.string(),
  inflationDestination: z.string().nullable(),
  isSet: z.boolean(),
});

export const InflationOutputSchema = z.union([InflationSetOutputSchema, InflationGetOutputSchema]);

// ─── soroban_deploy ─────────────────────────────────────────────────────────

export const SorobanDeployOutputSchema = z.object({
  action: z.enum(['upload', 'instantiate', 'deploy']),
  wasmHash: z.string().optional(),
  contractId: z.string().optional(),
  txHash: z.string().optional(),
});

// ─── account_history ────────────────────────────────────────────────────────

export const PaymentRecordOutputSchema = z.object({
  id: z.string(),
  type: z.string(),
  from: z.string(),
  to: z.string(),
  amount: z.string(),
  asset: z.string(),
  createdAt: z.string(),
  pagingToken: z.string(),
});

export const AccountHistoryOutputSchema = z.object({
  records: z.array(PaymentRecordOutputSchema),
  nextCursor: z.string().nullable(),
});

// ─── soroban_events ─────────────────────────────────────────────────────────

export const SorobanEventIndexerOutputSchema = z.object({
  events: z.array(z.unknown()),
  latestLedger: z.number(),
});

// ─── web_auth ───────────────────────────────────────────────────────────────

export const WebAuthOutputSchema = z.object({
  token: z.string(),
});

// ─── anchor_quote ───────────────────────────────────────────────────────────

/**
 * Mirrors `AnchorQuoteResponseSchema` (backend/tools/AnchorQuoteTool.ts) as
 * an independent copy rather than importing it directly: `outputSchema` is
 * read on every dispatch (see `ToolRegistry.dispatch`'s soft output check),
 * and several tests mock `AnchorQuoteTool`'s module wholesale without
 * re-exporting its schemas — importing it here would dereference a missing
 * mock export on every anchor_quote call in those tests.
 */
const AnchorQuoteFeeOutputSchema = z.object({
  total: z.string().optional(),
  asset: z.string().optional(),
  details: z
    .array(
      z.object({
        name: z.string(),
        description: z.string().optional(),
        amount: z.string(),
      })
    )
    .optional(),
});

export const AnchorQuoteOutputSchema = z
  .object({
    price: z.string(),
    total_price: z.string().optional(),
    expires_at: z.string().optional(),
    sell_amount: z.string().optional(),
    buy_amount: z.string().optional(),
    fee: AnchorQuoteFeeOutputSchema.optional(),
  })
  .passthrough();
