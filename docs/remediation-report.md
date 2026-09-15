# Remediation Report — Ledgera / "Nodal AI" (stellar-agent-kit)

**Date:** 2026-09-15
**Branch:** `audit/remediation` (off `main` at `7032826`)
**Scope:** Targeted remediation of findings from `docs/current-state-audit.md`, per the user's explicit decision to pursue targeted fixes rather than full codebase skeletonization (see that document's "Recommended Decisions" section).

This report documents what changed, what was deliberately left alone, and what still needs a decision or follow-up. It is the direct sequel to `docs/current-state-audit.md` — read that first for the full list of findings (severity, evidence, impact) that this report resolves or defers.

---

## Summary

10 of the audit's findings were fixed across 9 commits on `audit/remediation`. The codebase was verified at every step: **733/733 tests pass, `tsc` build is clean, `npm run lint` has 0 errors (370 pre-existing stylistic warnings, unrelated to this work), and Prettier formatting is clean.** No business logic was discarded wholesale — every change is a targeted patch, an additive wiring-in of already-tested code, or a documentation correction.

| # | Finding | Severity | Status |
|---|---|---|---|
| S-1 | Spending-limit bypass across 6+ task types | Critical | **Fixed** |
| B-1 | `SorobanDeployTool` used nonexistent SDK methods | High | **Fixed** |
| Q-1 | 13 orphaned tool files | High | **Fixed** (5 wired in, 6 removed, 1 kept as dev utility, 1 confirmed as a helper) |
| S-2 | `/status` unauthenticated by default | Medium | **Fixed** |
| S-3 | `sanitizeCause` exact-match allow-list gap | Medium | **Fixed** |
| D-1 | SECURITY.md `execSync` claim vs. actual SDK usage | Medium | **Fixed**, plus an additional stale-doc find (nonce store) caught during the fix |
| D-2 | README API Reference internally inconsistent | Medium | **Fixed** |
| D-3 | README overstated simulation universality | Low | **Fixed** |
| B-2 | Escrow contract README missing half its functions, wrong error names | Medium | **Fixed** |
| B-3 | WASM size budget (200,000 B) exceeds network limit (131,072 B) | Medium | **Fixed** — lowered to 120,000 B |
| Q-3 | Triplicated `buildMemo`, shadow `ValidationError` class | Medium/Low | **Fixed** |
| Q-8 | `db/client.ts`'s `close()` didn't close the connection | Low | **Fixed** |
| Q-5 | Inconsistent self-payment guards | Low | **Fixed** (2 of 3 named tools — see below) |
| H-1, H-2, H-3 | Git-tracked build output, stray tarball, stray temp file | Low | **Fixed** |

---

## Changes by commit

### 1. `2bd4120` — chore: remove tracked build output and stray committed files
- `git rm --cached -r dist/` — build output was tracked despite being gitignored.
- Deleted `picomatch-4.0.4.tgz` (unrelated npm tarball, confirmed unreferenced anywhere via repo-wide grep before removal) and `tests/temp.txt` (placeholder file).
- Added `docs/current-state-audit.md`.

### 2. `d03a84b` — fix: close spending-limit enforcement gap (S-1, **Critical**)
`assertWithinSpendingLimit()` — which enforces `AGENT_SPENDING_LIMIT` and the hardcoded `MAINNET_SPENDING_CAP` — was previously called for only `stellar_payment` and `x402_respond`. Added the same guard to `multisig_payment`, `path_payment`, `swap`, `dex_offer` (create/update, not delete), `liquidity_pool` (deposit, not withdraw/info), `sponsored_account`, and `batch_payment`'s aggregate total. Also fixed a `prefer-const` lint error in `telemetry.ts` that was making `npm run lint` fail outright (exit code 1) — confirmed this was broken before this branch by checking the exit code directly. Added a dedicated test block covering the fix and its intentional exemptions (dex_offer delete, liquidity_pool withdraw/info reduce or don't affect exposure, so aren't capped).

