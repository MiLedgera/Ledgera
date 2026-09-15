# WASM Size Budget

The escrow contract compiles to a WebAssembly binary
(`target/wasm32-unknown-unknown/release/stellar_payfi_escrow.wasm`). CI enforces a
size budget on that artifact to detect **supply-chain bloat** before deployment:
a compromised dependency or build step can silently inflate a WASM binary by
injecting large data segments, and the binary would still load and run normally.

## Current Budget

| Setting | Value |
| :--- | :--- |
| Budget | **120,000 bytes** (~117 KiB) |
| Where enforced | `.github/workflows/ci.yml` → `wasm-size-check` job |
| Check script | `scripts/check_wasm_size.sh` |
| Override | `MAX_WASM_SIZE_BYTES` environment variable |

## Why 120,000 bytes?

- **It must stay below Stellar's network deploy limit.** The budget's whole
  purpose is to catch bloat "before deployment" — a budget looser than the
  network's own hard limit (131,072 bytes, see below) fails to do that: a
  binary could pass this check yet still be rejected at deploy time. A
  previous version of this document set the budget to 200,000 bytes, which
  exceeded the network limit and defeated the check's stated purpose.
  120,000 keeps roughly 8% headroom below the 131,072-byte ceiling.
- The escrow contract is small; a legitimate release build is expected to be
  far below this threshold, so the budget does not constrain normal
  development.
- The budget is deliberately **explicit and adjustable**: when the contract
  legitimately grows, raise `MAX_WASM_SIZE_BYTES` in CI as part of the change
  that grew it — never silently, and never above the network limit below.

## How the check works

1. CI builds the contract: `cargo build --manifest-path contracts/escrow/Cargo.toml --target wasm32-unknown-unknown --release`
2. `scripts/check_wasm_size.sh` verifies the output is a valid WASM binary
   (magic bytes `\0asm`), reads its size in bytes with `stat`, and exits non-zero
   if the size exceeds the budget.
3. The GitHub Actions job fails, blocking merge until the bloat is investigated.

## Related context

- Stellar's current network hard limit for deployable contract WASM is
  **128 KiB (131,072 bytes)**. Keep the deployed artifact below that limit
  regardless of this budget.
- Run the check locally with:
  ```bash
  cargo build --manifest-path contracts/escrow/Cargo.toml --target wasm32-unknown-unknown --release
  npm run check:wasm-size
  ```
