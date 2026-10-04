/**
 * tests/tool_registry.test.ts
 *
 * Coverage for the Tool contract/registry refactor (#512):
 *
 *   - Every AgentTask type has exactly one registered ToolDefinition.
 *   - toJSONSchema()/toJSONSchemaAll() produce valid OpenAI/Anthropic-style
 *     function-calling definitions ({name, description, parameters}) for
 *     every registered tool, derived from each tool's own Zod input schema.
 *   - dispatch() runs a tool's policyCheck before execute — a throwing
 *     policyCheck must prevent execute from ever being called.
 *   - dispatch() on an unregistered name throws "Unknown task type".
 *   - The output-schema check is soft: a mismatched result is still
 *     returned, never thrown.
 *   - register() rejects a duplicate name.
 *
 * Uses real backend/tool_contract.ts + backend/tool_registry.ts with small
 * hand-built ToolDefinition fixtures — not the full backend/tool_definitions.ts
 * wiring (that's covered end-to-end by tests/agent.test.ts's dispatch-matrix
 * suite, which already exercises every real tool through PayFiAgent).
 */

import { describe, it, expect, vi, beforeAll } from 'vitest';
import { z } from 'zod';
import { ToolRegistry } from '../backend/tool_registry';
import type { ToolDefinition } from '../backend/tool_contract';

// backend/tool_definitions.ts imports the real tool modules (unmocked, since
// this file exercises buildToolDefinitions directly rather than going
// through PayFiAgent's per-tool mocks the way tests/agent.test.ts does).
// Several of those modules build a Zod schema with a config-derived default
// at module-load time (e.g. X402PaymentTool's X402ChallengeSchema), so
// config must be mocked before tool_definitions.ts is ever imported, or the
// real (unset-in-CI) config Proxy throws immediately on first property read.
vi.mock('../backend/config', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { Keypair } = require('@stellar/stellar-sdk');
  const secret = 'SADQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQP54X';
  return {
    config: {
      STELLAR_NETWORK: 'testnet',
      HORIZON_URL: 'https://horizon-testnet.stellar.org',
      SOROBAN_RPC_URL: 'https://soroban-testnet.stellar.org',
      AGENT_PUBLIC_KEY: Keypair.fromSecret(secret).publicKey(),
      agentKeypair: () => Keypair.fromSecret(secret),
      X402_ASSET_CODE: 'USDC',
      X402_ASSET_ISSUER: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
      AGENT_SPENDING_LIMIT: '1000',
      SPENDING_LIMIT_UNKNOWN_ASSET_POLICY: 'reject',
      MAX_RETRIES: 3,
      RETRY_DELAY_MS: 100,
      RPC_TIMEOUT_MS: 9000,
      ACCOUNT_CACHE_TTL_MS: 30_000,
      MAX_X402_PAYMENTS_PER_MINUTE: 10,
      MAX_SOROBAN_FEE_STROOPS: 1_000_000,
      TOML_CACHE_TTL_MS: 300_000,
      DB_PATH: ':memory:',
    },
    MAINNET_SPENDING_CAP: 10_000,
  };
});

function makeDefinition(overrides: Partial<ToolDefinition> = {}): ToolDefinition {
  return {
    name: 'test_tool',
    description: 'A test tool',
    inputSchema: () => z.object({ foo: z.string() }),
    outputSchema: z.object({ bar: z.string() }),
    riskLevel: 'read_only',
    execute: async () => ({ bar: 'baz' }),
    ...overrides,
  };
}

describe('ToolRegistry — registration', () => {
  it('registers and retrieves a tool by name', () => {
    const registry = new ToolRegistry();
    const def = makeDefinition();
    registry.register(def);

    expect(registry.has('test_tool')).toBe(true);
    expect(registry.get('test_tool')).toBe(def);
  });

  it('rejects registering two tools under the same name', () => {
    const registry = new ToolRegistry();
    registry.register(makeDefinition());

    expect(() => registry.register(makeDefinition())).toThrow(/already registered/);
  });

  it('list() returns every registered definition', () => {
    const registry = new ToolRegistry();
    registry.register(makeDefinition({ name: 'a' }));
    registry.register(makeDefinition({ name: 'b' }));

    expect(
      registry
        .list()
        .map((d) => d.name)
        .sort()
    ).toEqual(['a', 'b']);
  });

  it('listByRiskLevel() filters by risk level', () => {
    const registry = new ToolRegistry();
    registry.register(makeDefinition({ name: 'read', riskLevel: 'read_only' }));
    registry.register(makeDefinition({ name: 'move', riskLevel: 'value_moving' }));
    registry.register(makeDefinition({ name: 'destroy', riskLevel: 'destructive' }));

    expect(registry.listByRiskLevel('value_moving').map((d) => d.name)).toEqual(['move']);
  });
});