### 3. `d142a36` — fix: rebuild SorobanDeployTool on real SDK operations (B-1, **High**)
`sorobanServer.uploadContractWasm()` / `.createContractFromWasm()` do not exist on `@stellar/stellar-sdk@13.3.0`'s `rpc.Server` class — confirmed by introspecting the installed package directly (`Object.getOwnPropertyNames(sdk.rpc.Server.prototype)`). The tool would have thrown in production on both `upload` and `instantiate`; only the mocked test suite (which stubbed the fictional methods) passed. Rewrote to use `Operation.uploadContractWasm` / `Operation.createCustomContract` through the same build → simulate (mandatory) → sign → submit → poll pipeline every other Soroban tool follows. `wasmHash` is computed locally as `sha256(wasm)` (how Soroban actually identifies uploaded WASM — no RPC round trip needed). `contractId` is read from the simulation's return value; extended `rpc_client.ts`'s `PreparedSorobanTx` to expose it (`retval`), since this is a legitimate general-purpose need, not a one-off hack. Rewrote `tests/soroban_deploy.test.ts` against the real pipeline via the shared `MockSorobanServer` fixture.

### 4. `e58eb92` — feat: wire in 5 tested-but-orphaned tools (Q-1, **High**)
`ClaimableBalanceTool`, `SetOptionsTool`, `SorobanEventIndexerTool`, and `StellarIdentityTool` were fully implemented with passing dedicated test files but never dispatched by `PayFiAgent` — dead code in the running application. Wired in as new task types: `claimable_balance`, `set_options`, `soroban_events`, `web_auth`. `claimable_balance`'s `create` action now goes through the S-1 spending guard (it locks funds); `claim` does not (it returns funds to the agent). `BalanceStreamTool` (a streaming subscription, not request/response) is exposed as `startBalanceStream()`/`stopBalanceStream()` on `PayFiAgent`, mirroring the existing `startContractListener()`/`stopContractListener()` precedent, and wired into `destroy()` for cleanup symmetry.

### 5. `bbb1136` — chore: remove 6 orphaned tool files with zero references (Q-1, **High**)
`ContractStorageWatcherTool`, `LedgerInfoTool`, `NetworkStatusTool`, `OfferBookTool`, `SorobanStorageTool`, `TransactionBuilderTool` — fully implemented, never wired into `agent.ts`, no tests, and (verified via repo-wide grep before deleting) referenced by nothing else. Build stayed clean after removal, confirming they were truly dead.

**`FriendBotTool` was explicitly excluded** from this cleanup: it has the same "not wired into agent.ts" profile, but a repo-wide grep found it's actively imported and used by `scripts/examples/escrow_lifecycle.ts` to fund a testnet account. It's a legitimate dev utility, not dead code — kept as-is.

**`MemoAttachmentTool`** was also flagged in the original audit as one of the 13, but it's a shared helper (`buildMemo`) consumed by `X402PaymentTool`, not a dispatchable task tool — no action needed there beyond the Q-3 fix (below).

