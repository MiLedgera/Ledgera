/**
 * backend/tool_contract.ts
 *
 * The single `Tool` contract every agent-dispatched capability conforms to.
 *
 * Why this exists: a survey of backend/tools/ (~26 agent-facing tools) found
 * no two tools agreeing on a method name (`execute`/`fetch`/`query`/`respond`),
 * a return shape (bare strings, bespoke interfaces, inconsistent `{txHash,
 * ledger}` envelopes), or an error-throwing convention. `PayFiAgent` dispatched
 * through a ~25-branch hand-written switch that duplicated payload field
 * extraction per task type. This contract — and the registry built on top of
 * it in `backend/tool_registry.ts` — replaces that switch with data: one
 * `ToolDefinition` per task type, listing everything the dispatcher, a test,
 * or an LLM function-calling integration needs to know about it.
 *
 * Deliberately NOT part of the runtime dispatch path: `inputSchema` is not
 * re-parsed by the registry before calling `execute` — each tool already
 * validates its own raw input internally (as it always has), and re-parsing
 * an already-validated object through the same Zod schema a second time risks
 * double-applying a `.transform()`. `inputSchema`/`outputSchema` exist for
 * introspection and JSON Schema generation (`ToolRegistry.toJSONSchema`) and
 * for a soft (warn-only, never throwing) output sanity check — see
 * `ToolRegistry.dispatch`'s doc comment.
 */

import type { z } from 'zod';

/**
 * How much latitude a tool has to affect the agent's holdings or on-chain
 * account state:
 *
 * - `read_only` — never builds or submits a transaction. Cannot fail a
 *   spending check because it never spends anything.
 * - `value_moving` — moves an asset amount the agent owns (a payment, swap,
 *   offer, pool deposit, claimable balance creation, sponsored funding, …).
 *   These are the tools `policyCheck` exists for: the caller-visible dollar
 *   amount is checked against `AGENT_SPENDING_LIMIT`/`MAINNET_SPENDING_CAP`
 *   before `execute` runs.
 * - `destructive` — submits a transaction and changes on-chain account state
 *   (trustlines, account flags, data entries, contract deployment, signing
 *   authority, sequence numbers, …) but does not itself move a denominated
 *   asset amount, so it has no spending-limit check.
 */
export type ToolRiskLevel = 'read_only' | 'value_moving' | 'destructive';

/** Per-call context threaded through every tool invocation. */
export interface ToolExecutionContext {
  /**
   * Correlation ID for this task (see `AgentTask.correlationId`). Value-moving
   * tools that support idempotent resubmission (currently `stellar_payment`,
   * via `backend/tx_idempotency.ts`) use this as the idempotency key.
   */
  correlationId: string;
}

/**
 * A business-rule check run against the *raw* (pre-parse) payload before
 * `execute` is called — e.g. the spending-limit assertions that used to be
 * hand-threaded into ~10 branches of `PayFiAgent`'s dispatch switch. Throws
 * (typically a `PolicyError`) to reject the task before any network call.
 *
 * Receives the same raw, duck-typed payload the old switch branches did —
 * not a Zod-parsed object — so this is a verbatim relocation of existing
 * logic, not a rewrite of it.
 */
export type ToolPolicyCheck = (rawPayload: unknown, ctx: ToolExecutionContext) => void;

export interface ToolDefinition<TInput = unknown, TOutput = unknown> {
  /** Stable identifier — matches `AgentTask['type']` exactly. */
  name: string;
  /** Human/LLM-facing summary of what this tool does and when to use it. */
  description: string;
  /**
   * Lazy on purpose: many tests mock a tool's module wholesale (replacing
   * the class export) without also re-exporting that module's Zod input
   * schema, since nothing previously needed it from the outside. Reading the
   * schema eagerly — e.g. as a plain object property set once at module
   * load — would dereference that missing mock export the moment
   * `buildToolDefinitions` runs, before any test gets to configure anything.
   * A thunk defers the read to `toJSONSchema()`'s call site, which nothing
   * in the normal dispatch path (`ToolRegistry.dispatch`) ever triggers.
   */
  inputSchema: () => z.ZodType<TInput>;
  outputSchema: z.ZodType<TOutput>;
  riskLevel: ToolRiskLevel;
  /** Present only on tools with a spending-limit (or similar) policy gate. */
  policyCheck?: ToolPolicyCheck;
  /**
   * Adapter calling into the tool's own existing method. Receives the raw,
   * unparsed payload — see this module's doc comment for why.
   */
  execute: (rawPayload: unknown, ctx: ToolExecutionContext) => Promise<TOutput>;
}
