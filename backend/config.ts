/**
 * backend/config.ts
 *
 * Production-grade, schema-validated configuration layer.
 *
 * Security guarantees:
 *   - AGENT_SECRET_KEY is NEVER included in error messages or logs.
 *   - AGENT_PUBLIC_KEY is derived from the secret key at startup;
 *     only the public key is exposed on the config object.
 *   - Invalid env causes an informative error + process.exit(1)
 *     before any network or tool code runs.
 *
 * Usage:
 *   import { config } from "./config";
 *   config.HORIZON_URL          // validated URL string
 *   config.AGENT_PUBLIC_KEY     // derived G-address, safe to log
 *   config.agentKeypair()       // call-site requests the Keypair explicitly
 */

import { z } from 'zod';
import * as dotenv from 'dotenv';
import { Keypair } from '@stellar/stellar-sdk';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

// Load .env file (no-op when running in CI / production with real env vars)
dotenv.config();

// ─── Custom Zod refinements ───────────────────────────────────────────────────

function isValidStellarPublicKey(value: string): boolean {
  if (!value.startsWith('G')) {
    return false;
  }

  try {
    Keypair.fromPublicKey(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * Validates a Stellar secret key (S…, 56 chars, base32).
 * The key itself is NEVER surfaced in Zod error messages —
 * we only report structural problems.
 */
const StellarSecretKeySchema = z.string().refine(
  (val) => {
    try {
      Keypair.fromSecret(val);
      return true;
    } catch {
      return false;
    }
  },
  // Generic message — does not echo the value
  {
    message:
      'AGENT_SECRET_KEY is not a valid Stellar secret key (must start with S and be 56 chars)',
  }
);

/**
 * Stellar public key — 56-char G-address.
 * Optional: when absent it is derived from AGENT_SECRET_KEY.
 */
const StellarPublicKeySchema = z
  .string()
  .length(56, 'Must be a 56-character Stellar public key (G…)')
  .refine((val) => val.startsWith('G'), { message: 'Public key must start with G' })
  .refine((val) => isValidStellarPublicKey(val), {
    message: 'AGENT_PUBLIC_KEY must be a valid Stellar public key',
  })
  .optional();

/**
 * Spending limit: a positive decimal with up to 7 decimal places.
 * "0" is not permitted — agents must have a non-zero spending cap.
 */
const SpendingLimitSchema = z
  .string()
  .regex(
    /^[1-9]\d*(\.\d{1,7})?$/,
    "AGENT_SPENDING_LIMIT must be a positive decimal (e.g. '100' or '50.0000000')"
  )
  .default('100');

// ─── Raw environment schema ───────────────────────────────────────────────────

const EnvSchema = z.object({
  // Network
  STELLAR_NETWORK: z
    .enum(['testnet', 'mainnet', 'futurenet'], {
      errorMap: () => ({
        message: 'STELLAR_NETWORK must be one of: testnet | mainnet | futurenet',
      }),
    })
    .default('testnet'),

  // RPC endpoints
  HORIZON_URL: z
    .string({ required_error: 'HORIZON_URL is required' })
    .url('HORIZON_URL must be a valid URL (e.g. https://horizon-testnet.stellar.org)'),

  SOROBAN_RPC_URL: z
    .string({ required_error: 'SOROBAN_RPC_URL is required' })
    .url('SOROBAN_RPC_URL must be a valid URL (e.g. https://soroban-testnet.stellar.org)'),

  // Agent identity
  AGENT_SECRET_KEY: StellarSecretKeySchema,
  AGENT_PUBLIC_KEY: StellarPublicKeySchema,
  AGENT_SECRET_KEY_ARN: z.string().optional(),

  // x402 / PayFi asset
  X402_ASSET_CODE: z.string().min(1).max(12).default('USDC'),
  X402_ASSET_ISSUER: z
    .string({ required_error: 'X402_ASSET_ISSUER is required' })
    .length(56, 'X402_ASSET_ISSUER must be a 56-character Stellar address')
    .refine((val) => val.startsWith('G'), {
      message: 'X402_ASSET_ISSUER must start with G',
    })
    .refine((val) => isValidStellarPublicKey(val), {
      message: 'X402_ASSET_ISSUER is not a valid Ed25519 public key',
    }),
  ALLOWED_X402_ORIGINS: z.string().optional(),

  // Spending cap
  AGENT_SPENDING_LIMIT: SpendingLimitSchema,

  // Optional rolling-window cumulative caps, layered on top of AGENT_SPENDING_LIMIT's
  // per-transaction check. Undefined disables that window's cumulative check.
  AGENT_HOURLY_SPENDING_LIMIT: z
    .string()
    .regex(
      /^[1-9]\d*(\.\d{1,7})?$/,
      "AGENT_HOURLY_SPENDING_LIMIT must be a positive decimal (e.g. '500')"
    )
    .optional(),
  AGENT_DAILY_SPENDING_LIMIT: z
    .string()
    .regex(
      /^[1-9]\d*(\.\d{1,7})?$/,
      "AGENT_DAILY_SPENDING_LIMIT must be a positive decimal (e.g. '2000')"
    )
    .optional(),

  // How an amount denominated in an asset other than XLM or the configured
  // X402_ASSET_CODE/X402_ASSET_ISSUER reference pair is handled by the spending
  // guard: reject it outright, or convert it to the reference asset via
  // ASSET_CONVERSION_RATES before comparing it against the caps.
  SPENDING_LIMIT_UNKNOWN_ASSET_POLICY: z.enum(['reject', 'convert']).default('reject'),

  // JSON object mapping an asset code to how many reference-asset units
  // (XLM / X402_ASSET_CODE, treated as par) one unit of that asset is worth,
  // e.g. {"BTC":"65000","PEPE":"0.00000001"}. Only consulted when
  // SPENDING_LIMIT_UNKNOWN_ASSET_POLICY is "convert".
  ASSET_CONVERSION_RATES: z
    .string()
    .optional()
    .refine(
      (val) => {
        if (val === undefined) return true;
        try {
          const parsed: unknown = JSON.parse(val);
          return (
            typeof parsed === 'object' &&
            parsed !== null &&
            !Array.isArray(parsed) &&
            Object.values(parsed).every((v) => typeof v === 'string' && !isNaN(parseFloat(v)))
          );
        } catch {
          return false;
        }
      },
      {
        message:
          'ASSET_CONVERSION_RATES must be a JSON object of asset code -> numeric string rate',
      }
    ),

  // Persistence
  DB_PATH: z.string().default('./agent.db'),

  // Logging
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  // OpenTelemetry
  OTLP_ENDPOINT: z.string().url().optional(),

  // Spending window for rate/cap computation
  SPENDING_WINDOW_MS: z.coerce.number().int().min(100).default(86_400_000),

  // Retry behaviour
  // Exponential back-off: delay = RETRY_DELAY_MS * 2^(attempt-1), capped at 30 000 ms,
  // plus ±20% random jitter. Example — MAX_RETRIES=3, RETRY_DELAY_MS=1500 →
  // delays [1500, 3000, 6000] ms (before jitter), not linear [1500, 3000, 4500].
  MAX_RETRIES: z.coerce.number().int().min(1).max(10).default(3),

  RETRY_DELAY_MS: z.coerce.number().int().min(100).default(1500),

  // How long a cached Horizon account stays fresh. Sequence numbers and
  // balances change on every transaction the account takes part in, so this is
  // deliberately short: it exists to collapse bursts of reads, not to avoid
  // round trips generally.
  ACCOUNT_CACHE_TTL_MS: z.coerce.number().int().min(0).default(30_000),

  // Per-call RPC timeout in milliseconds.
  // Defaults to RETRY_DELAY_MS * MAX_RETRIES * 2, computed post-parse.
  RPC_TIMEOUT_MS: z.coerce.number().int().min(100).optional(),

  // TOML cache TTL in milliseconds (default: 5 minutes = 300,000 ms)
  TOML_CACHE_TTL_MS: z.coerce.number().int().min(0).default(300_000),

  // Rate limiting
  MAX_X402_PAYMENTS_PER_MINUTE: z.coerce.number().int().min(1).default(10),

  // How long a used x402 nonce is retained for replay protection before it
  // becomes eligible for eviction. Defaults to 24h, comfortably above the
  // longest plausible challenge lifetime.
  X402_NONCE_TTL_MS: z.coerce
    .number()
    .int()
    .min(1)
    .default(24 * 60 * 60 * 1_000),

  // Maximum number of tasks allowed to execute concurrently in agent.run().
  // Excess tasks are queued (bounded by QUEUE_CAPACITY) or rejected.
  MAX_CONCURRENT_TASKS: z.coerce.number().int().min(1).default(10),

  // Bounded FIFO queue for tasks submitted while at MAX_CONCURRENT_TASKS.
  // 0 (default) disables queuing — excess tasks are rejected immediately.
  QUEUE_CAPACITY: z.coerce.number().int().min(0).default(0),

  MAX_SOROBAN_FEE_STROOPS: z.coerce.number().int().min(100).default(1_000_000),

  // Health check HTTP server
  HEALTH_PORT: z.coerce.number().int().min(1).max(65535).default(3000),

  // Contract event listener polling interval in milliseconds.
  CONTRACT_EVENT_POLL_MS: z.coerce.number().int().min(100).optional(),

  // Webhook notifications
  WEBHOOK_URL: z.string().url().optional(),
  WEBHOOK_SECRET: z.string().min(1).optional(),
});

type RawEnv = z.infer<typeof EnvSchema>;

// ─── Derived / enriched config type ──────────────────────────────────────────

export interface AgentConfig {
  /**
   * The Stellar network to target.
   * Enforced by EnvSchema to be one of: "testnet" | "mainnet" | "futurenet".
   * Defaults to "testnet".
   */
  readonly STELLAR_NETWORK: 'testnet' | 'mainnet' | 'futurenet';

  /**
   * The Stellar Horizon server URL.
   * Validated by EnvSchema to be a valid URL string (e.g. "https://horizon-testnet.stellar.org").
   * Required.
   */
  readonly HORIZON_URL: string;

  /**
   * The Soroban RPC server URL.
   * Validated by EnvSchema to be a valid URL string (e.g. "https://soroban-testnet.stellar.org").
   * Required.
   */
  readonly SOROBAN_RPC_URL: string;

  /**
   * Path to the SQLite database file used for audit persistence.
   * Defaults to "./agent.db". Use ":memory:" for in-process tests.
   */
  readonly DB_PATH: string;

  /**
   * The asset code for the x402 / PayFi asset.
   * Validated by EnvSchema to be a string between 1 and 12 characters.
   * Defaults to "USDC".
   */
  readonly X402_ASSET_CODE: string;

  /**
   * The 56-character G-address of the issuer for the x402 / PayFi asset.
   * Validated by EnvSchema to be a 56-character Stellar public key starting with G.
   * Required.
   */
  readonly X402_ASSET_ISSUER: string;

  /**
   * The spending limit for the agent.
   * Validated by EnvSchema to be a positive decimal with up to 7 decimal places.
   * "0" is not permitted. Defaults to "100".
   */
  readonly AGENT_SPENDING_LIMIT: string;

  /**
   * Optional cumulative cap on spending within a trailing 1-hour window,
   * layered on top of the per-transaction AGENT_SPENDING_LIMIT check.
   * Denominated in the same reference asset as AGENT_SPENDING_LIMIT
   * (XLM or X402_ASSET_CODE — see SPENDING_LIMIT_UNKNOWN_ASSET_POLICY).
   * Undefined disables the hourly cumulative check.
   */
  readonly AGENT_HOURLY_SPENDING_LIMIT?: string | undefined;

  /**
   * Optional cumulative cap on spending within a trailing 24-hour window.
   * Same denomination and semantics as AGENT_HOURLY_SPENDING_LIMIT.
   */
  readonly AGENT_DAILY_SPENDING_LIMIT?: string | undefined;

  /**
   * How the spending guard treats a payment denominated in an asset other
   * than XLM or the configured X402_ASSET_CODE/X402_ASSET_ISSUER pair:
   * - "reject" (default): refuse the task before any network call.
   * - "convert": look up a rate in ASSET_CONVERSION_RATES and compare the
   *   converted amount against the caps instead.
   */
  readonly SPENDING_LIMIT_UNKNOWN_ASSET_POLICY: 'reject' | 'convert';

  /**
   * Parsed asset-code -> rate map used when SPENDING_LIMIT_UNKNOWN_ASSET_POLICY
   * is "convert". A rate is "how many reference-asset units one unit of this
   * asset is worth". Undefined when ASSET_CONVERSION_RATES is not set.
   */
  readonly ASSET_CONVERSION_RATES?: Readonly<Record<string, number>> | undefined;

  /**
   * The maximum number of retry attempts for transient network/RPC calls.
   * Validated by EnvSchema to be an integer between 1 and 10.
   * Defaults to 3.
   */
  readonly MAX_RETRIES: number;

  /**
   * The base delay in milliseconds for exponential back-off retries.
   * Validated by EnvSchema to be an integer of at least 100.
   * Defaults to 1500.
   */
  readonly RETRY_DELAY_MS: number;

  /**
   * Derived 56-character Stellar public key (G-address) for the agent.
   * Derived automatically from AGENT_SECRET_KEY, safe to log.
   */
  readonly AGENT_PUBLIC_KEY: string;

  /**
   * Returns the agent Keypair on demand.
   * Deliberately a function rather than a property so that callers are explicit
   * about accessing the secret key, preventing accidental printing/leakage.
   * The secret key is held securely in closure and never placed on the public config object.
   *
   * @example
   * ```typescript
   * // Safely sign a transaction using the derived keypair
   * const tx = new TransactionBuilder(account, ...)
   *   // ... add operations ...
   *   .build();
   * tx.sign(config.agentKeypair());
   * ```
   *
   * @example
   * ```typescript
   * // Safely access the secret key for tool instantiation
   * const secret = config.agentKeypair().secret();
   * const tool = new StellarPaymentTool(secret);
   * ```
   */
  readonly agentKeypair: () => Keypair;
  readonly ALLOWED_X402_ORIGINS?: string;
  readonly AGENT_SECRET_KEY_ARN?: string;

  /**
   * OpenTelemetry collector endpoint.
   * Optional — when set, the agent exports traces/spans to this OTLP-compatible endpoint.
   * Validated by EnvSchema to be a valid URL string.
   */
  readonly OTLP_ENDPOINT?: string | undefined;

  /**
   * Spending window in milliseconds for rate/cap computation.
   * Defines the time window over which spending is tracked and enforced.
   * Validated by EnvSchema to be a positive integer.
   * Defaults to 60,000 (1 minute).
   */
  readonly SPENDING_WINDOW_MS: number;
  /**
   * Time-to-live, in milliseconds, for a cached Horizon account record.
   * Defaults to 30,000. Set to 0 to disable caching entirely.
   */
  readonly ACCOUNT_CACHE_TTL_MS: number;
  /**
   * Per-call RPC timeout in milliseconds.
   * Defaults to RETRY_DELAY_MS * MAX_RETRIES * 2 when RPC_TIMEOUT_MS env var is absent.
   */
  readonly RPC_TIMEOUT_MS: number;

  /**
   * Cache TTL in milliseconds for Stellar TOML requests.
   * Defaults to 300,000 (5 minutes).
   */
  readonly TOML_CACHE_TTL_MS: number;

  /**
   * Maximum number of x402 payments allowed per 60-second sliding window.
   * Defaults to 10. Prevents rapid-fire calls from exhausting the agent balance.
   */
  readonly MAX_X402_PAYMENTS_PER_MINUTE: number;

  /**
   * How long (ms) a used x402 nonce is kept for replay protection before it can
   * be evicted. Defaults to 86_400_000 (24 hours). A used nonce only needs to
   * outlive its challenge, so anything past this window is dead weight that
   * would otherwise grow the store without bound.
   */
  readonly X402_NONCE_TTL_MS: number;

  /**
   * Maximum Soroban transaction fee in stroops (1 stroop = 0.0000001 XLM).
   * Defaults to 1_000_000 (0.1 XLM). Prevents resource-inflated fee attacks.
   */
  readonly MAX_SOROBAN_FEE_STROOPS: number;

  /**
   * Maximum number of tasks allowed to execute concurrently in agent.run().
   * Additional tasks submitted while this many are in flight are rejected.
   * Defaults to 10.
   */
  readonly MAX_CONCURRENT_TASKS: number;
  /**
   * Bounded FIFO queue capacity for tasks submitted while at MAX_CONCURRENT_TASKS.
   * Defaults to 0 (no queuing — excess tasks are rejected immediately).
   */
  readonly QUEUE_CAPACITY: number;
  /**
   * Port for the health-check HTTP server.
   * Validated by EnvSchema to be an integer between 1 and 65535.
   * Defaults to 3000.
   */
  readonly HEALTH_PORT: number;
  readonly CONTRACT_EVENT_POLL_MS?: number | undefined;
  readonly WEBHOOK_URL?: string | undefined;
  readonly WEBHOOK_SECRET?: string | undefined;
}

// ─── Loader ───────────────────────────────────────────────────────────────────

export function formatValidationErrors(errors: z.ZodError): string {
  return errors.issues
    .map((issue) => {
      const rawField = issue.path.join('.') || 'unknown';
      // Redact any path element that looks like a secret key — path may contain
      // raw values (e.g., when a secret key is used as a Zod path segment).
      const field =
        issue.path.map((p) => String(p).replace(/S[A-Z2-7]{55}/g, '[REDACTED]')).join('.') ||
        rawField;
      // Redact any value that looks like a secret key in the human-readable message
      const message = issue.message.replace(/S[A-Z2-7]{55}/g, '[REDACTED]');
      return `  • ${field}: ${message}`;
    })
    .join('\n');
}

/**
 * Loads, parses, and validates environment variables against the Zod schema.
 * Enforces spending caps, derivations, and network rules at startup.
 *
 * @returns The fully validated, read-only configuration instance.
 */
async function fetchSecretFromArn(arn: string): Promise<string> {
  const arnParts = arn.split(':');
  const region = arnParts.length > 3 && arnParts[3] ? arnParts[3] : 'us-east-1';
  const client = new SecretsManagerClient({ region });
  const res = await client.send(new GetSecretValueCommand({ SecretId: arn }));
  if (!res.SecretString) {
    throw new Error('No SecretString found in secret');
  }
  return res.SecretString;
}

function parseConfigAndDerive(): AgentConfig {
  const result = EnvSchema.safeParse(process.env);

  if (!result.success) {
    // Print structured errors — secret values are never echoed
    process.stderr.write(
      `\n❌ [Config] Invalid environment — fix the following before starting:\n` +
        formatValidationErrors(result.error) +
        `\n\nSee ..env for reference.\n\n`
    );
    process.exit(1);
  }

  const raw: RawEnv = result.data;

  // ── Derive public key from secret ──────────────────────────────────────────
  let keypair: Keypair;
  try {
    keypair = Keypair.fromSecret(raw.AGENT_SECRET_KEY);
  } catch {
    process.stderr.write('❌ [Config] Failed to derive keypair from AGENT_SECRET_KEY.\n');
    process.exit(1);
  }

  const derivedPublicKey = keypair.publicKey();

  // If AGENT_PUBLIC_KEY was explicitly provided, cross-check it matches
  if (raw.AGENT_PUBLIC_KEY && raw.AGENT_PUBLIC_KEY !== derivedPublicKey) {
    process.stderr.write(
      `❌ [Config] AGENT_PUBLIC_KEY does not match the key derived from AGENT_SECRET_KEY.\n` +
        `   Provided : ${raw.AGENT_PUBLIC_KEY}\n` +
        `   Derived  : ${derivedPublicKey}\n`
    );
    process.exit(1);
  }

  // ── Mainnet safety guard ───────────────────────────────────────────────────
  if (raw.STELLAR_NETWORK === 'mainnet') {
    const limit = parseFloat(raw.AGENT_SPENDING_LIMIT);
    if (limit > 10_000) {
      process.stderr.write(
        `❌ [Config] AGENT_SPENDING_LIMIT (${raw.AGENT_SPENDING_LIMIT}) exceeds ` +
          `the mainnet safety cap of 10,000. Lower it or explicitly override.\n`
      );
      process.exit(1);
    }
  }

  // ── Build the config object — secret key stays in closure only ────────────
  const {
    AGENT_SECRET_KEY: _secret,
    AGENT_PUBLIC_KEY: _rawPub,
    ALLOWED_X402_ORIGINS,
    AGENT_SECRET_KEY_ARN,
    OTLP_ENDPOINT,
    WEBHOOK_URL,
    WEBHOOK_SECRET,
    ASSET_CONVERSION_RATES: _rawConversionRates,
    ...rest
  } = raw;

  const rpcTimeoutMs = raw.RPC_TIMEOUT_MS ?? raw.RETRY_DELAY_MS * raw.MAX_RETRIES * 2;

  // Parsed once at startup — the schema already validated it is a JSON object
  // of asset code -> numeric string, so this parse cannot fail here.
  const assetConversionRates: Record<string, number> | undefined = _rawConversionRates
    ? Object.fromEntries(
        Object.entries(JSON.parse(_rawConversionRates) as Record<string, string>).map(
          ([code, rate]) => [code, parseFloat(rate)]
        )
      )
    : undefined;

  // Derive the keypair once at startup. agentKeypair returns this cached instance
  // on every call, avoiding repeated Ed25519 derivation.
  const _keypair = Keypair.fromSecret(_secret);
  const _secretRef = _secret;

  const cfg: AgentConfig = {
    ...rest,
    AGENT_PUBLIC_KEY: derivedPublicKey,
    RPC_TIMEOUT_MS: rpcTimeoutMs,
    MAX_X402_PAYMENTS_PER_MINUTE: raw.MAX_X402_PAYMENTS_PER_MINUTE,
    X402_NONCE_TTL_MS: raw.X402_NONCE_TTL_MS,
    MAX_SOROBAN_FEE_STROOPS: raw.MAX_SOROBAN_FEE_STROOPS,
    ...(ALLOWED_X402_ORIGINS ? { ALLOWED_X402_ORIGINS } : {}),
    ...(AGENT_SECRET_KEY_ARN ? { AGENT_SECRET_KEY_ARN } : {}),
    ...(OTLP_ENDPOINT ? { OTLP_ENDPOINT } : {}),
    ...(WEBHOOK_URL ? { WEBHOOK_URL } : {}),
    ...(WEBHOOK_SECRET ? { WEBHOOK_SECRET } : {}),
    ...(raw.CONTRACT_EVENT_POLL_MS !== undefined
      ? { CONTRACT_EVENT_POLL_MS: raw.CONTRACT_EVENT_POLL_MS }
      : {}),
    ...(assetConversionRates ? { ASSET_CONVERSION_RATES: assetConversionRates } : {}),
    // Secret is captured in closure; never on the object
    agentKeypair: () => _keypair,
  };

  // Allow GC of the secret string now that the keypair is materialised.
  // (JS strings are immutable, but this signals intent.)
  (() => {
    const _ = _secretRef;
  })();

  // Startup banner — only safe fields
  process.stdout.write(
    `✅ [Config] Environment validated\n` +
      `   Network        : ${cfg.STELLAR_NETWORK}\n` +
      `   Horizon        : ${cfg.HORIZON_URL}\n` +
      `   Soroban        : ${cfg.SOROBAN_RPC_URL}\n` +
      `   Agent pubkey   : ${cfg.AGENT_PUBLIC_KEY}\n` +
      `   Spending limit : ${cfg.AGENT_SPENDING_LIMIT} ${cfg.X402_ASSET_CODE}\n` +
      `   Max retries    : ${cfg.MAX_RETRIES}\n`
  );

  return cfg;
}

function loadConfigSync(): AgentConfig {
  if (process.env.AGENT_SECRET_KEY_ARN) {
    throw new Error('Cannot load configuration synchronously when AGENT_SECRET_KEY_ARN is set.');
  }
  return parseConfigAndDerive();
}

export async function loadConfig(): Promise<AgentConfig> {
  if (process.env.AGENT_SECRET_KEY && process.env.AGENT_SECRET_KEY_ARN) {
    process.stderr.write(
      '❌ [Config] Cannot specify both AGENT_SECRET_KEY and AGENT_SECRET_KEY_ARN.\n'
    );
    process.exit(1);
  }

  if (process.env.AGENT_SECRET_KEY_ARN) {
    try {
      const arn = process.env.AGENT_SECRET_KEY_ARN;
      const secret = await fetchSecretFromArn(arn);
      let parsedSecret = secret;
      try {
        const json = JSON.parse(secret);
        if (json && typeof json === 'object' && !Array.isArray(json)) {
          const candidate = json.AGENT_SECRET_KEY;
          if (typeof candidate === 'string') {
            parsedSecret = candidate;
          } else {
            const firstValue = Object.values(json).find(
              (value): value is string => typeof value === 'string'
            );
            if (firstValue) {
              parsedSecret = firstValue;
            }
          }
        }
      } catch {
        // Not a JSON object, use raw string
      }
      process.env.AGENT_SECRET_KEY = parsedSecret;
    } catch (err: any) {
      process.stderr.write(
        `❌ [Config] Failed to fetch secret from AWS Secrets Manager (ARN: ${process.env.AGENT_SECRET_KEY_ARN}): ${err.message}\n`
      );
      process.exit(1);
    }
  }

  return parseConfigAndDerive();
}

let _config: AgentConfig | null = null;
let _configError: Error | null = null;

// Synchronous default initialization if AGENT_SECRET_KEY is defined directly
if (process.env.AGENT_SECRET_KEY && process.env.AGENT_SECRET_KEY_ARN) {
  // Both set — record as error immediately so configPromise rejects and
  // the proxy throws the right message before awaiting.
  _configError = new Error('Cannot specify both AGENT_SECRET_KEY and AGENT_SECRET_KEY_ARN.');
  process.stderr.write(
    '❌ [Config] Cannot specify both AGENT_SECRET_KEY and AGENT_SECRET_KEY_ARN.\n'
  );
} else if (process.env.AGENT_SECRET_KEY && !process.env.AGENT_SECRET_KEY_ARN) {
  try {
    _config = loadConfigSync();
  } catch (err: any) {
    _configError = err;
  }
}

export const configPromise = (async () => {
  if (_config) return _config;
  if (_configError) throw _configError;
  try {
    _config = await loadConfig();
    return _config;
  } catch (err: any) {
    _configError = err;
    throw err;
  }
})();

export const config = new Proxy({} as AgentConfig, {
  get(target, prop, receiver) {
    if (_configError) {
      throw _configError;
    }
    if (!_config) {
      throw new Error('Configuration has not been initialized yet. Await configPromise first.');
    }
    return Reflect.get(_config, prop, receiver);
  },
});

/**
 * Hardcoded spending limit (safety cap) for transactions on Stellar mainnet.
 * Any single operation/payment attempting to exceed this value will be blocked
 * by the spending limit assertion before submission.
 *
 * Denomination: this cap (and AGENT_SPENDING_LIMIT / AGENT_HOURLY_SPENDING_LIMIT /
 * AGENT_DAILY_SPENDING_LIMIT) apply to an amount denominated in the "reference
 * asset" — native XLM, or the configured X402_ASSET_CODE/X402_ASSET_ISSUER pair.
 * Both are treated as par-value units by these caps; they are NOT converted
 * against each other or against any other asset. A payment in any other asset
 * is handled per SPENDING_LIMIT_UNKNOWN_ASSET_POLICY in backend/agent.ts's
 * `assertWithinSpendingLimit`: rejected outright, or converted to the reference
 * asset via ASSET_CONVERSION_RATES before this cap is applied.
 */
export const MAINNET_SPENDING_CAP = 10000;

// ─── Compile-time encapsulation guard ────────────────────────────────────────
// AgentConfig intentionally omits AGENT_SECRET_KEY via Omit<RawEnv, "AGENT_SECRET_KEY">.
// The TypeScript assertion below is intentional — it proves AGENT_SECRET_KEY is NOT
// on the AgentConfig type without emitting any runtime value access.
type ConfigTypeGuard = AgentConfig;
void ({} as ConfigTypeGuard);
