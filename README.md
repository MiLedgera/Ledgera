# Ledgera

[![CI](https://github.com/MiLedgera/Ledgera/actions/workflows/ci.yml/badge.svg)](https://github.com/MiLedgera/Ledgera/actions/workflows/ci.yml)
**Modular, production-ready Agent Kit for autonomous PayFi (Payment-Finance) flows on the Stellar Network.**

Ledgera empowers developers to build autonomous agents capable of handling complex financial interactions. Whether you’re automating cross-border settlements, building machine-to-machine payment gateways, or orchestrating smart contract executions, Ledgera provides the primitives to do it securely and efficiently on Stellar.

---

## Why Ledgera?

In the era of **PayFi**, payments are no longer just passive transfers they are programmable, autonomous, and integrated into the global financial fabric. Ledgera bridges the gap between AI reasoning and Stellar's high-speed, low-cost network.

- **Autonomous PayFi:** Built-in support for the `x402` payment standard, enabling seamless machine-to-machine value exchange.
- **Modular Architecture:** Swap in new tools, chain actions, and orchestrate complex workflows without touching core signing logic.
- **Safety-First Design:** Every Soroban smart-contract transaction is simulated via Soroban RPC before broadcast (Horizon Classic operations like native payments have no simulation endpoint to run against), and all secrets remain strictly externalized.

---

## Architecture

Ledgera is built on a clean, three-pillar separation of concerns. For a deep dive into the system design, tool dispatch, simulation gates, and state machines, please read the [Architecture Guide](./ARCHITECTURE.md).

If you are new to the Stellar-specific terms used throughout the repo, see the [Glossary](./GLOSSARY.md).

```text
/
├── backend/            # Agent orchestration (TypeScript/Node.js)
├── contracts/          # Soroban smart contracts (Rust)
└── tests/              # E2E & integration tests (Vitest)

```

---

## Quick Start

1. **Clone & Configure:**

   ```bash
   git clone https://github.com/MiLedgera/Ledgera.git
   cd Ledgera
   cp .env.example .env
   ```

   Open `.env` and fill in at minimum `AGENT_SECRET_KEY`, `HORIZON_URL`, `SOROBAN_RPC_URL`, and `X402_ASSET_ISSUER`. See [`.env.example`](./.env.example) for the full list of variables and their descriptions.

2. **Install Dependencies:**

   ```bash
   npm install
   ```

3. **Verify Installation:**
   ```bash
   npm run build
   npm run test:all
   ```

---

## Development & Testing

### Backend (TypeScript)

The `backend/` pillar contains the "Agent Brain." Use it to define tools and manage agent state.

- `npm run build`: Compiles the TypeScript agent core.

### Smart Contracts (Rust/Soroban)

The `contracts/` pillar holds your escrow and payment logic.

- `cd contracts/escrow && cargo test`: Run the suite of Soroban unit tests to ensure contract safety.

### Integration Testing

We use `Vitest` to ensure the entire flow—from AI reasoning to network settlement—works as expected.

- `npm run test`: Executes the `/tests` suite.
- `npm run test:ui`: Runs the test suite with the interactive Vitest UI.

---

## Docker

Ledgera includes a multi-stage Dockerfile and Docker Compose stack for local development, testing, and deployment.

### Running with Docker Compose

1. **Start the local Stellar network and Ledgera agent:**

   ```bash
   docker-compose up --build
   ```

   This will spin up:
   - `stellar-quickstart` at `http://localhost:8000` (Horizon) and `http://localhost:8001` (Soroban RPC).
   - `agent` which automatically connects to the quickstart services once they are healthy.

2. **Stop the services and clean up containers:**
   ```bash
   docker-compose down
   ```

### Run Tests in Docker

There are two ways to run the test suite in Docker, depending on how much of the stack you need:

**Full stack (`test` profile):** builds and boots `stellar-quickstart` *and* the `agent` HTTP server, then runs the test runner against both. Use this when you need to exercise the running `agent` container itself:

```bash
docker-compose --profile test up --build
```

**Tests only (`test-only` profile):** skips building/booting the `agent` service entirely and only starts `stellar-quickstart` plus the test runner. This is faster and is the recommended default for local iteration and CI, since the test suite talks directly to `stellar-quickstart` and does not require the standalone `agent` server to be running:

```bash
docker-compose --profile test-only up --build --abort-on-container-exit --exit-code-from test-runner-only
```

`--exit-code-from test-runner-only` makes the compose command exit with the test runner's exit code, so CI correctly detects test failures.

---

## Development Environment (Devcontainer & Codespaces)

For zero-setup provisioning, Ledgera ships a [VS Code Dev Container](https://containers.dev/) configuration in [`.devcontainer/`](./.devcontainer/devcontainer.json). It gives you Node 20, the Rust toolchain (with the `wasm32-unknown-unknown` target), and the Stellar CLI, pre-installed, with no local setup required.

**Using VS Code:**

1. Install the [Dev Containers extension](https://marketplace.visualstudio.com/items?itemName=ms-vscode-remote.remote-containers).
2. Open the repository in VS Code and select **"Reopen in Container"** when prompted (or run the **Dev Containers: Reopen in Container** command).
3. Wait for [`.devcontainer/post-create.sh`](./.devcontainer/post-create.sh) to finish installing `rustup`, the `wasm32-unknown-unknown` target, `stellar-cli`, and `npm install` — then you're ready to build, test, and run the example scripts.

**Using GitHub Codespaces:**

Open the repository on GitHub and select **Code → Codespaces → Create codespace on main** — the same `.devcontainer/` configuration provisions the Codespace automatically.

The container forwards port `3000` and preinstalls `dbaeumer.vscode-eslint`, `esbenp.prettier-vscode`, `rust-lang.rust-analyzer`, and `tamasfe.even-better-toml` as recommended extensions.

---

## Security Policy

Security is the foundation of PayFi. See [SECURITY.md](./SECURITY.md) for the full responsible disclosure policy, response SLAs, core security invariants, and secret management guidelines.

To report a vulnerability privately, use [GitHub Security Advisories](https://github.com/MiLedgera/Ledgera/security/advisories/new).

### Spending Limit Enforcement

PayFiAgent enforces two layers of spending limits to prevent runaway payments:

- **AGENT_SPENDING_LIMIT**: A configurable per-transaction ceiling (set via environment variable). Before every payment task (`stellar_payment` or `x402_respond`), the `assertWithinSpendingLimit()` function in `backend/agent.ts` checks the requested amount. If it exceeds `AGENT_SPENDING_LIMIT`, the task fails immediately with error: `"Payment amount X exceeds AGENT_SPENDING_LIMIT of Y"`.
- **Mainnet Spending Cap**: A hardcoded safety ceiling of **10,000** on mainnet. Even if `AGENT_SPENDING_LIMIT` is misconfigured above this, mainnet transactions are blocked if they exceed 10,000, throwing: `"Payment amount X exceeds mainnet spending cap of 10,000"`.

These limits apply to:
- Direct `stellar_payment` tasks via `StellarPaymentTool`
- `x402_respond` tasks that trigger automatic payment via `X402PaymentTool`
- `soroban_invoke` tasks whose contract calls internally move funds. A contract invocation can trigger Stellar Asset Contract (SAC) transfers (`transfer`, `transfer_from`, `burn`) that are invisible in the request payload, so `SorobanInvokeTool` derives the amount from the mandatory Soroban simulation: it sums the simulated SAC events that debit the agent, rejects the invocation when the total exceeds the limit (error: `"Contract invocation transfers X ... exceeds AGENT_SPENDING_LIMIT of Y"`), and records within-limit spends into the same rolling spending window as payments. Dry-runs (`simulateOnly: true`) are checked but never recorded, since no funds move.

### Mainnet Checklist

Before deploying to **Stellar mainnet**, verify the following:

- [ ] **Set `STELLAR_NETWORK=mainnet`** — This enables the mainnet spending cap and enforces HTTPS-only RPC connections.
- [ ] **Set `AGENT_SPENDING_LIMIT` below 10,000** — The limit should reflect your acceptable per-transaction maximum (e.g., `1000` for USD denominations). Values above 10,000 will be rejected on mainnet.
- [ ] **Verify `X402_ASSET_ISSUER`** — Confirm this is the canonical USDC anchor account on mainnet. Misconfiguration sends payments to the wrong issuer.
- [ ] **Test with `simulateOnly: true` first** — For `soroban_invoke` tasks, set `simulateOnly: true` to dry-run contract logic without broadcasting. This validates gas estimation and state changes in a safe sandbox.

All four checks are enforced at startup via `backend/config.ts` validation and at task dispatch time via `backend/agent.ts` guards.

---

## Contributing

We are actively participating in the **Stellar Wave** program! We welcome contributions ranging from bug fixes to new tool modules.

1.  Check the [Issues](https://github.com/MiLedgera/Ledgera/issues) tab for tickets tagged `good first issue` or `help wanted`.
2.  Follow the [CONTRIBUTING.md](./CONTRIBUTING.md) guide.
3.  Submit a Pull Request and join our community in the next Wave sprint to earn Drips points for your contributions!

---

## Examples

Runnable scripts in `scripts/examples/` demonstrate each `TaskType` with real payloads. Copy `.env.example` to `.env` and fill in your values, then run any script with:

```bash
npx ts-node scripts/examples/<script>.ts
```

### `send_xlm.ts` — stellar_payment

Sends 1 XLM to a recipient account on testnet.

```bash
npx ts-node scripts/examples/send_xlm.ts
```

### `invoke_escrow.ts` — soroban_invoke

Calls `get_state` on a deployed escrow contract (simulate-only, no broadcast). Pass the contract address via `CONTRACT_ID`:

```bash
CONTRACT_ID=C... npx ts-node scripts/examples/invoke_escrow.ts
```

### `respond_x402.ts` — x402_respond

Responds to a sample x402 payment challenge and prints the resulting `X402PaymentProof`.

```bash
npx ts-node scripts/examples/respond_x402.ts
```

### `x402_full_flow.ts` — Full Autonomous x402 Payment Flow

Demonstrates the complete x402 flow end-to-end: starts a local Express server with a gated `/resource` endpoint, handles the initial request that triggers a `402 Payment Required` challenge, runs the agent to autonomously pay the challenge, and accesses the unlocked resource using the resulting payment proof. Operates offline without live network access using `mockHorizonServer`.

```bash
npx ts-node scripts/examples/x402_full_flow.ts
```

### `multisig_payment.ts` — multisig_payment

Demonstrates the two-phase multisig workflow: first dispatch returns an unsigned XDR for external signature collection, then re-dispatch with collected signatures to submit (simulate-only in this example).

```bash
npx ts-node scripts/examples/multisig_payment.ts
```

### `place_dex_offer.ts` — dex_offer

Places a manage-sell offer on the Stellar DEX. This example creates an offer to sell XLM for USDC at a specified price. Use `action: "create"` to place, `"update"` to modify, or `"delete"` to cancel.

```bash
npx ts-node scripts/examples/place_dex_offer.ts
```

### `query_contract.ts` — soroban_query

Performs a read-only query on a Soroban contract without broadcasting. This example calls `get_state` on a deployed escrow contract to verify state after deployment. Pass the contract address via `CONTRACT_ID`:

```bash
CONTRACT_ID=C... npx ts-node scripts/examples/query_contract.ts
```

### `fee_bump.ts` — fee_bump

Wraps a transaction in a fee-bump envelope for sponsored retry flows. This is useful when the agent needs to pay fees on behalf of a transaction signed by a different account. Pass the inner transaction XDR via `INNER_TX_XDR`:

```bash
INNER_TX_XDR=AAAA... npx ts-node scripts/examples/fee_bump.ts
```

### `anchor_deposit.ts` — SEP-0010 + SEP-0006 anchor deposit

Demonstrates a complete PayFi onboarding scenario by combining `StellarIdentityTool` (SEP-0010 web auth) with an anchor USDC deposit flow:

1. Fetches the anchor's `stellar.toml` to discover `WEB_AUTH_ENDPOINT` and `TRANSFER_SERVER`.
2. Authenticates with the anchor via SEP-0010 challenge-response and obtains a JWT.
3. Initiates a SEP-0006 deposit to obtain the anchor's deposit address (and optional memo).
4. Sends a test asset payment to the deposit address via `stellar_payment`.
5. Prints a deposit confirmation summary.

Tested against the [Stellar Demo Anchor](https://testanchor.stellar.org) on testnet.

**Required .env vars** (in addition to the standard set):

| Variable | Description |
|---|---|
| `ANCHOR_URL` | Base URL of the anchor (e.g. `https://testanchor.stellar.org`) |
| `ANCHOR_ASSET_ISSUER` | Issuer account of the anchor asset |

```bash
npx ts-node scripts/examples/anchor_deposit.ts
```

---

## E2E Tests

End-to-end tests run against the live Stellar testnet (not mocked). They require network access to Friendbot and Soroban RPC.

```bash
npm run test:e2e
```

The E2E suite is excluded from the default `npm run test` to keep CI fast. Run it separately before releases or after SDK upgrades.

---

## License

Released under the [MIT License](LICENSE).

---

_Built for the Stellar ecosystem by [Dami24-hub]._

---

## API Reference

### PayFiAgent

The primary integration surface for developers. Dispatch tasks to the agent via `run()` or `runSequence()`.

| Method | Input | Output | Description |
|--------|-------|--------|-------------|
| `run(task)` | `AgentTask` | `Promise<AgentResult>` | Execute a single task. Routes to the appropriate tool based on task type. |
| `runSequence(tasks)` | `AgentTask[]` | `Promise<AgentResult[]>` | Execute an ordered list of tasks sequentially, stopping on first failure. |
| `destroy()` | — | `void` | Detach all event listeners and release resources. Call when decommissioning the agent. |

### TaskType

`TaskType` is a string union with one member per dispatchable task. The authoritative list is the `TaskType` union in [`backend/agent.ts`](./backend/agent.ts) — copying it here as prose has drifted out of sync before, so this section intentionally doesn't re-list every value. Any string not in the union throws `"Unknown task type: <value>"` immediately at dispatch time, before any tool runs.

For the complete table of every `TaskType` value, its handling tool class, and a description, see [ARCHITECTURE.md § Registered Task Types](./ARCHITECTURE.md#registered-task-types) — that table is generated by reading the same switch statement in `agent.ts` and is kept in sync with it.

A representative sample:

| Value | Tool | Description |
|-------|------|-------------|
| `stellar_payment` | `StellarPaymentTool` | Submit a native XLM or custom Stellar asset payment via Horizon. Enforces the per-transaction `AGENT_SPENDING_LIMIT` and the mainnet spending cap before execution. |
| `soroban_invoke` | `SorobanInvokeTool` | Invoke any Soroban smart contract function. Always runs a mandatory simulation pass via Soroban RPC before broadcast; set `simulateOnly: true` for a dry-run that skips submission. |
| `x402_respond` | `X402PaymentTool` | Respond to an [x402](https://github.com/x402-foundation/x402) `402 Payment Required` challenge. Validates the challenge schema, enforces spending limits, delegates to `StellarPaymentTool`, and returns an `X402PaymentProof`. |

> **Standalone utilities:** `BalanceCheckTool` (`backend/tools/BalanceCheckTool.ts`) and `SorobanQueryTool` (`backend/tools/SorobanQueryTool.ts`) are importable directly and are not dispatched through `PayFiAgent.run()`. Use them outside the agent task loop when you only need a read-only query.

### AgentTask

```typescript
interface AgentTask {
  type: TaskType;
  payload: unknown;
  correlationId?: string;
}
```

Input wrapper for task dispatch. Each tool validates its own `payload` shape with a Zod schema at execution time (see e.g. `PaymentInputSchema` in `backend/tools/StellarPaymentTool.ts`) — those schemas, not this README, are the source of truth for exact field names and types. A few illustrative examples:
- `stellar_payment`: `{ destination: string; amount: string; assetCode?: string; assetIssuer?: string; memo?: string }`
- `soroban_invoke`: `{ contractId: string; method: string; args: xdr.ScVal[]; simulateOnly?: boolean }`
- `x402_respond`: `{ resource: string; amount: string; assetCode?: string; assetIssuer?: string; payTo: string; nonce: string; expiresAt: string }`
- `batch_payment`: `{ payments: PaymentInput[]; failFast?: boolean }` (max 100 payments; aggregate spending limit enforced)

### AgentResult

```typescript
interface AgentResult {
  success: boolean;
  taskType: TaskType;
  data?: unknown;
  error?: string;
  errorType?: string;
  correlationId?: string;
  durationMs?: number;
  sequenceIndex?: number;
}
```

Task execution result. On success, `data` contains the tool's output. On failure, `error` is populated.

| Field | Present | Meaning |
|---|---|---|
| `success` | always | Whether the task completed. |
| `taskType` | always | The task type that was dispatched. |
| `data` | on success | The tool's output. |
| `error` | on failure | Failure message. For a `StructuredError` carrying context, the context is appended as `\| context: {...}` JSON — an auth rejection, for example, reports the signer that was presented and the one expected. Signing material is stripped before serialisation. |
| `errorType` | on failure | Machine-readable category (`UNAUTHORIZED_ERROR`, `TRANSACTION_FAILURE`, …) so callers can branch without string matching. |
| `correlationId` | always | Ties together every log line, persisted result, and webhook for this execution. |
| `durationMs` | usually | Wall-clock execution time. |
| `sequenceIndex` | `runSequence` only | Zero-based position of the task within the `runSequence` call. Since the sequence stops at the first failure, the last entry's `sequenceIndex` is the index of the task that failed — and it stays correct after the results are filtered or sorted, which array position does not. Absent on `run()`. |

### Usage Example

```typescript
import { PayFiAgent } from "./backend/agent";

const agent = new PayFiAgent();

// Execute a Stellar payment
const result = await agent.run({
  type: "stellar_payment",
  payload: {
    destination: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
    amount: "100",
    assetCode: "USDC",
    assetIssuer: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
  },
});

if (result.success) {
  console.log("Payment settled:", result.data);
} else {
  console.error("Payment failed:", result.error);
}

// Clean up
agent.destroy();
```

---

## x402 Payment Flow

Ledgera implements the [x402](https://github.com/x402-foundation/x402) protocol so the agent can pay for gated resources autonomously. The verified flow below covers what happens once `PayFiAgent.run()` is dispatched an `x402_respond` task — the upstream step of a resource server actually issuing the 402 challenge happens outside this codebase (in whatever client first calls `PayFiAgent.run()`), so it's described in prose rather than diagrammed.

```mermaid
sequenceDiagram
    participant C as Caller
    participant PA as PayFiAgent
    participant X as X402PaymentTool
    participant ST as StellarPaymentTool
    participant H as Horizon

    C->>PA: run({ type: "x402_respond", payload })
    PA->>PA: assertWithinSpendingLimit(amount)
    PA->>X: respond(challenge)
    X->>X: X402ChallengeSchema.parse(challenge)
    Note over X: reject if amount > AGENT_SPENDING_LIMIT<br/>reject if expiresAt has passed
    X->>ST: execute({ destination: payTo, amount, memo })
    ST->>H: sign + submit transaction
    H-->>ST: txHash, ledger
    ST-->>X: { txHash, ledger }
    X-->>PA: X402PaymentProof
    PA-->>C: AgentResult
````

In practice, the `payload` handed to `run()` is the parsed body of a `402 Payment Required` response from a resource server, conforming to `X402ChallengeSchema` — but the HTTP exchange that obtains and replays that challenge is the caller's responsibility, not `X402PaymentTool`'s.

### Spending limit guard

Before `PayFiAgent.run()` delegates to `X402PaymentTool`, it calls `assertWithinSpendingLimit()` on the payload's `amount` field. If the requested amount exceeds `config.AGENT_SPENDING_LIMIT`, the task throws immediately and `X402PaymentTool.respond()` is never invoked — the agent will not even attempt to validate or pay a challenge above its configured budget.

### `X402ChallengeSchema`

Once past the spending check, `X402PaymentTool.respond()` validates the challenge against this schema before doing anything else:

| Field         | Type                    | Description                                                                                                              |
| ------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `resource`    | `string` (URL)          | The URL of the resource being gated. Must be a valid URL.                                                                |
| `amount`      | `string`                | The amount due, as a string to avoid floating-point precision issues in transit.                                         |
| `assetCode`   | `string`                | The Stellar asset code to pay in (e.g. `USDC`, or `XLM` for native). Defaults to `config.X402_ASSET_CODE`.               |
| `assetIssuer` | `string`                | The issuing account of the asset. Defaults to `config.X402_ASSET_ISSUER`. Ignored when `assetCode` is `XLM`.             |
| `payTo`       | `string`                | The recipient Stellar account. Must be exactly 56 characters (a valid Stellar public key).                               |
| `nonce`       | `string` (UUID v4)      | A unique identifier for this challenge, used to correlate the resulting payment with the original request.               |
| `expiresAt`   | `string` (ISO datetime) | The deadline after which the challenge is no longer valid. Checked against `new Date()` before any payment is attempted. |

If `rawChallenge` doesn't conform to this shape, `X402ChallengeSchema.parse()` throws and no payment is attempted.

### Nonce → memo derivation

The challenge's `nonce` is a UUID v4 (36 characters), but Stellar's text memo field caps at 28 bytes. `X402PaymentTool` truncates it directly:

```typescript
memo: challenge.nonce.slice(0, 28);
```

This embeds enough of the nonce on-chain for a resource server to correlate a settled transaction with the original challenge by memo lookup on Horizon. Note this is a string truncation, not a hash — a resource server verifying the proof should compare against the same `slice(0, 28)` of the nonce it issued.

### `X402PaymentProof`

Once `StellarPaymentTool.execute()` returns a settled `txHash`, `respond()` builds and returns:

```typescript
interface X402PaymentProof {
  protocol: "x402"; // protocol tag, always "x402"
  network: string; // config.STELLAR_NETWORK
  txHash: string; // settled Stellar transaction hash
  nonce: string; // the original challenge nonce, in full
  payer: string; // the agent's Stellar public key
  signedAt: string; // ISO timestamp the proof was issued
}
```

The proof carries no embedded signature of its own. Verification is delegated to whatever consumes the proof: it looks up `txHash` on Horizon and confirms the payment's destination, amount, and memo match what the original challenge demanded. The proof is a pointer to on-chain truth, not a self-contained credential.

Note that `StellarPaymentTool.execute()` — and therefore `x402_respond`, which delegates to it — does **not** run a Soroban simulation pass before submission: Horizon has no simulation endpoint, so the tool validates the transaction envelope locally, signs, and submits directly. Simulation-before-broadcast (see [ARCHITECTURE.md § The Mandatory Simulation Gate](./ARCHITECTURE.md#the-mandatory-simulation-gate)) applies to the Soroban RPC path (`soroban_invoke`, `soroban_query`, `soroban_deploy`), not to Horizon Classic operations like this one.

### Minimal usage example

```typescript
import { PayFiAgent } from "./backend/agent";

const agent = new PayFiAgent();

// `challenge` is the parsed JSON body of a 402 response from a resource server
const result = await agent.run({
  type: "x402_respond",
  payload: challenge,
});

if (result.success) {
  const proof = result.data; // X402PaymentProof
  // retry the original resource request, attaching `proof`
}
```

See [`backend/agent.ts`](./backend/agent.ts) for task dispatch and the spending-limit guard, and [`backend/tools/X402PaymentTool.ts`](./backend/tools/X402PaymentTool.ts) for challenge validation and proof construction.