describe('ToolRegistry — dispatch', () => {
  it('runs policyCheck before execute, and a throwing policyCheck prevents execute entirely', async () => {
    const registry = new ToolRegistry();
    const execute = vi.fn().mockResolvedValue({ bar: 'baz' });
    registry.register(
      makeDefinition({
        policyCheck: () => {
          throw new Error('policy violation');
        },
        execute,
      })
    );

    await expect(
      registry.dispatch('test_tool', { foo: 'x' }, { correlationId: 'c1' })
    ).rejects.toThrow('policy violation');
    expect(execute).not.toHaveBeenCalled();
  });

  it('calls execute when policyCheck passes', async () => {
    const registry = new ToolRegistry();
    const execute = vi.fn().mockResolvedValue({ bar: 'baz' });
    registry.register(makeDefinition({ policyCheck: () => undefined, execute }));

    const result = await registry.dispatch('test_tool', { foo: 'x' }, { correlationId: 'c1' });

    expect(execute).toHaveBeenCalledWith({ foo: 'x' }, { correlationId: 'c1' });
    expect(result).toEqual({ bar: 'baz' });
  });

  it('passes the raw payload through unparsed — never re-validates it against inputSchema', async () => {
    const execute = vi.fn().mockResolvedValue({ bar: 'baz' });
    const registry = new ToolRegistry();
    registry.register(makeDefinition({ execute }));

    // A payload that would fail `inputSchema` (missing `foo`) still reaches
    // execute — the registry's contract is explicit that it never re-parses
    // raw input itself; each tool validates its own input internally.
    await registry.dispatch('test_tool', { unrelated: true }, { correlationId: 'c1' });
    expect(execute).toHaveBeenCalledWith({ unrelated: true }, { correlationId: 'c1' });
  });

  it('throws "Unknown task type" for an unregistered name', async () => {
    const registry = new ToolRegistry();
    await expect(registry.dispatch('does_not_exist', {}, { correlationId: 'c1' })).rejects.toThrow(
      /Unknown task type: does_not_exist/
    );
  });

  it('a result that does not match outputSchema is still returned (soft check, never throws)', async () => {
    const registry = new ToolRegistry();
    registry.register(
      makeDefinition({
        outputSchema: z.object({ expectedField: z.string() }),
        execute: async () => ({ somethingElse: 123 }) as never,
      })
    );

    const result = await registry.dispatch('test_tool', {}, { correlationId: 'c1' });
    expect(result).toEqual({ somethingElse: 123 });
  });
});

describe('ToolRegistry — JSON Schema generation', () => {
  it('toJSONSchema() produces a {name, description, parameters} function-calling definition', () => {
    const registry = new ToolRegistry();
    registry.register(
      makeDefinition({
        name: 'greet',
        description: 'Say hello to someone',
        inputSchema: () => z.object({ name: z.string().min(1), loud: z.boolean().optional() }),
      })
    );

    const schema = registry.toJSONSchema('greet');

    expect(schema.name).toBe('greet');
    expect(schema.description).toBe('Say hello to someone');
    expect(schema.parameters).toMatchObject({
      type: 'object',
      properties: {
        name: { type: 'string' },
        loud: { type: 'boolean' },
      },
      required: ['name'],
    });
  });

  it('does not emit $ref/definitions indirection for a simple schema', () => {
    const registry = new ToolRegistry();
    registry.register(makeDefinition({ name: 'simple' }));

    const schema = registry.toJSONSchema('simple');
    expect(schema.parameters).not.toHaveProperty('$ref');
    expect(schema.parameters).not.toHaveProperty('definitions');
  });

  it('toJSONSchemaAll() returns one entry per registered tool', () => {
    const registry = new ToolRegistry();
    registry.register(makeDefinition({ name: 'a' }));
    registry.register(makeDefinition({ name: 'b' }));
    registry.register(makeDefinition({ name: 'c' }));

    const all = registry.toJSONSchemaAll();
    expect(all.map((s) => s.name).sort()).toEqual(['a', 'b', 'c']);
    for (const s of all) {
      expect(s.parameters).toHaveProperty('type', 'object');
    }
  });

  it('toJSONSchema() throws for an unregistered name', () => {
    const registry = new ToolRegistry();
    expect(() => registry.toJSONSchema('nope')).toThrow(/Unknown task type: nope/);
  });

  it("the input schema's lazy thunk is only invoked by toJSONSchema, never by dispatch", async () => {
    const inputSchema = vi.fn(() => z.object({ foo: z.string() }));
    const registry = new ToolRegistry();
    registry.register(makeDefinition({ inputSchema }));

    await registry.dispatch('test_tool', { foo: 'x' }, { correlationId: 'c1' });
    expect(inputSchema).not.toHaveBeenCalled();

    registry.toJSONSchema('test_tool');
    expect(inputSchema).toHaveBeenCalledTimes(1);
  });
});

// ─── buildToolDefinitions — every real AgentTask type ──────────────────────
//
// Exercises backend/tool_definitions.ts directly, against minimal stub tool
// instances rather than a fully-constructed PayFiAgent (which needs a valid
// config/keypair). The full real wiring — actual tool classes, actual
// mocked network calls — is already covered end-to-end by
// tests/agent.test.ts's "task dispatch matrix" suite; what's missing there
// is a check that the registry layer itself is complete and internally
// consistent across every task type at once.