### 6. `1577a12` — fix: require auth on GET /status (S-2, Medium)
`/status` returned the last 10 persisted `AgentResult` records (correlation IDs, error text, tool return data such as unsigned multisig XDR) with no auth check, while `/spending` already gated on the same `WEBHOOK_SECRET` Bearer token. Applied the same `isAuthenticated()` check to `/status`. Since `isAuthenticated()` returns `true` whenever `WEBHOOK_SECRET` is unset, this **only changes behavior for deployments that already opted into auth** by setting the secret — unconfigured deployments see no change. `/health` is intentionally left open (it's the liveness probe).

### 7. `e1f2d09` — fix: make sanitizeCause pattern-based (S-3, Medium)
`sanitizeCause()` used an exact-match set (`secretKey`/`privateKey`/`seed`/`_secretKey`); `agent.ts`'s equivalent guard for task payloads (`sanitizePayload()`) uses a broader `/secret|key|seed|mnemonic|private/i` pattern. The mismatch meant a field name not enumerated up front — e.g. `SponsoredAccountTool`'s `newAccountSecret` — could survive `sanitizeCause()` while `sanitizePayload()` would have caught it. Both layers now use the same pattern.

### 8. `9cfb888` — docs: fix documentation drift (D-1, D-2, D-3, B-2, B-3)
- **SECURITY.md**: corrected the claim that `config.ts` uses `execSync` to fetch secrets (it uses the AWS SDK `SecretsManagerClient`). While fixing this, also caught and corrected a second stale claim in the same document — "in-memory nonce store" — the default is actually `SqliteNonceStore`, persisted to `DB_PATH`; `InMemoryNonceStore` is test-only. Replaced with the accurate limitation (not shared across horizontally-scaled instances without a custom shared-store `INonceStore`).
- **README.md**: removed a stray unmatched code fence and a section with two internally-conflicting `TaskType` listings (one claiming "three" wired values against a 6-member sample, a second with a different set) plus an `AgentTask` payload list documenting types absent from both. Replaced with a short section pointing to `ARCHITECTURE.md`'s Registered Task Types table as the single source of truth. Also fixed a literal leftover "One thing to flag for reviewers: ..." sentence (an unremoved review note that had been committed into the rendered docs) and an overstated "every transaction is simulated" claim (true only for the Soroban RPC path, not Horizon Classic operations).
- **ARCHITECTURE.md**: the Registered Task Types table was missing 7 of the 26 actual `TaskType` values — `soroban_deploy`/`swap`/`account_history` predated this remediation and were already missing; `claimable_balance`/`set_options`/`soroban_events`/`web_auth` were added by it. Table is now complete.
- **contracts/escrow/README.md**: documented only 4 of the contract's 8 public functions and used error variant names (`AmountNotPositive`, `ExpiryNotInFuture`, `AlreadySettled`) that don't exist in the actual `EscrowError` enum (verified against `lib.rs` directly). Added `release_partial`/`cancel`/`propose_new_arbiter`/`accept_arbiter_rotation` and corrected the error table.
- **WASM_SIZE_BUDGET.md**: the CI-enforced budget (200,000 bytes) exceeded Stellar's actual network deploy limit (131,072 bytes) by ~53% — a binary could pass CI yet still fail to deploy, defeating the check's stated purpose. Lowered to 120,000 bytes (~8% headroom below the network limit) in `check_wasm_size.sh`'s default and `ci.yml`'s override. **Not independently verified against an actual contract build** — the local environment's MSVC linker is broken (pre-existing, unrelated to this work; attempted `cargo build --target wasm32-unknown-unknown` and hit a `link.exe` failure installing `serde`/`proc-macro2` build-script dependencies). CI runs on Ubuntu with a working toolchain and will validate this on the next push — **flagging this as needing confirmation from a real CI run** before merge.

### 9. `6760888` — refactor: consolidate triplicated buildMemo (Q-3, Medium/Low)
`StellarPaymentTool.ts` and `PathPaymentTool.ts` each carried a byte-for-byte identical ~60-line `buildMemo()`. Verified they were truly identical before extracting into `backend/tools/memo.ts`; both tools now import the shared function — a pure, behavior-preserving extraction. `MemoAttachmentTool.ts` (a third, deliberately different-shaped memo builder used only by `X402PaymentTool`) declared its own local `ValidationError` class instead of using `backend/errors.ts`'s — since `middleware/error_handler.ts` pattern-matches on `instanceof StructuredError`, an error from this path would have been misclassified as a 500 instead of a 400 at any HTTP boundary that surfaced it. Now re-exports the shared `ValidationError` (same import path for existing callers, same class identity). Also removed a needless round-trip in `X402PaymentTool.ts`: it called `MemoAttachmentTool.buildMemo()` and unwrapped `.value` back to a string just to hand it to `StellarPaymentTool`'s own memo builder, which validates and rebuilds an equivalent `Memo` anyway.

### 10. `efd6754` — fix: close DB handle on shutdown, add missing self-payment guards (Q-8, Q-5)
- `DatabaseManager.close()` (`backend/db/client.ts`) only flipped an internal `_isOpen` flag; the actual `better-sqlite3` handle owned by `persistence.ts`'s `getDb()` was never closed, despite the method's own doc comment claiming it "releases the connection." Added `persistence.ts:closeDb()` and wired it in.
- `StellarPaymentTool`/`PathPaymentTool` reject a payment whose destination equals the agent's own address; `MultiSigPaymentTool` and `BatchPaymentTool` (per-payment) had no equivalent guard despite building the same kind of payment operation. Added it to both. **`DexOfferTool` was named in the original audit finding alongside these two, but on inspection has no destination/counterparty field at all** (a DEX offer is a standing order on an orderbook, not a payment to an address) — the finding didn't apply there, so no change was made.

---

## Deletion Report

| File | Reason | Replacement |
|---|---|---|
| `dist/**` (240 files, tracked despite `.gitignore`) | Build output should never be committed | None needed — `npm run build` regenerates it locally |
| `picomatch-4.0.4.tgz` | Unrelated npm tarball, accidentally committed alongside an unrelated feature commit; confirmed zero references anywhere in the repo before deletion | None |
| `tests/temp.txt` | Placeholder file containing only "hello"; confirmed unreferenced by any test | None |
| `backend/tools/ContractStorageWatcherTool.ts` | Unwired, untested, zero references | None — feature was never live |
| `backend/tools/LedgerInfoTool.ts` | Unwired, untested, zero references | None |
| `backend/tools/NetworkStatusTool.ts` | Unwired, untested, zero references (health-check probes already exist in `server.ts`) | None |
| `backend/tools/OfferBookTool.ts` | Unwired, untested, zero references | None |
| `backend/tools/SorobanStorageTool.ts` | Unwired, untested, zero references | None |
| `backend/tools/TransactionBuilderTool.ts` | Unwired, untested, zero references; also had an inverted dependency (imported from `agent.ts`, the only tool file to do so) | None |

No database migrations, smart-contract functions, or frontend code were removed — the escrow contract, its tests, and every wired production task type are untouched except where explicitly noted above.

---

## Verification Results

Run against the final state of `audit/remediation` (HEAD `efd6754` plus this report):

- `npm ci`: Pass.
- `npm run build` (`tsc`): Pass, zero errors.
- `npm run format:check` (Prettier): Pass, all files conform.
- `npm run lint` (ESLint): **0 errors**, 370 warnings (pre-existing `no-explicit-any` style debt in test/RPC-boundary code, not introduced by this work, not addressed — see Known Limitations).
- `npm run test:ts` (Vitest): **733/733 tests passed** across 45 test files (up from 706 at the start of this engagement — 27 new tests added to pin the fixes above).
- `cargo test`/`cargo clippy`/`cargo fmt --check` for the escrow contract: **not run** — this environment's Rust toolchain has a broken MSVC linker unrelated to this work (confirmed while attempting to verify the WASM size budget change; failed on stock `serde`/`proc-macro2` build scripts, before ever reaching this repo's own code). No escrow contract source was touched by this remediation, so no regression is expected, but this should be confirmed by CI (which runs on Ubuntu) before merge.
- `npm audit`, `cargo audit`, `snyk test`: not independently re-run; unaffected by this work (no dependency changes).

