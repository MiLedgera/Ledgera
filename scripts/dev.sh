#!/usr/bin/env bash
# =============================================================================
# scripts/dev.sh — Ledgera unified stack runner
#
# Usage:
#   ./scripts/dev.sh up                     # build + start full stack
#   ./scripts/dev.sh down                   # stop and remove containers
#   ./scripts/dev.sh test                   # start stack + run integration tests
#   ./scripts/dev.sh test:rust              # run Soroban contract tests locally
#   ./scripts/dev.sh logs                   # tail all service logs
#   ./scripts/dev.sh clean                  # remove containers, volumes, and images
#   ./scripts/dev.sh --dry-run              # check environment variables and exit
#
# Flags (must appear before the command):
#   --skip-validation   Skip required env var checks (for CI environments that
#                       inject secrets at runtime rather than via .env files).
#                       Example: ./scripts/dev.sh --skip-validation up
# =============================================================================

set -euo pipefail

COMPOSE="docker compose"
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

cd "$PROJECT_ROOT"

# ── Flag parsing ──────────────────────────────────────────────────────────────

SKIP_VALIDATION=false

# Consume --skip-validation before the subcommand so the dispatch case block
# only ever sees the bare command word.
if [[ "${1:-}" == "--skip-validation" ]]; then
  SKIP_VALIDATION=true
  shift
fi

# ── Helpers ───────────────────────────────────────────────────────────────────

log()  { echo "▶  $*"; }
warn() { echo "⚠️  $*" >&2; }
die()  { echo "❌ $*" >&2; exit 1; }

# Required environment variables and a short hint for each.
# Format: "VAR_NAME|hint message shown when the variable is missing"
declare -a REQUIRED_VARS=(
  "AGENT_SECRET_KEY|Stellar secret key for signing transactions (starts with S, 56 chars). See .env.example."
  "HORIZON_URL|Horizon REST API endpoint (e.g. https://horizon-testnet.stellar.org). See .env.example."
  "SOROBAN_RPC_URL|Soroban RPC endpoint (e.g. https://soroban-testnet.stellar.org). See .env.example."
  "X402_ASSET_ISSUER|Issuing account for the x402 payment asset (56-char G-address). See .env.example."
)

check_env() {
  local had_error=false

  for entry in "${REQUIRED_VARS[@]}"; do
    local var_name hint
    var_name="${entry%%|*}"
    hint="${entry##*|}"

    if [[ -z "${!var_name:-}" ]]; then
      echo "❌ Missing required environment variable: ${var_name}" >&2
      echo "   Hint: ${hint}" >&2
      echo "" >&2
      had_error=true
    fi
  done

  if [[ "$had_error" == "true" ]]; then
    echo "Fix the above variables in your .env file (copy .env.example for a template) or" >&2
    echo "export them in your shell before running this script." >&2
    echo "To bypass validation in CI environments use: --skip-validation" >&2
    exit 1
  fi

  log "All required environment variables are set."
}

require_env() {
  if [[ "$SKIP_VALIDATION" == "true" ]]; then
    warn "--skip-validation active: skipping environment variable checks."
    return 0
  fi

  [[ -f .env ]] || die ".env file not found. Copy .env.example to .env and fill in your values."
  # shellcheck disable=SC1091
  set -a; source .env; set +a
  check_env
}

# ── Commands ──────────────────────────────────────────────────────────────────

cmd_dry_run() {
  require_env
  log "Environment check passed!"
  exit 0
}

cmd_up() {
  require_env
  log "Building and starting Ledgera stack..."
  $COMPOSE up --build -d
  log "Stack is running."
  log "  Horizon    : http://localhost:8000"
  log "  Soroban    : http://localhost:8001"
  log "  Agent      : http://localhost:3000"
  $COMPOSE logs -f
}

cmd_down() {
  log "Stopping stack..."
  $COMPOSE down
}

cmd_test() {
  require_env
  log "Starting stack + running integration tests..."
  $COMPOSE --profile test up --build --abort-on-container-exit --exit-code-from test-runner
}

cmd_test_rust() {
  log "Running Soroban contract tests (local Rust toolchain)..."
  cargo test --manifest-path contracts/escrow/Cargo.toml -- --nocapture
}

cmd_logs() {
  $COMPOSE logs -f
}

cmd_clean() {
  warn "This will remove all containers, volumes, and built images for this project."
  read -r -p "Continue? [y/N] " confirm
  [[ "$confirm" =~ ^[Yy]$ ]] || { log "Aborted."; exit 0; }
  $COMPOSE down --volumes --rmi local
  log "Clean complete."
}

# ── Dispatch ──────────────────────────────────────────────────────────────────

case "${1:-up}" in
  --dry-run)  cmd_dry_run    ;;
  up)         cmd_up         ;;
  down)       cmd_down       ;;
  test)       cmd_test       ;;
  test:rust)  cmd_test_rust  ;;
  logs)       cmd_logs       ;;
  clean)      cmd_clean      ;;
  *)          die "Unknown command: ${1}. Use: [--skip-validation] --dry-run | up | down | test | test:rust | logs | clean" ;;
esac
