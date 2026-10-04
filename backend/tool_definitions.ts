/**
 * backend/tool_definitions.ts
 *
 * One `ToolDefinition` per `AgentTask['type']`, built from a `PayFiAgent`
 * instance's own tool objects (passed in by `buildToolDefinitions` — the
 * registry does not construct or own any tool instance itself, so
 * `new PayFiAgent()` keeps creating fresh tool instances exactly as it did
 * before this refactor; see this function's doc comment).
 *
 * `policyCheck` bodies below are relocated verbatim from the switch that
 * used to live in `PayFiAgent.executeTask` — same duck-typed field access on
 * the raw payload, same `assertWithinSpendingLimit` calls, same per-asset
 * batch aggregation. Nothing about *what* is checked changed, only *where*
 * the check lives.
 */

import { config } from './config';
import { PolicyError } from './errors';
import { spendingTracker } from './spending_tracker';
import { MAINNET_SPENDING_CAP } from './config';
import type { ToolDefinition, ToolExecutionContext } from './tool_contract';

import { StellarPaymentTool, PaymentInputSchema } from './tools/StellarPaymentTool';
import { SorobanInvokeTool, SorobanInvokeInputSchema } from './tools/SorobanInvokeTool';
import { SorobanQueryTool, SorobanQueryInputSchema } from './tools/SorobanQueryTool';
import { X402PaymentTool, X402ChallengeSchema } from './tools/X402PaymentTool';
import { AccountInfoTool } from './tools/AccountInfoTool';
import { TrustlineTool, TrustlineInputSchema } from './tools/TrustlineTool';
import { MultiSigPaymentTool, MultiSigInputSchema } from './tools/MultiSigPaymentTool';
import { BatchPaymentTool, BatchPaymentInputSchema } from './tools/BatchPaymentTool';
import { BalanceCheckTool, BalanceCheckInputSchema } from './tools/BalanceCheckTool';
import { PathPaymentTool, PathPaymentInputSchema } from './tools/PathPaymentTool';
import { FeeBumpTool, FeeBumpInputSchema } from './tools/FeeBumpTool';
import { DexOfferTool, DexOfferInputSchema } from './tools/DexOfferTool';
import { LiquidityPoolTool, LiquidityPoolInputSchema } from './tools/LiquidityPoolTool';
import { StellarTomlTool, StellarTomlInputSchema } from './tools/StellarTomlTool';
import { DataEntryTool, DataEntryInputSchema } from './tools/DataEntryTool';
import { SequenceNumberTool, SequenceNumberInputSchema } from './tools/SequenceNumberTool';
import { SponsoredAccountTool, SponsoredAccountInputSchema } from './tools/SponsoredAccountTool';
import { AnchorQuoteTool, AnchorQuoteInputSchema } from './tools/AnchorQuoteTool';
import { InflationTool, InflationInputSchema } from './tools/InflationTool';
import { SorobanDeployTool, SorobanDeployInputSchema } from './tools/SorobanDeployTool';
import { SwapTool, SwapInputSchema } from './tools/SwapTool';
import { AccountHistoryTool, AccountHistoryInputSchema } from './tools/AccountHistoryTool';
import { ClaimableBalanceTool, ClaimableBalanceInputSchema } from './tools/ClaimableBalanceTool';
import { SetOptionsTool, SetOptionsInputSchema } from './tools/SetOptionsTool';
import {
  SorobanEventIndexerTool,
  SorobanEventIndexerInputSchema,
} from './tools/SorobanEventIndexerTool';
import { StellarIdentityTool, WebAuthInputSchema } from './tools/StellarIdentityTool';

import {
  NoInputSchema,
  TxSubmitOutputSchema,
  StellarPaymentOutputSchema,
  SorobanInvokeOutputSchema,
  SorobanQueryOutputSchema,
  X402PaymentProofOutputSchema,
  AccountInfoOutputSchema,
  MultiSigOutputSchema,
  BatchPaymentOutputSchema,
  BalanceCheckOutputSchema,
  DexOfferOutputSchema,
  LiquidityPoolOutputSchema,
  StellarTomlOutputSchema,
  DataEntryOutputSchema,
  SequenceNumberOutputSchema,
  SponsoredAccountOutputSchema,
  InflationOutputSchema,
  SorobanDeployOutputSchema,
  AccountHistoryOutputSchema,
  SorobanEventIndexerOutputSchema,
  WebAuthOutputSchema,
  AnchorQuoteOutputSchema,
} from './tool_output_schemas';