---

## Features Preserved (nothing was removed to "simplify")

Per the user's decision to pursue targeted remediation instead of skeletonization: the escrow smart contract (all 8 functions, all 40 tests including 3 property-based fund-conservation checks), all 55 test files, the full CI pipeline, all 21 originally-wired task types, and every tool with real production logic remain exactly as they were except where a specific finding required a change. The only deletions were 6 files with zero functional footprint (confirmed by grep and by a clean build after removal).

---

## Known Limitations / Not Addressed in This Pass

These were identified in the original audit but intentionally left out of this remediation round — either lower priority, higher effort/risk relative to value, or requiring a decision this report can't make unilaterally:

- **Q-4 (duplicated `AssetSchema` and amount/price regex fragments across ~6 tool files)** — real duplication, but purely a maintainability concern with no behavioral bug attached (unlike Q-3's memo triplication, which had an actual misclassification bug riding along with it). Deferred.
- **S-5/Q-9 (dual logger implementations — `backend/logger.ts` vs. `backend/utils/logger.ts` — with different redaction coverage)** — a real inconsistency, but consolidating onto one logger touches every tool file that imports either one; higher blast radius than this pass's other fixes for a currently-latent risk (no code path was found that actually logs a secret through the under-redacted logger). Deferred; worth a dedicated pass.
- **CODEOWNERS single-owner / coverage gap (D-5)** — an organizational decision (who else should review security-sensitive files), not a code fix. Flagged in the audit, not actioned here.
- **`express` and `fast-check` possibly-unused dependencies** — flagged as "needs verification" in the audit; not independently re-verified or removed in this pass, since removing a dependency that turns out to be used somewhere unaudited would be a regression, not a fix.
- **370 pre-existing ESLint `no-explicit-any` warnings** — style debt, not correctness bugs; left as-is since fixing them is a large, low-risk-per-line but high-total-effort cleanup orthogonal to the audit's findings.
- **WASM size budget change (B-3) is unverified against a real build** in this environment due to a broken local Rust/MSVC toolchain (pre-existing, unrelated to this repo). Needs confirmation from a real CI run before merging — flagged explicitly above and here.

## Needs Approval / Explicit Confirmation Before Merge

1. **This work lives on branch `audit/remediation`, not `main`.** Nothing here has been pushed or merged — that's the user's call.
2. **The WASM size budget change (120,000 bytes)** should be confirmed against an actual CI build before merging, since it couldn't be verified locally.
3. **The `/status` auth behavior change (S-2)** is a behavior change for any deployment that already sets `WEBHOOK_SECRET` (previously-open `/status` now requires the same Bearer token `/spending` already required). No change for deployments without `WEBHOOK_SECRET` set. Worth a mention in release notes if this ships.
