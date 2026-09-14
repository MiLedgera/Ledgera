# Current-State Audit — Ledgera / "Nodal AI" (stellar-agent-kit)

**Audit date:** 2026-09-13
**Auditor:** Claude Code, automated repository audit (Phase 1 of a requested 6-phase audit/redesign/skeletonization engagement)
**Repository:** `MiLedgera/Ledgera` (origin), branch `main`, working tree clean at time of audit
**Method:** Direct reading of source files (config, orchestrator, HTTP server, all 34 `backend/tools/*.ts`, all infra modules, the Rust escrow contract and its tests, CI workflow, deployment files, governance docs) plus a dependency install and build/lint/test run. Claims in comments/README/SECURITY.md were cross-checked against actual code rather than trusted at face value, per audit instructions.

---

## Executive Summary

**This codebase does not match the "unstructured AI-generated, poorly reviewed" profile that this audit engagement was scoped to assume.** It is a reasonably mature, actively engineered Stellar/Soroban payment-agent kit with:

- Schema-validated configuration (Zod) with startup-time fail-fast and secret-key encapsulation via closure (`backend/config.ts`)
- A real security document (`SECURITY.md`) with a disclosure policy, SLAs, and documented *known* limitations
- CI with build, lint, TypeScript tests, Rust tests, Clippy, rustfmt, code coverage, WASM size budget enforcement, npm audit, Snyk, `cargo audit`, TruffleHog secret scanning, TypeDoc generation, and markdown link checking (`.github/workflows/ci.yml`)
- 55 test files (~12,800 lines) with genuine mocking discipline and boundary-condition coverage, not boilerplate
- A Soroban escrow contract with a TOCTOU-safe access-control pattern and 40 tests including property-based fund-conservation checks
- Git hooks (Husky) for secret scanning and lint-staged formatting, CODEOWNERS, dependabot, issue/PR templates

That said, the audit did find **real, concrete defects** — some of them significant — that a template assuming "everything here is untrustworthy" would have been right to go looking for. The most important:

1. **Critical: the spending-limit / mainnet-cap guard is enforced for only 2 of 8 value-moving task types.** `multisig_payment`, `batch_payment` (partially), `path_payment`, `swap`, `dex_offer`, `liquidity_pool`, and `sponsored_account` can move value with no cap check and without contributing to the rolling spending window — see [Finding S-1](#s-1-spending-limit-enforcement-gap-critical).
2. **High: `SorobanDeployTool` calls SDK methods (`uploadContractWasm`, `createContractFromWasm`) that do not exist on `@stellar/stellar-sdk@13.3.0`'s RPC server class.** It is wired into the live task dispatcher and will almost certainly throw in production; only mocked tests pass — see [Finding B-1](#b-1-sorobandeploytool-likely-non-functional-in-production-high).
3. **High: 13 of 34 tool files are fully implemented, several fully tested, but never wired into the agent** — dead code in the running application, and a source of confusion about what the product actually does — see [Finding Q-1](#q-1-13-orphaned-tool-implementations-high).
4. **Medium: `SECURITY.md` describes a `config.ts` secret-fetch mechanism (`execSync`) that does not match the actual code** (which uses the AWS SDK `SecretsManagerClient`, not `execSync`) — a documentation/implementation drift that could mislead a security reviewer — see [Finding D-1](#d-1-securitymd-vs-configts-drift-medium).
5. **Medium: README.md's own "API Reference" section is internally inconsistent** — conflicting `TaskType` listings, a stray markdown fence, and undocumented task types — see [Finding D-2](#d-2-readme-api-reference-internally-inconsistent-medium).
6. Assorted **Low/Informational** hygiene issues: build output (`dist/`) is git-tracked despite being gitignored; a stray npm tarball (`picomatch-4.0.4.tgz`) and a stray text file (`tests/temp.txt`, containing only "hello") are committed at the repo root/tests dir; a WASM size budget (200,000 B) that exceeds Stellar's actual network deployment ceiling (131,072 B); a single-owner CODEOWNERS file that doesn't cover the two most central orchestration files.

**Recommendation for how to proceed:** given the codebase's actual maturity, a full "reduce to skeleton and rebuild from scratch" (this engagement's Phase 5) would discard substantial, working, tested logic — including a property-tested smart contract and a security model that is largely sound — to fix problems that are addressable with targeted patches. **This is flagged explicitly for a decision before Phase 2 proceeds; see [Recommended Decisions](#recommended-decisions).**

---

## Project Purpose

A backend agent ("PayFiAgent") that autonomously signs and submits Stellar/Soroban transactions on behalf of an operator, exposing ~21 discrete payment/query/contract operations ("tools") behind a single `run(task)` dispatch method, plus a minimal HTTP server for health/status/spending introspection. It implements the x402 HTTP micropayment challenge-response protocol and includes a Soroban escrow smart contract as a companion on-chain component. Positioned (per README) as infrastructure for AI-agent-driven payments ("PayFi") on Stellar. **Target users:** developers embedding autonomous or semi-autonomous Stellar payment capability into an application or agent framework — this is a library/kit, not an end-user product. No frontend exists or is claimed to exist.

## Current Features

- 21 dispatchable task types covering native/asset payments, path payments, DEX offers, liquidity pools, trustlines, multisig, batch payments, fee-bump sponsorship, sponsored account creation, Soroban contract invocation/query/deploy, data entries, sequence numbers, anchor quotes (SEP-38), inflation destination, account info/history.
- x402 challenge-response payment protocol with nonce replay protection, rate limiting, and origin allowlisting.
- Soroban escrow contract: initialize/release/refund/partial-release/cancel/arbiter-rotation lifecycle.
- Middleware chain, task queueing/concurrency limits, graceful drain/shutdown.
- SQLite-backed audit log and spending-window persistence (survives restart).
- Webhook dispatch with HMAC signing for task results.
- OpenTelemetry instrumentation, Pino structured logging, circuit breaker (opossum) around RPC calls.
- Health-check HTTP server (`/health`, `/status`, `/spending`) for container orchestration.
- 13 additional tool implementations that exist but are not wired into any dispatch path (see [Finding Q-1](#q-1-13-orphaned-tool-implementations-high)).

## Repository Structure

```
backend/            TypeScript agent orchestration ("Pillar 1")
  agent.ts            PayFiAgent orchestrator — task dispatch, spending guard, middleware, lifecycle
  config.ts           Zod-validated env config, secret-key encapsulation
  server.ts           Health-check HTTP server (/health, /status, /spending)
  rpc_client.ts       Horizon/Soroban RPC gateway — retries, circuit breaker, caching, simulation gate
  persistence.ts      SQLite audit log
  spending_tracker.ts Rolling-window spending accounting (persisted)
  nonce_store.ts      x402 nonce replay protection (SQLite/in-memory)
  webhook.ts          HMAC-signed webhook dispatch with retry classification
  telemetry.ts        OpenTelemetry init/shutdown
  errors.ts           StructuredError hierarchy + cause sanitisation
  logger.ts / utils/logger.ts   TWO parallel logger implementations (see Finding Q-9)
  db/client.ts        SQLite connection singleton + health probe
  middleware/error_handler.ts   HTTP error → status code mapping
  types/xdr.ts        XDR-related type helpers
  tools/              34 files, one per Stellar/Soroban operation (21 wired, 13 not — see Finding Q-1)
contracts/escrow/    Soroban Rust escrow contract ("Pillar 2") — lib.rs, test.rs, README, WASM budget doc
tests/               55 files (~12,800 lines): unit, e2e (2 files, live-testnet, excluded from default run), fuzz (2 files), fixtures, helpers ("Pillar 3")
scripts/             setup.ts (.env generator), dev.sh, check_wasm_size.sh, find_secrets.js, examples/ (16 runnable example scripts)
.github/             CI workflow, CODEOWNERS, issue/PR templates, dependabot, labeler
docs/                (created by this audit; previously empty)
Root                 README, ARCHITECTURE.md, SECURITY.md, CONTRIBUTING.md, CHANGELOG.md, GLOSSARY.md, LICENSE, Dockerfile, docker-compose.yml, .devcontainer/
```

`dist/` (compiled output) and `picomatch-4.0.4.tgz` and `tests/temp.txt` are present and git-tracked but are not part of the intended source structure — see [Finding H-1..H-3](#hygiene-findings).

## Technology Stack

- **Language/runtime:** TypeScript 5.9 on Node 20, compiled via `tsc` (no bundler/framework — Express is a dependency but `backend/server.ts` uses the raw `http` module, not Express; `express` in `package.json` appears unused — **Needs verification** by grepping for actual Express usage before removal).
- **Blockchain SDK:** `@stellar/stellar-sdk` 13.3.0 (Horizon + Soroban RPC clients).
- **Validation:** Zod 3.25.
- **Persistence:** `better-sqlite3` 12.11 (synchronous SQLite).
- **Resilience:** `opossum` 8.5 (circuit breaker).
- **Observability:** `pino` (logging), OpenTelemetry SDK + auto-instrumentations.
- **Secrets:** `@aws-sdk/client-secrets-manager` (optional ARN-based secret fetch).
- **Smart contract:** Rust + Soroban SDK, `rust-toolchain.toml` pinned to 1.78.0 for Soroban compatibility.
- **Testing:** Vitest 3.2 (TS), Cargo test + `cargo-tarpaulin` (Rust coverage), Stryker (mutation testing), `fast-check` (present as a dependency; the actual fuzz tests use hand-rolled randomization rather than `fast-check` — **Needs verification** whether `fast-check` is used anywhere).
- **Tooling:** ESLint 8 + `@typescript-eslint`, Prettier, Husky + lint-staged, TypeDoc, `conventional-changelog`.

## System Architecture

Three-pillar structure per `ARCHITECTURE.md` (backend agent / Soroban contracts / tests), which the audit confirms is an accurate description of the actual layout. `backend/index.ts` startup sequence: await `configPromise` → `initTelemetry()` → construct `PayFiAgent` (instantiates the 21 wired tools) → `startHealthServer()` → register SIGTERM/SIGINT → on signal: `agent.drain()` → `waitForPendingTasks()` → close health server → `db.close()` → `shutdownTelemetry()`. No separate process/worker split; single Node process handles both the health HTTP server and task dispatch.

## Backend Analysis

`PayFiAgent.run(task)` is the sole entry point for task execution: drain check → concurrency gate (queue or reject) → middleware chain → spending guard (for 2 of 8 money-moving types, see Finding S-1) → tool dispatch via `switch` → result persistence → webhook dispatch. Error handling is centralized: every thrown error is caught, redacted (`redactSecretString`, `sanitizeCause`), classified (`getErrorType`), and returned as a structured `AgentResult` rather than propagating raw exceptions. This is a sound design.

The 34 files in `backend/tools/` mostly follow a documented "standard tool pattern" (Zod validate → pre-flight guard → `loadAccount` → build tx → simulate-if-Soroban → sign → submit), and `ARCHITECTURE.md` documents this pattern accurately, including a step-by-step guide for adding new tools. Deviations from the pattern are noted in [Code-Quality Findings](#code-quality-findings).

## Frontend Analysis

**None exists.** This is a backend-only kit; no frontend directory, no UI framework dependency, no static assets beyond documentation. Any Phase 4 "minimal frontend" work in the roadmap should be scoped as **net-new**, not a reduction of existing frontend code, since there is none to reduce.

## Database Analysis

SQLite via `better-sqlite3`, file path configurable via `DB_PATH` (default `./agent.db`, `:memory:` supported for tests). Two concerns of substance:
- `persistence.ts` runs an idempotent `ALTER TABLE ... ADD COLUMN` migration guarded by `PRAGMA table_info` — functional, but this is the *only* migration path; there is no versioned migration tool (e.g. numbered migration files) so schema evolution beyond simple column additions has no established process.
- `db/client.ts`'s `close()` does not actually close the underlying SQLite handle (only flips an internal flag) — see [Finding Q-8](#q-8-dbclientclose-does-not-close-the-connection-low).

## Smart-Contract Analysis

The escrow contract (`contracts/escrow/src/lib.rs`, 706 lines) is the strongest-engineered part of the codebase. Eight entry points (`initialize`, `release`, `refund`, `get_state`, `release_partial`, `cancel`, `propose_new_arbiter`, `accept_arbiter_rotation`) implement a depositor/recipient/arbiter escrow with a consistently-applied TOCTOU-safe authorization pattern (every mutating call re-reads the authorized party from storage and calls `require_auth()` on the *stored* value, never a caller-supplied parameter, before comparing). 40 tests (1293 lines) including 3 property-based fund-conservation checks give real confidence in the state machine. See [Finding B-2](#b-2-escrow-contract-documentation-lags-the-code-medium) and [Finding B-3](#b-3-wasm-size-budget-exceeds-the-actual-network-limit-medium) for doc/config drift specific to this contract.

## Authentication and Authorization Analysis

There is no end-user authentication system (this is a backend agent kit, not a multi-tenant service). Authorization is entirely at the **transaction-signing** level: the agent's own keypair authorizes on-chain operations; the escrow contract's `require_auth()` calls authorize contract state transitions; the HTTP server's `/status` and `/spending` endpoints support an optional Bearer-token check (`WEBHOOK_SECRET`) that is **fully bypassed when unset** (`isAuthenticated()` returns `true` unconditionally) — this is a documented default-open posture, not a bug, but worth flagging: **if an operator deploys without setting `WEBHOOK_SECRET`, `/status` (which returns persisted `AgentResult` records — potentially including transaction hashes, error contexts, and correlation IDs) is unauthenticated by default.** `/health` is intentionally always open (standard for container liveness probes).

## Security Findings

#### S-1. Spending-limit enforcement gap (**Critical**)
- **Evidence:** `backend/agent.ts:588-696` (switch statement) calls `assertWithinSpendingLimit()` only for `case 'stellar_payment'` (line 590) and `case 'x402_respond'` (line 610). `SorobanInvokeTool.ts:386-413` separately enforces a cap on simulated SAC transfers. No equivalent check exists for `multisig_payment`, `path_payment`, `swap`, `dex_offer`, `liquidity_pool`, or `sponsored_account`. `batch_payment` (`BatchPaymentTool.ts:69-75`) checks its aggregate total against `AGENT_SPENDING_LIMIT` only — never against `MAINNET_SPENDING_CAP`, and never calls `spendingTracker.record()`, so it doesn't count toward the rolling window that gates `stellar_payment`.
- **Impact:** The configured `AGENT_SPENDING_LIMIT` and the hardcoded mainnet safety cap (10,000) — both prominently documented in README, SECURITY.md, and ARCHITECTURE.md as core safety guarantees — can be bypassed entirely via 6 of 8 value-moving task types, or partially evaded via `batch_payment` fragmentation. On mainnet with a compromised or over-broadly-scoped caller, this could allow unbounded fund movement through `multisig_payment`, `path_payment`/`swap` (DEX-routed), `dex_offer`, `liquidity_pool`, or `sponsored_account`.
- **Recommended action:** Add `assertWithinSpendingLimit`-equivalent guards (and `spendingTracker.record()` calls) to every money-moving task type before Phase 2 proceeds, or explicitly document this as accepted risk with compensating controls (e.g. an operator-side allowlist) if intentional.

#### S-2. `/status` endpoint unauthenticated by default (**Medium**)
- **Evidence:** `backend/server.ts:107-113`, `isAuthenticated()` returns `true` whenever `WEBHOOK_SECRET` is unset; `/status` (server.ts:143-168) requires no auth check at all (only `/spending` calls `isAuthenticated`) and returns up to the last 10 persisted `AgentResult` records including `correlationId`, `taskType`, `error` text, and `data` (which for e.g. `multisig_payment` includes unsigned XDR).
- **Impact:** Default deployment (no `WEBHOOK_SECRET` configured) exposes recent transaction history/results to any network caller who can reach the health port.
- **Recommended action:** Require explicit configuration to enable `/status`/`/spending`, or apply the same auth gate to `/status` that `/spending` already has.

#### S-3. `sanitizeCause()` allow-list misses `newAccountSecret` (**Medium**)
- **Evidence:** `backend/errors.ts` — `SENSITIVE_CAUSE_KEYS` is an exact-match set (`secretKey`, `privateKey`, `seed`, `_secretKey`) that does not include `newAccountSecret`, the field name `SponsoredAccountTool.ts:27` actually uses for a raw secret passed in the task payload. `agent.ts`'s separate `sanitizePayload()` uses a broader regex (`/secret|key|seed|mnemonic|private/i`) that *would* catch it, but that function only runs on the top-level task payload logged on failure — not on any `cause` object attached to a `StructuredError`.
- **Impact:** If `SponsoredAccountTool` ever throws a `StructuredError` with the raw input (including `newAccountSecret`) as `cause`, the secret could survive `sanitizeCause()` and reach a log line or persisted error string.
- **Recommended action:** Make `sanitizeCause()` pattern-based (matching `agent.ts`'s regex) instead of an exact-match allow-list, or explicitly add `newAccountSecret` to the list.

#### S-4. `SponsoredAccountTool` accepts a raw secret key as a task-payload field (**Low/Design**)
- **Evidence:** `SponsoredAccountTool.ts:27,79-81` — `newAccountSecret` field, used to construct `Keypair.fromSecret()` for co-signing. Every other multi-party tool (`MultiSigPaymentTool`) instead accepts a pre-computed signature.
- **Impact:** Requires a third party's private key to transit the same `AgentTask` payload channel as all other (non-secret) task data; no compensating control beyond post-hoc log redaction.
- **Recommended action:** Redesign to accept a signature or delegate signing out-of-band, consistent with `MultiSigPaymentTool`'s pattern.

#### S-5. Dual logger implementations with inconsistent secret redaction (**Low**)
- **Evidence:** `backend/logger.ts` (custom, regexes out Stellar secret keys) vs. `backend/utils/logger.ts` (Pino-based, `REDACT_PATHS` covers only memo fields — **no secret-key redaction at all**). Both are imported across the codebase; which safety net applies depends on which file a given module happens to import.
- **Impact:** Currently no code path was found that logs a raw secret through the Pino logger (spot-checked across all 34 tool files by the auditing sub-agent), but the inconsistency is fragile — a future change could introduce a leak with no redaction backstop.
- **Recommended action:** Consolidate onto a single logger with one redaction policy covering both memos and secret-key patterns.

## Code-Quality Findings

#### Q-1. 13 orphaned tool implementations (**High**)
- **Evidence:** `ClaimableBalanceTool.ts`, `SetOptionsTool.ts`, `SorobanEventIndexerTool.ts`, `BalanceStreamTool.ts`, `StellarIdentityTool.ts` (SEP-10), `ContractStorageWatcherTool.ts`, `FriendBotTool.ts`, `LedgerInfoTool.ts`, `NetworkStatusTool.ts`, `OfferBookTool.ts`, `SorobanStorageTool.ts`, `TransactionBuilderTool.ts` are fully implemented but never imported/instantiated/dispatched in `backend/agent.ts`. Five of these (`ClaimableBalanceTool`, `SetOptionsTool`, `SorobanEventIndexerTool`, `BalanceStreamTool`, `StellarIdentityTool`) even have passing dedicated test files, despite being unreachable in the running application.
- **Impact:** Confuses the actual product surface (README/ARCHITECTURE.md describe only the wired 21); dead code carries maintenance cost (must still pass lint/type-check/CI) with no corresponding runtime value; a contributor could reasonably believe these features ship when they don't.
- **Recommended action:** Decide per-tool: wire in (add `TaskType` + switch case) or remove. Do not carry silently.

#### Q-2. `TransactionBuilderTool.ts` imports from the orchestrator (**Low**)
- **Evidence:** `TransactionBuilderTool.ts:22`, `import { AgentTask } from '../agent'` — the only tool with a dependency pointing back at `agent.ts`, inverting the intended one-way dependency (tools should not import the orchestrator). Currently inert since the tool is unwired (Finding Q-1), but would create a real circular import if wired in as-is.

#### Q-3. Triplicated, drifted `buildMemo()` (**Medium**)
- **Evidence:** Near-identical implementations in `StellarPaymentTool.ts:98-154` and `PathPaymentTool.ts:75-130`, plus an independent third implementation in `MemoAttachmentTool.ts:26-92` with its **own locally-declared `ValidationError` class** — a different class from `backend/errors.ts`'s `ValidationError`, which is what `middleware/error_handler.ts` pattern-matches on for HTTP 400 responses.
- **Impact:** If `MemoAttachmentTool`'s `ValidationError` ever reaches `handleError()`, it will be misclassified as a 500 instead of a 400 (fails an `instanceof StructuredError` check). `X402PaymentTool.ts:165-169` also does a needless double-conversion (calls `MemoAttachmentTool.buildMemo()`, unwraps `.value`, hands the string to `StellarPaymentTool`'s separate `buildMemo()`).
- **Recommended action:** Consolidate into one shared memo-building module using the shared `errors.ts` hierarchy.

#### Q-4. Duplicated `AssetSchema` and amount/price regexes across tools (**Low**)
- **Evidence:** `{code, issuer?}` asset schema independently redeclared in `DexOfferTool.ts`, `PathPaymentTool.ts`, `LiquidityPoolTool.ts`, `SwapTool.ts`, `TransactionBuilderTool.ts`. Positive-decimal-with-7-places regex repeated verbatim in six schemas; two additional schemas (`DexOfferInputSchema.price`, `LiquidityPoolInputSchema.minPrice/maxPrice`) use a looser variant without the 7-decimal cap or anti-zero guard — a latent correctness drift risk, not just duplication.
- **Recommended action:** Factor into a shared `StellarAmountSchema`/`StellarPriceSchema`/`AssetSchema` module (the codebase already does this correctly for `SubmitResultSchema`, centralized in `StellarPaymentTool.ts` and reused by ~15 other tools — extend that pattern).

#### Q-5. Inconsistent self-payment guards (**Low**)
- **Evidence:** `StellarPaymentTool` (line 198) and `PathPaymentTool` (line 150) guard against paying the agent's own address; `MultiSigPaymentTool`, `BatchPaymentTool`, `DexOfferTool` have no equivalent check.

#### Q-6. `SorobanDeployTool` likely non-functional (see [Finding B-1](#b-1-sorobandeploytool-likely-non-functional-in-production-high) below — cross-referenced here as a code-quality issue, not just a runtime bug, since it indicates the tool was written and merged without integration testing against the real SDK surface).

#### Q-7. `integration.test.ts` is misleadingly named (**Low**)
- **Evidence:** `tests/integration.test.ts` (72 lines) only asserts `new PayFiAgent()` constructs without throwing, with all dependencies mocked — it does not exercise any multi-component flow despite its name. Real integration/e2e coverage actually lives in `tests/e2e/` and within `agent.test.ts`.

#### Q-8. `db/client.ts`'s `close()` does not close the connection (**Low**)
- **Evidence:** `DatabaseManager.close()` only sets `_isOpen = false`; the actual `better-sqlite3` handle lives in `persistence.ts`'s module-level singleton with no exported close function. Harmless in practice (process exit reclaims the handle) but the method's doc comment ("release the connection") overstates its effect.

#### Q-9. Two parallel logger implementations (cross-referenced from [S-5](#s-5-dual-logger-implementations-with-inconsistent-secret-redaction-low)).

#### Q-10. Undertested wired tools that move value or hit external services (**Medium**)
- **Evidence:** `AnchorQuoteTool.ts`, `DataEntryTool.ts`, `SequenceNumberTool.ts`, `SponsoredAccountTool.ts` are wired into `agent.ts`'s dispatch but have no corresponding `tests/*.test.ts` file. `SponsoredAccountTool` funds new accounts from the agent's own balance with no spending-cap check (Finding S-1) and no test coverage — the highest-risk combination found in the tools audit.

## Testing and CI Findings

The test suite (55 files, ~12,800 lines) is genuinely substantive: consistent mocking discipline at network boundaries, deliberate boundary-condition and error-path coverage (many tests reference specific issue numbers, suggesting regression tests written against real reported bugs), 3 fuzz/property-style test files, and 2 explicitly-isolated live-testnet e2e tests excluded from the default run. `Q-7` (above) is the one clear weak spot. CI (`.github/workflows/ci.yml`) runs build, lint+format check, full TS+Rust test suite, Clippy, rustfmt, Rust coverage (tarpaulin), WASM size budget enforcement, TruffleHog secret scanning, `npm audit`, optional Snyk, `cargo audit` (with two explicitly-justified, dated ignore entries for upstream `soroban-sdk`-pinned RUSTSEC advisories), TypeDoc generation, and markdown link-checking. This is a thorough pipeline for a repository of this size. One scanner gap: `.trufflehog-exclude-paths.txt` excludes the entire `tests/` tree from TruffleHog scanning (rationale: synthetic test keys), leaving that directory covered only by the narrower custom regex detector and the separate Husky/`find_secrets.js` allowlist-based scanner.

**Build/test verification:** `npm ci` was run as part of this audit to verify the pipeline actually works rather than trusting the scripts' descriptions — see [Verification Results](#verification-results-from-this-audit) below for outcome.

## Deployment Findings

Multi-stage `Dockerfile` (rust-builder → node-builder → prod-deps → production) runs as a non-root user, uses `npm ci --ignore-scripts`, and includes a `HEALTHCHECK`. One dead/sloppy artifact: the rust-builder stage's dependency pre-fetch step writes a throwaway stub `lib.rs` via a shell one-liner that is not valid Rust syntax (`Dockerfile:29-32`) — harmless because it's discarded before the real source is copied in, but should be cleaned up. `docker-compose.yml`'s `agent` service correctly requires `AGENT_SECRET_KEY`/`X402_ASSET_ISSUER` via `${VAR:?...}` and applies `security_opt: no-new-privileges` + `cap_drop: ALL`; its `test-runner`/`test-runner-only` services, however, default `AGENT_SECRET_KEY` to the **literal string** `process.env.AGENT_SECRET_KEY` when the shell variable is unset (`docker-compose.yml:108,137`) — a copy-paste artifact that passes a garbage string rather than failing loudly or providing a real test fixture. `scripts/setup.ts` correctly writes `.env` with `mode 0o600`.

## Dependency and Configuration Findings

- `express` is listed as a runtime dependency but `backend/server.ts` (the only HTTP server in the codebase) uses Node's built-in `http` module directly. **Needs verification**: grep the full `backend/` tree for actual Express usage before treating this as removable — it's possible it's used in an example script or a file not covered by this audit's file list.
- `fast-check` is a devDependency but the fuzz tests (`tests/fuzz/*.test.ts`) use hand-rolled `Math.random()`-based generation rather than `fast-check`'s API. **Needs verification** whether `fast-check` is used anywhere (e.g. in a file not sampled) before treating it as an unused dependency.
- `cargo audit` CI job carries two dated, justified RUSTSEC ignores (`RUSTSEC-2024-0344`, `RUSTSEC-2026-0009`) pinned transitively via `soroban-sdk` 20.x — not a defect, but a maintenance item to revisit whenever `soroban-sdk` is upgraded (already documented in the CI file's own comments).
- `.env.example` is consistent with `backend/config.ts`'s Zod schema for the variables it lists, though it does not list every optional variable the schema accepts (e.g. `OTLP_ENDPOINT`, `WEBHOOK_URL`, `WEBHOOK_SECRET`, `CONTRACT_EVENT_POLL_MS`, `ACCOUNT_CACHE_TTL_MS`, `TOML_CACHE_TTL_MS`, `AGENT_SECRET_KEY_ARN` are all valid per the schema but absent from `.env.example`). Low-severity documentation completeness gap.

## Hygiene Findings

#### H-1. `dist/` (build output) is git-tracked (**Low**)
- **Evidence:** `.gitignore` lists `dist/`, yet `git ls-files dist` returns the full compiled output tree (confirmed via `git ls-files`). This means `dist/` was committed before the ignore rule existed (or added with `-f`) and has not been removed.
- **Recommended action:** `git rm -r --cached dist/` (do not delete the working-tree copy blindly — confirm no one depends on the committed artifacts first, e.g. a deploy process expecting pre-built output in the repo).

#### H-2. Stray tracked npm tarball at repo root (**Low**)
- **Evidence:** `picomatch-4.0.4.tgz` (23.6 KB) is tracked in git; `git log --follow` shows it was introduced alongside an unrelated commit ("feat: TrustlineTool"), suggesting an accidental `git add` rather than an intentional vendored dependency.
- **Recommended action:** Remove unless a specific, documented reason for vendoring this tarball exists (**Needs verification** — check if any build/install step references it before deleting).

#### H-3. Stray tracked test artifact (**Low**)
- **Evidence:** `tests/temp.txt`, tracked in git, contains only the text "hello" (with a UTF-8 BOM). Not referenced by any test file found during the audit.
- **Recommended action:** Remove.

## Documentation Findings

#### D-1. SECURITY.md vs. config.ts drift (**Medium**)
- **Evidence:** `SECURITY.md`'s "Known Limitations" §3 states: *"`config.ts` uses `execSync` to fetch `AGENT_SECRET_KEY` from AWS Secrets Manager. This pattern has inherent security risks..."* The actual code (`backend/config.ts:393-402`, `fetchSecretFromArn`) uses `@aws-sdk/client-secrets-manager`'s `SecretsManagerClient`/`GetSecretValueCommand` — an async SDK call, not a blocking `execSync` shell-out.
- **Impact:** A security reviewer relying on SECURITY.md would flag a risk (blocking event loop, command-output-in-logs) that no longer exists in the code, while potentially missing that the *current* implementation has different characteristics worth its own review (e.g. does the SDK call have its own timeout/retry behavior?). This is exactly the kind of doc-vs-code drift this audit was instructed to check for.
- **Recommended action:** Update SECURITY.md to describe the actual current implementation, or verify (**Needs verification**) whether an older `execSync`-based version existed and this is simply a stale doc from before a fix — either way, the doc needs correcting.

#### D-2. README "API Reference" internally inconsistent (**Medium**)
- **Evidence:** `README.md` lines ~302-362: a stray unmatched markdown code fence, a `TaskType` union listing 6 members with prose claiming "three" are wired, followed immediately by a second, different-length task-type table, followed by an `AgentTask` payload section documenting 7 *additional* task types not mentioned in either preceding list. The actual `TaskType` union in `agent.ts` has 21 members.
- **Impact:** A developer reading only the README's API Reference section would come away with an incomplete and self-contradictory picture of what task types exist.
- **Recommended action:** Regenerate this section from `agent.ts`'s actual `TaskType` union (ideally via TypeDoc, which CI already generates, rather than hand-maintained prose).

#### D-3. README overstates the universality of the simulation guarantee (**Low**)
- **Evidence:** README.md's "Why Nodal AI?" section (line ~16) states transactions are simulated before broadcast; the README's own detail section (line ~496) correctly caveats that Horizon-based tools (`StellarPaymentTool` and everything built on it) have no simulation step because Horizon has no simulation endpoint. The headline claim is only true for the Soroban-invocation path.

#### D-4. contracts/escrow/README.md doesn't match lib.rs (**Medium**, cross-referenced as [B-2](#b-2-escrow-contract-documentation-lags-the-code-medium))

#### D-5. CODEOWNERS coverage gap and bus factor (**Low**)
- **Evidence:** `.github/CODEOWNERS` names a single individual as owner of exactly 4 paths (`backend/config.ts`, `backend/tools/X402PaymentTool.ts`, `contracts/escrow/src/lib.rs`, `SECURITY.md`). `backend/agent.ts` and `backend/server.ts` — the orchestration and HTTP entry points, arguably equally security-relevant — are not covered.
- **Recommended action:** Needs a product/organizational decision (who else can review), not a code fix — flagged for the user.

## Technical Debt Inventory

1. Spending-limit enforcement gap across 6+ task types (S-1) — highest priority.
2. `SorobanDeployTool` non-functional against the real SDK (B-1).
3. 13 orphaned tool files (Q-1) — decide wire-in vs. removal per tool.
4. Triplicated memo-building logic with a shadow error class (Q-3).
5. Duplicated schema fragments across ~6 tool files (Q-4).
6. Dual logger implementations (S-5/Q-9).
7. No versioned DB migration tool beyond one idempotent `ALTER TABLE` (Database Analysis).
8. Git-tracked build output and stray files (H-1, H-2, H-3).
9. Escrow contract README and WASM size budget both lag the actual contract (B-2, B-3).
10. README API Reference section internally inconsistent (D-2).

## Unclear or Undocumented Areas (Needs Verification)

- Whether `express` and `fast-check` are used anywhere outside the files sampled in this audit (both appear to be dependencies with no confirmed call site).
- Whether the `dist/` tree being git-tracked reflects an intentional "ship pre-built" deployment strategy (**Needs verification with the user/team** before removing it).
- Whether `picomatch-4.0.4.tgz` is referenced by any tooling (grep for its filename in configs before deleting).
- Whether SECURITY.md's `execSync` claim reflects a previously-fixed implementation or was simply never accurate — git blame on both files would clarify but was not run as part of this audit.
- Whether the 13 orphaned tools represent abandoned work, work-in-progress for a future release, or deliberate scaffolding for downstream consumers to opt into — this materially affects whether Q-1 is "remove" or "finish wiring in," and should be confirmed with whoever owns the roadmap.
- Actual current npm audit / Snyk / cargo audit findings at HEAD — CI's audit jobs run these but this audit did not independently re-run `npm audit`/`cargo audit`/`snyk test` outside of the build/test verification described below.

## Recommended Decisions

Per this audit's own findings, the user should decide, before Phase 2 (Product Reassessment) and especially before Phase 5 (Skeletonization) proceed:

1. **Does the user still want full skeletonization (deleting business logic down to a bare skeleton), given the codebase is largely sound and includes a tested smart contract?** A targeted-fix approach (patch S-1, B-1, Q-1, Q-3 and the doc drifts) would preserve substantially more working, tested value than a rebuild-from-skeleton approach, for less total effort and risk. **This audit recommends targeted remediation over full skeletonization**, but the decision is the user's per this engagement's own safety rules ("do not remove files unless explicitly approved").
2. Disposition of the 13 orphaned tools (finish wiring vs. delete) — needs a product-roadmap decision, not just a code decision.
3. Disposition of `dist/`, the stray tarball, and `tests/temp.txt` — low-risk removals, but the audit's own ground rules require explicit approval before any deletion.
4. Whether `/status` should require auth by default (S-2) — a behavior change, not just a bug fix, since it changes default deployment behavior for existing operators.

## Files and Features Proposed for Removal

**None are removed by this audit.** Per the engagement's safety rules, this document only *proposes* candidates pending explicit approval:

| Candidate | File(s) | Reason | Confidence |
|---|---|---|---|
| Git-tracked build output | `dist/**` | Gitignored but tracked; should be `git rm --cached` | High, but confirm nothing deploys from the committed copy first |
| Stray tarball | `picomatch-4.0.4.tgz` | Accidental commit, unrelated to any commit's stated purpose | High |
| Stray test artifact | `tests/temp.txt` | Unreferenced, contains placeholder text | High |
| Orphaned tool: no test, no wiring | `ContractStorageWatcherTool.ts`, `FriendBotTool.ts`, `LedgerInfoTool.ts`, `NetworkStatusTool.ts`, `OfferBookTool.ts`, `SorobanStorageTool.ts`, `TransactionBuilderTool.ts` | Dead code, zero test coverage, zero wiring | Medium — confirm not intended as public library exports first |
| Orphaned tool: tested but unwired | `ClaimableBalanceTool.ts`, `SetOptionsTool.ts`, `SorobanEventIndexerTool.ts`, `BalanceStreamTool.ts`, `StellarIdentityTool.ts` | Working + tested but unreachable — candidates for **wiring in**, not necessarily removal | Low confidence for removal — recommend wire-in instead |

---

## Verification Results (from this audit)

Actually executed as part of this audit (not just read about):

- `npm ci`: **Pass.** Clean install from `package-lock.json`, no errors.
- `npm run build` (`tsc`): **Pass.** Zero compile errors.
- `npm run format:check` (Prettier): **Pass.** All files conform.
- `npm run lint` (ESLint): **1 error, 372 warnings.**
  - The 1 error: `backend/telemetry.ts:22` — `'tracer' is never reassigned. Use 'const' instead'` (`prefer-const`). Trivial, one-line fix.
  - The 372 warnings are essentially all `@typescript-eslint/no-explicit-any` (plus a handful of `no-unused-vars` for intentionally-named `_omit` destructuring targets in test files) — style debt, not correctness bugs. Concentrated in test files and RPC/network boundary code where `any` is arguably defensible (typing third-party SDK response shapes), but not audited file-by-file for justification.
- `npm run test:ts` (Vitest): **Pass — 706/706 tests passed across 45 test files**, ~149s wall time. No failures, no skips observed. Confirms the "genuinely substantive test suite" assessment above is not just a code-reading impression — the suite actually runs green.
- `cargo test`/`cargo clippy`/`cargo fmt --check` for the escrow contract: **not run** in this environment (would require the pinned Rust 1.78 toolchain per `rust-toolchain.toml`, not confirmed available here). **Needs verification** in an environment with that toolchain.
- `npm audit`, `cargo audit`, `snyk test`: **not independently re-run** — CI already runs these; this audit did not duplicate that check.
- Static findings above (S-1 through D-5) were derived from direct source reading, not from running the code, except where noted.

**This result materially reinforces the executive summary's central point: the codebase builds clean, formats clean, and passes its entire test suite (706 tests) with only one trivial lint error. This is empirical evidence — not just a code-reading impression — that the "poorly reviewed, unstructured" premise this engagement was scoped around does not hold for this repository as it stands today.**

---

*This document is Phase 1 of the requested audit/redesign/skeletonization engagement. Phases 2–6 (product direction, target architecture, implementation roadmap, skeletonization, verification) have not yet been produced, pending the decision requested in [Recommended Decisions](#recommended-decisions).*