const TASK_TYPES = [
  'stellar_payment',
  'soroban_invoke',
  'soroban_query',
  'x402_respond',
  'account_info',
  'change_trust',
  'multisig_payment',
  'batch_payment',
  'balance_check',
  'path_payment',
  'fee_bump',
  'dex_offer',
  'liquidity_pool',
  'stellar_toml',
  'data_entry',
  'sequence_number',
  'sponsored_account',
  'anchor_quote',
  'inflation',
  'soroban_deploy',
  'swap',
  'account_history',
  'claimable_balance',
  'set_options',
  'soroban_events',
  'web_auth',
] as const;

/** A stub exposing every method any real tool's adapter might call, each a no-op resolving `{}`. */
function stubTool(): Record<string, (...args: unknown[]) => unknown> {
  const stub = {
    execute: vi.fn().mockResolvedValue({}),
    query: vi.fn().mockResolvedValue({}),
    fetch: vi.fn().mockResolvedValue({}),
    respond: vi.fn().mockResolvedValue({}),
    fetchToml: vi.fn().mockResolvedValue({}),
  };
  return stub;
}

const TOOL_INSTANCE_KEYS = [
  'paymentTool',
  'sorobanTool',
  'sorobanQueryTool',
  'x402Tool',
  'accountInfoTool',
  'trustlineTool',
  'multiSigTool',
  'batchPaymentTool',
  'balanceCheckTool',
  'pathPaymentTool',
  'feeBumpTool',
  'dexOfferTool',
  'liquidityPoolTool',
  'stellarTomlTool',
  'dataEntryTool',
  'sequenceNumberTool',
  'sponsoredAccountTool',
  'anchorQuoteTool',
  'inflationTool',
  'sorobanDeployTool',
  'swapTool',
  'accountHistoryTool',
  'claimableBalanceTool',
  'setOptionsTool',
  'sorobanEventIndexerTool',
  'stellarIdentityTool',
] as const;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function stubToolInstances(): any {
  return Object.fromEntries(TOOL_INSTANCE_KEYS.map((key) => [key, stubTool()]));
}

describe('buildToolDefinitions — every real AgentTask type', () => {
  // backend/tool_definitions.ts pulls in ~26 tool modules on first import;
  // transforming that whole graph the first time comfortably exceeds the
  // default per-test timeout in this environment. Importing it once in
  // beforeAll (with its own generous timeout) means every `it` below reuses
  // Vitest's already-cached module instead of each paying that cost again.
  let buildToolDefinitions: typeof import('../backend/tool_definitions').buildToolDefinitions;

  beforeAll(async () => {
    ({ buildToolDefinitions } = await import('../backend/tool_definitions'));
  }, 60_000);

  it('registers exactly one definition per known task type, with no duplicates', () => {
    const definitions = buildToolDefinitions(stubToolInstances());
    const names = definitions.map((d) => d.name);

    expect(names.sort()).toEqual([...TASK_TYPES].sort());
    expect(new Set(names).size).toBe(names.length);
  });

  it('every definition registers cleanly and produces a valid JSON Schema', () => {
    const registry = new ToolRegistry();
    for (const def of buildToolDefinitions(stubToolInstances())) {
      registry.register(def);
    }

    const schemas = registry.toJSONSchemaAll();
    expect(schemas).toHaveLength(TASK_TYPES.length);
    for (const schema of schemas) {
      expect(schema.name).toBeTruthy();
      expect(schema.description.length).toBeGreaterThan(0);
      // Most tools take a flat object of parameters; a few (data_entry,
      // sequence_number, inflation, liquidity_pool, claimable_balance,
      // soroban_deploy) take a Zod discriminated union keyed on `action`,
      // which zod-to-json-schema correctly renders as `anyOf` rather than a
      // single `type: "object"` — both are valid JSON Schema.
      const isPlainObject = schema.parameters.type === 'object';
      const isUnion = Array.isArray(schema.parameters.anyOf ?? schema.parameters.oneOf);
      expect(isPlainObject || isUnion).toBe(true);
    }
  });

  it('every task type has a riskLevel, and policyCheck is only present on value_moving tools', () => {
    const definitions = buildToolDefinitions(stubToolInstances());
    const riskLevels = new Set(definitions.map((d) => d.riskLevel));
    expect(riskLevels).toEqual(new Set(['read_only', 'value_moving', 'destructive']));

    const withPolicyCheck = definitions
      .filter((d) => d.policyCheck !== undefined)
      .map((d) => d.name);
    // Every policy-checked tool must be classified value_moving — a
    // read_only or destructive tool with a spending-limit check would be a
    // contradiction in terms.
    for (const def of definitions) {
      if (def.policyCheck) {
        expect(def.riskLevel).toBe('value_moving');
      }
    }
    expect(withPolicyCheck).toContain('stellar_payment');
    expect(withPolicyCheck).toContain('x402_respond');
    expect(withPolicyCheck).toContain('batch_payment');
  });
});