/** Verbatim copy of agent.ts's internal spending-limit guard (kept private to that module). */
function assertWithinSpendingLimit(
  amount: unknown,
  assetCode?: unknown,
  assetIssuer?: unknown
): void {
  if (typeof amount !== 'string') return;
  const rawParsed = parseFloat(amount);
  if (isNaN(rawParsed)) return;

  const code = typeof assetCode === 'string' ? assetCode : undefined;
  const issuer = typeof assetIssuer === 'string' ? assetIssuer : undefined;
  const isReferenceAsset =
    code === undefined ||
    code === 'XLM' ||
    (code === config.X402_ASSET_CODE &&
      (issuer === undefined || issuer === config.X402_ASSET_ISSUER));

  let parsed: number;
  let assetLabel: string;
  if (isReferenceAsset || code === undefined) {
    parsed = rawParsed;
    assetLabel = code ?? config.X402_ASSET_CODE;
  } else if (config.SPENDING_LIMIT_UNKNOWN_ASSET_POLICY === 'reject') {
    throw new PolicyError(
      `Payment asset ${code} is not XLM or the configured reference asset ` +
        `(${config.X402_ASSET_CODE}) — the spending-limit guard cannot evaluate ` +
        `it without a conversion rate. Set SPENDING_LIMIT_UNKNOWN_ASSET_POLICY=convert ` +
        `and configure ASSET_CONVERSION_RATES to allow payments in ${code}.`
    );
  } else {
    const rate = config.ASSET_CONVERSION_RATES?.[code];
    if (rate === undefined) {
      throw new PolicyError(
        `No conversion rate configured for asset ${code} in ASSET_CONVERSION_RATES — ` +
          `cannot evaluate the spending limit for amount ${amount} ${code}`
      );
    }
    parsed = rawParsed * rate;
    assetLabel = `${config.X402_ASSET_CODE} (converted from ${amount} ${code} at rate ${rate})`;
  }

  const limit = parseFloat(config.AGENT_SPENDING_LIMIT);
  if (parsed > limit) {
    throw new PolicyError(
      `Payment amount ${amount} ${assetLabel} exceeds AGENT_SPENDING_LIMIT of ${config.AGENT_SPENDING_LIMIT}`
    );
  }
  if (config.STELLAR_NETWORK === 'mainnet' && parsed > MAINNET_SPENDING_CAP) {
    throw new PolicyError(
      `Payment amount ${amount} ${assetLabel} exceeds mainnet spending cap of ${MAINNET_SPENDING_CAP}`
    );
  }

  spendingTracker.record(String(parsed));
}

/** The tool instances a `PayFiAgent` constructs — one definition is built per field. */
export interface ToolInstances {
  paymentTool: StellarPaymentTool;
  sorobanTool: SorobanInvokeTool;
  sorobanQueryTool: SorobanQueryTool;
  x402Tool: X402PaymentTool;
  accountInfoTool: AccountInfoTool;
  trustlineTool: TrustlineTool;
  multiSigTool: MultiSigPaymentTool;
  batchPaymentTool: BatchPaymentTool;
  balanceCheckTool: BalanceCheckTool;
  pathPaymentTool: PathPaymentTool;
  feeBumpTool: FeeBumpTool;
  dexOfferTool: DexOfferTool;
  liquidityPoolTool: LiquidityPoolTool;
  stellarTomlTool: StellarTomlTool;
  dataEntryTool: DataEntryTool;
  sequenceNumberTool: SequenceNumberTool;
  sponsoredAccountTool: SponsoredAccountTool;
  anchorQuoteTool: AnchorQuoteTool;
  inflationTool: InflationTool;
  sorobanDeployTool: SorobanDeployTool;
  swapTool: SwapTool;
  accountHistoryTool: AccountHistoryTool;
  claimableBalanceTool: ClaimableBalanceTool;
  setOptionsTool: SetOptionsTool;
  sorobanEventIndexerTool: SorobanEventIndexerTool;
  stellarIdentityTool: StellarIdentityTool;
}

/**
 * Build the full set of `ToolDefinition`s for one `PayFiAgent` instance's
 * tools. Called once from `PayFiAgent`'s constructor, after it constructs
 * `tools` exactly as before — this function only wires existing instances
 * into the registry, it never constructs a tool itself. That keeps each
 * `new PayFiAgent()` call creating its own fresh tool instances (needed for
 * tests that mock a tool class and assert on a specific instance's calls),
 * rather than sharing module-level singletons across every agent.
 */
