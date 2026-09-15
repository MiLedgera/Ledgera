#!/usr/bin/env bash
#
# check_wasm_size.sh — fail if a compiled Soroban contract WASM exceeds a
# size budget.
#
# Motivation: supply-chain attacks sometimes inflate WASM binaries by
# injecting large data segments. A size budget catches that bloat before the
# artifact is deployed, even when the binary still loads correctly.
#
# Usage:
#   check_wasm_size.sh [WASM_PATH] [MAX_BYTES]
#
# Defaults:
#   WASM_PATH  contracts/escrow/target/wasm32-unknown-unknown/release/stellar_payfi_escrow.wasm
#   MAX_BYTES  120000 (see contracts/escrow/WASM_SIZE_BUDGET.md — kept below
#              Stellar's 131,072-byte network deploy limit, unlike the prior
#              200,000 default), or $MAX_WASM_SIZE_BYTES if set
#
# Exit codes:
#   0  WASM is present, valid, and within budget
#   1  WASM is missing, not a valid WASM binary, or over budget

set -euo pipefail

WASM_PATH="${1:-contracts/escrow/target/wasm32-unknown-unknown/release/stellar_payfi_escrow.wasm}"
MAX_BYTES="${2:-${MAX_WASM_SIZE_BYTES:-120000}}"

if [[ ! -f "${WASM_PATH}" ]]; then
  echo "ERROR: WASM not found at ${WASM_PATH}" >&2
  echo "Run the release build first:" >&2
  echo "  cargo build --manifest-path contracts/escrow/Cargo.toml --target wasm32-unknown-unknown --release" >&2
  exit 1
fi

# Sanity check: every WASM binary starts with the magic bytes \0asm.
if ! head -c 4 "${WASM_PATH}" | od -An -tx1 | grep -q "00 61 73 6d"; then
  echo "ERROR: ${WASM_PATH} is not a valid WASM binary (bad magic bytes)" >&2
  exit 1
fi

# GNU stat (Linux CI) reports the byte size via -c %s; fall back to wc -c
# for BSD stat (macOS) or other environments.
if command -v stat >/dev/null 2>&1 && stat --version >/dev/null 2>&1; then
  SIZE_BYTES=$(stat -c %s "${WASM_PATH}")
else
  SIZE_BYTES=$(wc -c < "${WASM_PATH}" | tr -d ' ')
fi
SIZE_KIB=$(awk "BEGIN { printf \"%.2f\", ${SIZE_BYTES} / 1024 }")
MAX_KIB=$(awk "BEGIN { printf \"%.2f\", ${MAX_BYTES} / 1024 }")

if (( SIZE_BYTES > MAX_BYTES )); then
  echo "ERROR: WASM size ${SIZE_BYTES} bytes (${SIZE_KIB} KiB) exceeds the budget of ${MAX_BYTES} bytes (${MAX_KIB} KiB)" >&2
  echo "Possible supply-chain bloat. Inspect the binary, then raise MAX_WASM_SIZE_BYTES only if the growth is legitimate." >&2
  exit 1
fi

echo "OK: WASM size ${SIZE_BYTES} bytes (${SIZE_KIB} KiB) is within the budget of ${MAX_BYTES} bytes (${MAX_KIB} KiB)"
