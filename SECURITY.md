# Security Policy

## Supported Versions

| Version | Supported |
| ------- | --------- |
| `main`  | ✅ Active security patches |
| `< 1.0` | ❌ No longer supported |

Only the latest commit on `main` receives security patches at this stage of the project. Pin to a specific commit SHA if you need a stable, audited snapshot.

---

## Dependency Vulnerability Policy

Dependency vulnerabilities are checked in CI before changes can merge:

- `npm audit --audit-level=high` fails the `audit-npm` job for High or Critical npm advisories.
- The optional `snyk` job runs `snyk test --severity-threshold=high` when the `SNYK_TOKEN` repository secret is configured.
- Rust dependencies are checked with `cargo audit` in the `audit-rust` job.
- Findings must be remediated by upgrading, replacing, or removing the affected dependency whenever possible.
- A false positive may be ignored only after maintainer review, with a documented reason and expiry in [`.snyk`](./.snyk). The ignore must be removed when the finding is fixed or the justification expires.

High and Critical findings are not accepted as routine CI noise. If remediation is not immediately available, document the risk, mitigation, owner, and review date in the security discussion before adding a narrowly scoped temporary exception.

---

## Reporting a Vulnerability

**Do not open a public GitHub issue for security vulnerabilities.**

Use [GitHub Private Security Advisories](https://github.com/Nodal-stellar/Nodal-AI/security/advisories/new) to report vulnerabilities confidentially. This keeps details private until a fix is released.

### Response SLA

| Milestone | Target |
| --------- | ------ |
| Acknowledgement | ≤ 48 hours |
| Initial triage & severity assessment | ≤ 5 business days |
| Patch or mitigation for Critical/High | ≤ 14 days |
| Patch or mitigation for Medium/Low | ≤ 30 days |
| Public disclosure (coordinated) | After patch is released |

We follow [coordinated vulnerability disclosure](https://cheatsheetseries.owasp.org/cheatsheets/Vulnerability_Disclosure_Cheat_Sheet.html). Researchers who report responsibly will be credited in the release notes unless they prefer anonymity.

---

## Core Security Invariants

The following invariants are enforced throughout the codebase. Any contribution that weakens them will be rejected.

### 1. Zero Hardcoding (Secret Hygiene)

All sensitive credentials — `AGENT_SECRET_KEY`, RPC endpoints, asset issuers — are sourced exclusively from environment variables and validated at startup via Zod schemas (`backend/config.ts`). No secrets appear in source code, committed configuration files, or log output.

**Enforcement:**
- `.env` is `.gitignore`d; `.env.example` contains only placeholder values.
- Zod validation error messages strip any value matching a Stellar secret-key pattern (`S[A-Z2-7]{55}`) before writing to stderr (`formatValidationErrors` in `backend/config.ts`).
- CI pipelines must never inject real secret keys into build logs.

### 2. Transaction Simulation (Pre-execution Validation)

Every Soroban transaction is passed through `prepareSorobanTx` (Soroban RPC simulation) before it is signed or broadcast. Simulation catches fee estimation errors, authorization failures, and contract-level panics without spending funds or mutating on-chain state.

**Enforcement:**
- The sign → submit path is only reachable after a successful simulation response.
- A failed simulation aborts the operation and surfaces a structured error to the agent loop, preventing silent fund loss.

### 3. Challenge Validation (Cryptographic Intent Verification)

Before any x402 payment is triggered, the incoming challenge is validated for:
- **Schema correctness** — all required fields present and correctly typed.
- **Expiry** — the challenge timestamp is within the accepted window; stale challenges are rejected.
- **Asset match** — the requested asset code and issuer are compared against the agent's configured `X402_ASSET_CODE` / `X402_ASSET_ISSUER` values.

**Enforcement:**
- Validation runs before any keypair access or transaction construction.
- Challenges failing any check are dropped without triggering a payment.

---

## Secret Management: The `agentKeypair()` Closure

`AGENT_SECRET_KEY` has a single, controlled access path in the entire codebase.

### How it works (`backend/config.ts`)

```typescript
// 1. Raw secret parsed from env — never leaves this scope
const { AGENT_SECRET_KEY: _secret, AGENT_PUBLIC_KEY: _rawPub, ...rest } = raw;

// 2. AgentConfig interface explicitly excludes the secret key
export interface AgentConfig extends Omit<RawEnv, "AGENT_SECRET_KEY" | "AGENT_PUBLIC_KEY"> {
  readonly AGENT_PUBLIC_KEY: string;   // safe to log
  readonly agentKeypair: () => Keypair; // explicit, call-site access only
}

// 3. Secret captured in closure — never placed on the config object
const cfg: AgentConfig = {
  ...rest,
  AGENT_PUBLIC_KEY: derivedPublicKey,
  agentKeypair: () => Keypair.fromSecret(_secret),
};
```

### Why this matters

| Risk | Mitigation |
| ---- | ---------- |
| Accidental `console.log(config)` leaks the secret | Secret is absent from the `config` object entirely — it only exists inside the `loadConfig` closure scope. |
| Serialization (e.g. `JSON.stringify(config)`) captures the secret | `agentKeypair` is a function reference; functions are silently dropped by JSON serialization. |
| Log aggregators capturing structured config objects | `AGENT_SECRET_KEY` is removed via destructuring before `cfg` is constructed; it cannot appear in any downstream spread. |
| Zod validation errors echoing the raw value | `formatValidationErrors` applies a regex redaction pass over all error messages before writing to stderr. |

**Calling convention:** code that needs to sign a transaction must call `config.agentKeypair()` explicitly. This deliberate friction makes secret access visible at review time and auditable via static analysis.

---

## Key Rotation (Stellar Agent Keypair)

If `AGENT_SECRET_KEY` is suspected to be compromised or needs rotation for operational reasons, follow this step-by-step procedure. **Stellar's account model requires careful sequencing — a mistake can lock the agent account permanently.**

### Prerequisites

- Access to the current `AGENT_SECRET_KEY`
- Write access to your environment variable store (e.g., `.env`, secrets manager, CI platform)
- Confirmation that the current keypair is listed as a signer on the Stellar account

### Rotation Procedure

#### Step 1: Generate a New Keypair

Generate a new keypair locally. Do not commit it to version control.

```bash
node -e "const { Keypair } = require('js-stellar-sdk'); const kp = Keypair.random(); console.log('Public:', kp.publicKey()); console.log('Secret:', kp.secret());"
```

Save the output securely (e.g., in your secrets manager or encrypted note).

#### Step 2: Add the New Key as a Signer (While Old Key is Still Active)

Using the **current** `AGENT_SECRET_KEY`, submit a `setOptions` transaction to add the new public key as an additional signer:

```typescript
import { Keypair, TransactionBuilder, Networks, Operation } from 'js-stellar-sdk';
import { config } from './backend/config';

const server = new Horizon.Server('https://horizon.stellar.org');
const currentKeypair = config.agentKeypair();
const newPublicKey = 'G...'; // The new keypair's public key

const account = await server.loadAccount(currentKeypair.publicKey());
const tx = new TransactionBuilder(account, {
  fee: BASE_FEE,
  networkPassphrase: Networks.PUBLIC_NETWORK_PASSPHRASE,
})
  .addOperation(
    Operation.setOptions({
      signer: {
        ed25519PublicKey: newPublicKey,
        weight: 1, // Same weight as the current key
      },
    })
  )
  .setTimeout(180)
  .build();

tx.sign(currentKeypair);
const txResult = await server.submitTransaction(tx);
console.log('✅ New signer added:', txResult.id);
```

**Do NOT proceed to the next step until this transaction confirms on-chain.** Verify via:
```bash
curl https://horizon.stellar.org/accounts/<AGENT_PUBLIC_KEY>
# Look for the new public key in the response's signers array
```

#### Step 3: Update `AGENT_SECRET_KEY` to the New Key

Once the new signer is confirmed on-chain, update your environment:
```bash
export AGENT_SECRET_KEY="S..." # Use the new keypair's secret key
```

Restart any running agent processes so they pick up the new key.

#### Step 4: Verify the New Key Works

Test that the agent can sign transactions with the new key:

```typescript
const newKeypair = config.agentKeypair();
const testTx = new TransactionBuilder(account, {
  fee: BASE_FEE,
  networkPassphrase: Networks.PUBLIC_NETWORK_PASSPHRASE,
})
  .addOperation(Operation.bumpSequence({ bumpTo: account.sequenceNumber() }))
  .setTimeout(180)
  .build();

testTx.sign(newKeypair);
const result = await server.submitTransaction(testTx);
console.log('✅ New key can sign transactions:', result.id);
```

#### Step 5: Remove the Old Key as a Signer

Once the new key is confirmed working and the old key is no longer needed, remove it from the signers list:

```typescript
const oldPublicKey = '...'; // The old keypair's public key

const tx = new TransactionBuilder(account, {
  fee: BASE_FEE,
  networkPassphrase: Networks.PUBLIC_NETWORK_PASSPHRASE,
})
  .addOperation(
    Operation.setOptions({
      signer: {
        ed25519PublicKey: oldPublicKey,
        weight: 0, // Weight of 0 removes the signer
      },
    })
  )
  .setTimeout(180)
  .build();

tx.sign(newKeypair); // Sign with the NEW key
const txResult = await server.submitTransaction(tx);
console.log('✅ Old signer removed:', txResult.id);
```

### Critical Warnings

⚠️ **Do not remove the old key until the new key is confirmed working.** If you remove the old key before verifying the new one works, the account will have no active signers and become permanently inaccessible.

⚠️ **Do not update `AGENT_SECRET_KEY` in production until the new signer is confirmed on-chain.** Mismatched signers and active keys will cause transaction signing failures.

⚠️ **Keep a secure offline backup of the old key** until you are certain it is no longer needed, in case recovery is necessary.

---

## Additional Hardening Notes

- **Mainnet spending cap:** `AGENT_SPENDING_LIMIT` is rejected at startup if it exceeds `10,000` on `mainnet`, preventing runaway agent spend.
- **Exponential back-off:** All RPC calls use retry logic with jitter to reduce the attack surface of timing-based denial-of-service against the agent.
- **Dependency pinning:** Keep `package.json` dependencies pinned to exact versions and audit regularly with `npm audit`.

---

## Known Limitations

Users should be aware of the following limitations when deploying Nodal AI:

### 1. Nonce Store Is Not Shared Across Horizontally-Scaled Instances

`X402PaymentTool` defaults to `SqliteNonceStore` (`backend/nonce_store.ts`), which persists used x402 nonces to the same SQLite database as `DB_PATH` and survives process restarts on a single instance. It is **not** shared across multiple concurrently-running agent instances (e.g. behind a load balancer) unless they point at the same database file — each instance's replay protection is otherwise independent. For horizontal scale-out, inject a custom `INonceStore` backed by a shared store (Redis, DynamoDB, etc.) via the `X402PaymentTool` constructor. `InMemoryNonceStore` exists only for unit tests and is never used by default.

### 2. Soroban Simulation Disabled for Payment Estimates

`StellarPaymentTool` does not use Soroban simulation to estimate transaction fees. Fee estimates are calculated as base-fee only, without accounting for transaction complexity or network congestion. Production deployments should verify fee estimates through a secondary mechanism or use a higher fee buffer.

### 3. AWS Secret Fetch Pattern

`config.ts` fetches `AGENT_SECRET_KEY` from AWS Secrets Manager via the `@aws-sdk/client-secrets-manager` `SecretsManagerClient`/`GetSecretValueCommand` API (not a shell-out) when `AGENT_SECRET_KEY_ARN` is configured. The fetch runs once at startup, before any tool code executes, and its result is never logged or included in error messages — only structural configuration errors are reported (see [Secret Management](#secret-management-the-agentkeypair-closure) above).

### 4. Webhook Delivery Retry Limits

Webhook delivery has no retry mechanism for non-2xx responses beyond the initial `withRetry` attempts configured in the deployment. If a webhook consumer is temporarily unavailable, events may be silently dropped without re-queueing or manual intervention capability.