export function buildToolDefinitions(tools: ToolInstances): ToolDefinition[] {
  return [
    {
      name: 'stellar_payment',
      description:
        'Send a native XLM or custom-asset payment from the agent account to a destination address.',
      inputSchema: () => PaymentInputSchema,
      outputSchema: StellarPaymentOutputSchema,
      riskLevel: 'value_moving',
      policyCheck: (raw) => {
        const p = raw as Record<string, unknown>;
        assertWithinSpendingLimit(p?.amount, p?.assetCode, p?.assetIssuer);
      },
      execute: async (raw, ctx: ToolExecutionContext) => {
        const result = await tools.paymentTool.execute(raw, ctx.correlationId);
        return { ...result, network: config.STELLAR_NETWORK };
      },
    },
    {
      name: 'soroban_invoke',
      description:
        'Invoke a Soroban smart contract function, or simulate it (simulateOnly) without broadcasting. ' +
        'Enforces its own spending limit against simulated internal asset transfers.',
      inputSchema: () => SorobanInvokeInputSchema,
      outputSchema: SorobanInvokeOutputSchema,
      // Can move value via internal SAC transfers, but polices its own cap
      // from the simulated transaction rather than via an external policyCheck.
      riskLevel: 'value_moving',
      execute: (raw) => tools.sorobanTool.execute(raw),
    },
    {
      name: 'soroban_query',
      description: 'Simulate a Soroban contract call read-only; never broadcasts a transaction.',
      inputSchema: () => SorobanQueryInputSchema,
      outputSchema: SorobanQueryOutputSchema,
      riskLevel: 'read_only',
      execute: (raw) => tools.sorobanQueryTool.query(raw),
    },
    {
      name: 'x402_respond',
      description:
        'Respond to an x402 "402 Payment Required" challenge by executing a Stellar payment and returning a signed proof of payment.',
      inputSchema: () => X402ChallengeSchema,
      outputSchema: X402PaymentProofOutputSchema,
      riskLevel: 'value_moving',
      policyCheck: (raw) => {
        const p = raw as Record<string, unknown>;
        assertWithinSpendingLimit(p?.amount, p?.assetCode, p?.assetIssuer);
      },
      execute: (raw) => tools.x402Tool.respond(raw),
    },
    {
      name: 'account_info',
      description: "Fetch the agent's own account balances, sequence number, and subentry count.",
      inputSchema: () => NoInputSchema,
      outputSchema: AccountInfoOutputSchema,
      riskLevel: 'read_only',
      execute: () => tools.accountInfoTool.fetch(),
    },
    {
      name: 'change_trust',
      description: 'Add or remove a trustline for a custom asset on the agent account.',
      inputSchema: () => TrustlineInputSchema,
      outputSchema: TxSubmitOutputSchema,
      riskLevel: 'destructive',
      execute: (raw) => tools.trustlineTool.execute(raw),
    },
    {
      name: 'multisig_payment',
      description:
        'Build (and, once enough signatures are present, submit) an M-of-N multi-signature payment.',
      inputSchema: () => MultiSigInputSchema,
      outputSchema: MultiSigOutputSchema,
      riskLevel: 'value_moving',
      policyCheck: (raw) => {
        const p = raw as Record<string, unknown>;
        assertWithinSpendingLimit(p?.amount, p?.assetCode, p?.assetIssuer);
      },
      execute: (raw) => tools.multiSigTool.execute(raw),
    },
    {
      name: 'batch_payment',
      description:
        'Execute 1-100 payment operations atomically in a single transaction. Spending limit is enforced on the aggregate, per asset.',
      inputSchema: () => BatchPaymentInputSchema,
      outputSchema: BatchPaymentOutputSchema,
      riskLevel: 'value_moving',
      policyCheck: (raw) => {
        const p = raw as Record<string, unknown>;
        const payments = Array.isArray(p?.payments) ? (p.payments as unknown[]) : [];
        // Payments can mix assets — aggregate per asset, not as one undifferentiated sum.
        const totalsByAsset = new Map<
          string,
          { total: number; assetCode?: unknown; assetIssuer?: unknown }
        >();
        for (const payment of payments) {
          const pp = payment as Record<string, unknown>;
          const amt = parseFloat(String(pp?.amount));
          if (isNaN(amt)) continue;
          const assetCode = pp?.assetCode;
          const assetIssuer = pp?.assetIssuer;
          const key = `${String(assetCode ?? 'XLM')}:${String(assetIssuer ?? '')}`;
          const existing = totalsByAsset.get(key);
          if (existing) {
            existing.total += amt;
          } else {
            totalsByAsset.set(key, { total: amt, assetCode, assetIssuer });
          }
        }
        for (const { total, assetCode, assetIssuer } of totalsByAsset.values()) {
          assertWithinSpendingLimit(total > 0 ? String(total) : undefined, assetCode, assetIssuer);
        }
      },
      execute: (raw) => tools.batchPaymentTool.execute(raw),
    },
    {
      name: 'balance_check',
      description: "Look up an account's balance of a specific asset (or XLM).",
      inputSchema: () => BalanceCheckInputSchema,
      outputSchema: BalanceCheckOutputSchema,
      riskLevel: 'read_only',
      execute: (raw) => {
        // Historical duck-typed fallback, preserved verbatim: some callers
        // (and a wide swath of the test suite's mocks) construct a
        // BalanceCheckTool-shaped object exposing `getBalance` instead of
        // `execute`.
        const tool = tools.balanceCheckTool as unknown as {
          execute?: (payload: unknown) => Promise<unknown>;
          getBalance?: (payload: unknown) => Promise<unknown>;
        };
        if (typeof tool.execute === 'function') {
          return tool.execute(raw);
        }
        if (typeof tool.getBalance === 'function') {
          return tool.getBalance(raw);
        }
        throw new Error('Balance check tool does not implement execute() or getBalance().');
      },
    },
    {
      name: 'path_payment',
      description:
        'Send one asset and have the recipient receive a different asset via the Stellar DEX (pathPaymentStrictSend).',
      inputSchema: () => PathPaymentInputSchema,
      outputSchema: TxSubmitOutputSchema,
      riskLevel: 'value_moving',
      policyCheck: (raw) => {
        const p = raw as Record<string, unknown>;
        const sendAsset = p?.sendAsset as Record<string, unknown> | undefined;
        assertWithinSpendingLimit(p?.sendAmount, sendAsset?.code, sendAsset?.issuer);
      },
      execute: (raw) => tools.pathPaymentTool.execute(raw),
    },
    {
      name: 'fee_bump',
      description: 'Wrap a previously-built transaction in a fee-bump envelope and resubmit it.',
      inputSchema: () => FeeBumpInputSchema,
      outputSchema: TxSubmitOutputSchema,
      riskLevel: 'destructive',
      execute: (raw) => tools.feeBumpTool.execute(raw),
    },
    {
      name: 'dex_offer',
      description: 'Create, update, or delete a manage-sell offer on the Stellar DEX order book.',
      inputSchema: () => DexOfferInputSchema,
      outputSchema: DexOfferOutputSchema,
      riskLevel: 'value_moving',
      policyCheck: (raw) => {
        const p = raw as Record<string, unknown>;
        // "delete" always submits amount "0" on-chain and reduces exposure
        // rather than creating it, so only create/update are checked.
        if (p?.action !== 'delete') {
          const selling = p?.selling as Record<string, unknown> | undefined;
          assertWithinSpendingLimit(p?.amount, selling?.code, selling?.issuer);
        }
      },
      execute: (raw) => tools.dexOfferTool.execute(raw),
    },
    {
      name: 'swap',
      description:
        'Atomically swap one asset for another via strict-send path discovery with a slippage tolerance.',
      inputSchema: () => SwapInputSchema,
      outputSchema: TxSubmitOutputSchema,
      riskLevel: 'value_moving',
      policyCheck: (raw) => {
        const p = raw as Record<string, unknown>;
        const sellAsset = p?.sellAsset as Record<string, unknown> | undefined;
        assertWithinSpendingLimit(p?.sellAmount, sellAsset?.code, sellAsset?.issuer);
      },
      execute: (raw) => tools.swapTool.execute(raw),
    },
    {
      name: 'account_history',
      description: 'Fetch paginated payment operations for an account.',
      inputSchema: () => AccountHistoryInputSchema,
      outputSchema: AccountHistoryOutputSchema,
      riskLevel: 'read_only',
      execute: (raw) => tools.accountHistoryTool.fetch(raw),
    },
    {
      name: 'soroban_deploy',
      description: 'Upload Soroban WASM bytecode and/or instantiate a contract from it.',
      inputSchema: () => SorobanDeployInputSchema,
      outputSchema: SorobanDeployOutputSchema,
      riskLevel: 'destructive',
      execute: (raw) => tools.sorobanDeployTool.execute(raw),
    },
    {
      name: 'liquidity_pool',
      description: 'Deposit into, withdraw from, or fetch info about a Stellar liquidity pool.',
      inputSchema: () => LiquidityPoolInputSchema,
      outputSchema: LiquidityPoolOutputSchema,
      riskLevel: 'value_moving',
      policyCheck: (raw) => {
        const p = raw as Record<string, unknown>;
        // Only "deposit" commits new funds; "withdraw" returns funds and
        // "info" is read-only, so neither is checked.
        if (p?.action === 'deposit') {
          const assetA = p?.assetA as Record<string, unknown> | undefined;
          const assetB = p?.assetB as Record<string, unknown> | undefined;
          assertWithinSpendingLimit(p?.maxAmountA, assetA?.code, assetA?.issuer);
          assertWithinSpendingLimit(p?.maxAmountB, assetB?.code, assetB?.issuer);
        }
      },
      execute: (raw) => tools.liquidityPoolTool.execute(raw),
    },
    {
      name: 'stellar_toml',
      description: "Fetch and parse a domain's SEP-0001 stellar.toml file (cached).",
      inputSchema: () => StellarTomlInputSchema,
      outputSchema: StellarTomlOutputSchema,
      riskLevel: 'read_only',
      execute: (raw) => tools.stellarTomlTool.fetchToml(raw),
    },
    {
      name: 'data_entry',
      description: 'Read, write, or delete a Stellar account data entry (MANAGE_DATA).',
      inputSchema: () => DataEntryInputSchema,
      outputSchema: DataEntryOutputSchema,
      riskLevel: 'destructive',
      execute: (raw) => tools.dataEntryTool.execute(raw),
    },
    {
      name: 'sequence_number',
      description: "Read or bump the agent account's sequence number.",
      inputSchema: () => SequenceNumberInputSchema,
      outputSchema: SequenceNumberOutputSchema,
      riskLevel: 'destructive',
      execute: (raw) => tools.sequenceNumberTool.execute(raw),
    },
    {
      name: 'sponsored_account',
      description: "Create a new account sponsored by the agent's reserve.",
      inputSchema: () => SponsoredAccountInputSchema,
      outputSchema: SponsoredAccountOutputSchema,
      riskLevel: 'value_moving',
      policyCheck: (raw) => {
        const p = raw as Record<string, unknown>;
        assertWithinSpendingLimit(p?.startingBalance);
      },
      execute: (raw) => tools.sponsoredAccountTool.execute(raw),
    },
    {
      name: 'anchor_quote',
      description: 'Fetch a SEP-0038 firm/indicative quote from a Stellar anchor.',
      inputSchema: () => AnchorQuoteInputSchema,
      outputSchema: AnchorQuoteOutputSchema,
      riskLevel: 'read_only',
      execute: (raw) => tools.anchorQuoteTool.execute(raw),
    },
    {
      name: 'inflation',
      description: "Set or read the agent account's inflation destination.",
      inputSchema: () => InflationInputSchema,
      outputSchema: InflationOutputSchema,
      riskLevel: 'destructive',
      execute: (raw) => tools.inflationTool.execute(raw),
    },
    {
      name: 'claimable_balance',
      description:
        'Create a claimable balance for one or more claimants, or claim an existing one.',
      inputSchema: () => ClaimableBalanceInputSchema,
      outputSchema: TxSubmitOutputSchema,
      riskLevel: 'value_moving',
      policyCheck: (raw) => {
        const p = raw as Record<string, unknown>;
        if (p?.action === 'create') {
          assertWithinSpendingLimit(p?.amount, p?.assetCode, p?.assetIssuer);
        }
      },
      execute: (raw) => tools.claimableBalanceTool.execute(raw),
    },
    {
      name: 'set_options',
      description:
        "Manage the agent account's flags, signing thresholds, and home domain (SET_OPTIONS).",
      inputSchema: () => SetOptionsInputSchema,
      outputSchema: TxSubmitOutputSchema,
      riskLevel: 'destructive',
      execute: (raw) => tools.setOptionsTool.execute(raw),
    },
    {
      name: 'soroban_events',
      description: 'Query historical Soroban contract events over a ledger range.',
      inputSchema: () => SorobanEventIndexerInputSchema,
      outputSchema: SorobanEventIndexerOutputSchema,
      riskLevel: 'read_only',
      execute: (raw) => tools.sorobanEventIndexerTool.query(raw),
    },
    {
      name: 'web_auth',
      description: 'Complete a SEP-0010 web-auth challenge-response and return the resulting JWT.',
      inputSchema: () => WebAuthInputSchema,
      outputSchema: WebAuthOutputSchema,
      riskLevel: 'read_only',
      execute: (raw) => tools.stellarIdentityTool.execute(raw),
    },
  ];
}
