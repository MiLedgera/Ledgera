# =============================================================================
# Ledgera — Multi-stage Dockerfile
#
# Stages:
#   1. rust-builder   — compiles Soroban contract → .wasm
#   2. node-builder   — installs deps + compiles TypeScript → dist/
#   3. prod-deps      — installs production-only node_modules on Alpine/musl
#   4. production     — node:20-alpine runtime with compiled artefacts only
# =============================================================================

# ─── Stage 1: Soroban / Rust contract build ───────────────────────────────────
FROM rust:1.78-slim AS rust-builder

# Install wasm32 target + soroban-cli (used for optional post-build optimisation)
RUN rustup target add wasm32-unknown-unknown && \
    apt-get update && \
    apt-get install -y --no-install-recommends \
        pkg-config \
        libssl-dev \
        binaryen \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /build

# ── Cache layer: copy manifests first so cargo fetch is only re-run on
#    Cargo.toml / Cargo.lock changes, not on every source edit ──────────────────
COPY contracts/escrow/Cargo.toml ./contracts/escrow/Cargo.toml

# Create a stub lib.rs so `cargo build` can resolve the crate without full source
RUN mkdir -p contracts/escrow/src && \
    echo '#![no_std] soroban_sdk::contractimpl!(struct S;);' > contracts/escrow/src/lib.rs || \
    printf '#![no_std]\n' > contracts/escrow/src/lib.rs

# Pre-fetch dependencies (cached unless Cargo.toml changes)
RUN cargo fetch --manifest-path contracts/escrow/Cargo.toml

# ── Full source copy + release build ──────────────────────────────────────────
COPY contracts/escrow/src ./contracts/escrow/src

RUN cargo build \
        --manifest-path contracts/escrow/Cargo.toml \
        --target wasm32-unknown-unknown \
        --release && \
    # Optional: shrink WASM with wasm-opt (installed via binaryen above)
    wasm-opt -Oz \
        contracts/escrow/target/wasm32-unknown-unknown/release/stellar_payfi_escrow.wasm \
        -o contracts/escrow/target/wasm32-unknown-unknown/release/stellar_payfi_escrow.wasm \
    || echo "wasm-opt not available, skipping optimisation"

# ─── Stage 2: Node.js / TypeScript build ──────────────────────────────────────
FROM node:20-slim AS node-builder

WORKDIR /build

# ── Cache layer: copy manifests before source ─────────────────────────────────
COPY package.json package-lock.json* ./

# Install ALL deps (including devDeps — we need tsc)
RUN npm ci --ignore-scripts

# ── Full source copy + compile ────────────────────────────────────────────────
COPY tsconfig.json ./
COPY backend/ ./backend/

RUN npm run build

# ─── Stage 3: Production dependencies (Alpine / musl) ─────────────────────────
# Installed on the same musl base as the final image so native modules
# (e.g. better-sqlite3) resolve/link correctly; kept out of the final stage
# so no compiler toolchain ships in the production image.
FROM node:20-alpine AS prod-deps

WORKDIR /build

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --ignore-scripts && \
    npm cache clean --force

# ─── Stage 4: Production image ────────────────────────────────────────────────
FROM node:20-alpine AS production

LABEL org.opencontainers.image.title="Ledgera Agent"
LABEL org.opencontainers.image.description="Stellar PayFi Agent Kit"

# Non-root user for security (Alpine/busybox adduser syntax)
RUN addgroup -S agent && adduser -S -G agent agent

WORKDIR /app

# ── Runtime deps only — pre-built in prod-deps, nothing compiled here ────────
COPY --from=prod-deps /build/node_modules ./node_modules

# ── Compiled TypeScript ───────────────────────────────────────────────────────
COPY --from=node-builder /build/dist ./dist

# ── Compiled WASM contract ────────────────────────────────────────────────────
COPY --from=rust-builder \
    /build/contracts/escrow/target/wasm32-unknown-unknown/release/stellar_payfi_escrow.wasm \
    ./contracts/escrow/stellar_payfi_escrow.wasm

# Ensure compiled output is readable by the non-root user
RUN chown -R agent:agent /app

# Drop to non-root
USER agent

# Expose default port (override via env)
EXPOSE 3000

# Health check — verify configuration and startup logic compiles/resolves
HEALTHCHECK --interval=30s --timeout=10s --retries=3 \
    CMD node -e "require('./dist/backend/config')" || exit 1

# Entry point
CMD ["node", "dist/backend/agent.js"]
