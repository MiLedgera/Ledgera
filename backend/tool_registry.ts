/**
 * backend/tool_registry.ts
 *
 * Holds every registered `ToolDefinition` (see backend/tool_contract.ts) and
 * is what `PayFiAgent` dispatches tasks through, replacing the hand-written
 * switch that previously lived in `agent.ts`.
 *
 * Also the one place JSON Schema is generated from each tool's Zod input
 * schema, via `zod-to-json-schema` — `toJSONSchema()` / `toOpenAIFunctions()`
 * produce the function-calling definitions an LLM integration (OpenAI,
 * Anthropic tool use, or anything else following the same
 * `{name, description, parameters}` shape) needs to plug this agent's
 * toolset in directly.
 */

import { zodToJsonSchema } from 'zod-to-json-schema';
import type { ToolDefinition, ToolExecutionContext, ToolRiskLevel } from './tool_contract';
import { createLogger } from './utils/logger';

const log = createLogger('tool-registry');

/** JSON Schema function-calling definition (OpenAI/Anthropic tool-use shape). */
export interface ToolJSONSchema {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export class ToolRegistry {
  private readonly definitions = new Map<string, ToolDefinition>();

  register<TInput, TOutput>(definition: ToolDefinition<TInput, TOutput>): void {
    if (this.definitions.has(definition.name)) {
      throw new Error(`A tool named "${definition.name}" is already registered`);
    }
    // Variance: ToolDefinition<TInput, TOutput> is not a ToolDefinition<unknown, unknown>
    // in either direction, but the registry only ever calls `execute`/`policyCheck`
    // with the raw payload every tool already accepts — never through the typed
    // generic parameters — so erasing to `unknown` here is sound in practice.
    this.definitions.set(definition.name, definition as unknown as ToolDefinition);
  }

  get(name: string): ToolDefinition | undefined {
    return this.definitions.get(name);
  }

  has(name: string): boolean {
    return this.definitions.has(name);
  }

  list(): ToolDefinition[] {
    return [...this.definitions.values()];
  }

  listByRiskLevel(riskLevel: ToolRiskLevel): ToolDefinition[] {
    return this.list().filter((def) => def.riskLevel === riskLevel);
  }

  /**
   * Run a registered tool's full pipeline: policy check (if any), then
   * execute. `rawPayload` is passed through unparsed — see
   * `backend/tool_contract.ts`'s doc comment for why the registry never
   * re-parses it through `inputSchema` itself.
   *
   * After `execute` resolves, the result is soft-checked against
   * `outputSchema`: a mismatch is logged as a warning, never thrown. The
   * schemas describe the tool's *intended* contract for documentation and
   * JSON-Schema generation; enforcing them as a hard runtime gate would add a
   * new way for a previously-successful call to start failing if a schema is
   * ever slightly off, which is exactly what this registry is not supposed
   * to risk.
   */
  async dispatch(name: string, rawPayload: unknown, ctx: ToolExecutionContext): Promise<unknown> {
    const def = this.definitions.get(name);
    if (!def) {
      throw new Error(`Unknown task type: ${name}`);
    }

    def.policyCheck?.(rawPayload, ctx);
    const result = await def.execute(rawPayload, ctx);

    const check = def.outputSchema.safeParse(result);
    if (!check.success) {
      log.warn(
        { tool: name, issues: check.error.issues },
        'Tool result did not match its declared output schema'
      );
    }

    return result;
  }

  /** JSON Schema function-calling definition for one registered tool. */
  toJSONSchema(name: string): ToolJSONSchema {
    const def = this.definitions.get(name);
    if (!def) {
      throw new Error(`Unknown task type: ${name}`);
    }
    const schema = def.inputSchema();
    return {
      name: def.name,
      description: def.description,
      // zod-to-json-schema's types resolve against its own `zod/v3` subpath
      // import. Structurally comparing that against this project's inferred
      // schema type blows TS's instantiation-depth limit (TS2589) — an `any`
      // escape at this one call boundary, not a real type-safety gap.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      parameters: zodToJsonSchema(schema as any, { $refStrategy: 'none' }) as Record<
        string,
        unknown
      >,
    };
  }

  /** JSON Schema function-calling definitions for every registered tool. */
  toJSONSchemaAll(): ToolJSONSchema[] {
    return this.list().map((def) => this.toJSONSchema(def.name));
  }
}
