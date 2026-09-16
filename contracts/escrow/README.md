# Stellar PayFi Escrow Contract

A production-grade, secure, and gas-efficient Soroban (Stellar) escrow smart contract designed for PayFi operations. The contract enforces state transitions, multi-party authorization, and time-locked balances.

---

## Storage Layout

The contract stores its state in the persistent instance storage using the `DataKey` enum structure:

| Key (`DataKey`) | Value Type | Description |
| :--- | :--- | :--- |
| `Depositor` | `Address` | The account that funds the escrow and is eligible for refunds after expiration. |
| `Recipient` | `Address` | The destination account that receives the locked funds upon successful release. |
| `Arbiter` | `Address` | The trusted third-party key responsible for authorising the release of funds. |
| `Token` | `Address` | The contract address of the Stellar Asset Contract (SAC) token being held. |
| `Amount` | `i128` | The amount of token locked (in stroop-equivalent decimal units). |
| `Expiry` | `u64` | The Unix timestamp (seconds) after which a refund can be executed by the depositor. |
| `Released` | `bool` | A boolean flag indicating if the escrow has been settled (released or refunded). |

---

## Lifecycle State Machine

The contract transitions through three lifecycle states:

```
    [ Uninitialized ]
           │
           │  initialize() (locks tokens)
           ▼
       [ Active ]
         ╱    ╲
        ╱      ╲  refund() (depositor, if current_time >= expiry)
       ╱        ╲
      ╱          ▼
     │       [ Settled ] (tokens returned to depositor)
     │
     │  release() (arbiter)
     ▼
 [ Settled ] (tokens sent to recipient)
```

1. **`Uninitialized`**: The contract has no active state. The `DataKey::Depositor` does not exist in instance storage.
2. **`Active`**: The contract has been initialized. Funds are held in the contract account. `DataKey::Released` is `false`.
3. **`Settled`**: The contract has been successfully resolved. Funds are transferred out, and `DataKey::Released` is updated to `true`.

---

## Public Functions & Authentication Requirements

All public entry points are defined on the `EscrowContract` struct:

### `initialize(env: Env, depositor: Address, recipient: Address, arbiter: Address, token: Address, amount: i128, expiry: u64)`
- **Purpose**: Initialises state, asserts constraints, and pulls tokens from the depositor to lock them in the contract.
- **Authorization**: Requires depositor signature (`depositor.require_auth()`).
- **Validation**:
  - `amount` must be greater than zero.
  - `expiry` timestamp must be strictly in the future.

### `release(env: Env, arbiter: Address)`
- **Purpose**: Settles the escrow by transferring locked funds to the recipient.
- **Authorization**: Requires arbiter signature (`arbiter.require_auth()`).
- **Validation**:
  - Only the registered arbiter can execute.
  - Escrow must be in the `Active` state (not yet released or refunded).

### `refund(env: Env, depositor: Address)`
- **Purpose**: Reclaims locked funds back to the depositor if the expiration time has elapsed.
- **Authorization**: Requires depositor signature (`depositor.require_auth()`).
- **Validation**:
  - Only the registered depositor can execute.
  - Escrow must be in the `Active` state.
  - Current ledger time must be greater than or equal to `expiry`.

### `get_state(env: Env) -> EscrowState`
- **Purpose**: Reads and returns the current lifecycle state of the escrow (`Uninitialized`, `Active`, or `Settled`).
- **Authorization**: None (Read-only query).

### `release_partial(env: Env, arbiter: Address, release_amount: i128)`
- **Purpose**: Releases part of the locked amount to the recipient, enabling milestone-based PayFi contracts (e.g. 50% on delivery, 50% on acceptance). The escrow stays `Active` (`Released = false`) until the stored amount reaches 0, at which point it seals to `Settled`.
- **Authorization**: Requires arbiter signature (`arbiter.require_auth()`), checked against the stored arbiter (not the `arbiter` parameter — see the TOCTOU note below).
- **Validation**:
  - Only the registered arbiter can execute.
  - Escrow must not already be fully released.
  - `release_amount` must be positive and must not exceed the remaining stored amount.

### `cancel(env: Env, depositor: Address, arbiter: Address)`
- **Purpose**: Cancels the escrow before expiry and refunds the full remaining amount to the depositor — a mutual-consent early exit, as opposed to `refund()` which only works after expiry.
- **Authorization**: Requires **both** depositor and arbiter signatures (dual-authorization; neither party can cancel unilaterally).
- **Validation**:
  - Both `depositor` and `arbiter` must match the stored addresses.
  - Escrow must not already be fully released.

### `propose_new_arbiter(env: Env, depositor: Address, new_arbiter: Address)`
- **Purpose**: Begins a time-locked arbiter rotation. Stores `new_arbiter` as pending along with the current timestamp; takes effect only after `accept_arbiter_rotation()` is called once `MIN_ROTATION_DELAY` (24 hours) has elapsed.
- **Authorization**: Requires depositor signature (`depositor.require_auth()`).
- **Validation**:
  - Only the registered depositor can propose a rotation.
  - Escrow must be initialized.

### `accept_arbiter_rotation(env: Env)`
- **Purpose**: Finalizes a pending arbiter rotation once the time lock has elapsed, replacing the stored arbiter with the pending one.
- **Authorization**: **None** — callable by anyone once `MIN_ROTATION_DELAY` has passed since `propose_new_arbiter()`. This is intentional: finalization is a no-trust-required state transition (the new arbiter was already committed to storage by the depositor; this call only applies a matured, tamper-proof timer), not an action that moves funds or grants new authority to the caller.
- **Validation**:
  - A rotation must be pending (`propose_new_arbiter()` was called and not yet accepted).
  - The 24-hour lock (`MIN_ROTATION_DELAY`) must have elapsed, computed via checked addition so it cannot be bypassed by timestamp overflow.

---

## EscrowError Reference

If an execution condition is violated, the contract panics with one of the following custom `EscrowError` variants:

| Code | Variant | Description |
| :--- | :--- | :--- |
| `1` | `AlreadyInitialized` | Escrow state has already been initialized. |
| `2` | `AlreadyReleased` | Escrow is already fully settled (released, refunded, or cancelled). |
| `3` | `NotExpired` | Attempted refund before the expiration timestamp. |
| `4` | `NotArbiter` | The calling address is not the stored arbiter. |
| `5` | `NotDepositor` | The calling address is not the stored depositor. |
| `6` | `InvalidAmount` | Amount (or `release_partial`'s `release_amount`) is not positive, or exceeds the remaining stored amount. |
| `7` | `InvalidExpiry` | Expiry timestamp must be greater than the current ledger timestamp. |
| `8` | `NotInitialized` | Called before `initialize()`, or the depositor key is missing from storage. |
| `9` | `InvalidParties` | Depositor, recipient, and arbiter are not all pairwise distinct. |
| `10` | `RotationLocked` | `accept_arbiter_rotation()` called before `MIN_ROTATION_DELAY` (24h) has elapsed since the proposal. |
| `11` | `NoPendingRotation` | `accept_arbiter_rotation()` called with no prior `propose_new_arbiter()` call. |

---

## Event Emissions & Confidentiality Audit

Soroban emits contract events as **public on-chain data**. Every event is readable by any observer via `getEvents`, and the *topics* are the indexed, independently-filterable portion of an event. Because of this, an event that places private information in its topics constitutes an information disclosure. The following is a targeted audit of every `env.events().publish` emission in `lib.rs` (as of this audit):

| Function | Topic(s) | Data payload | Private data in topics? |
| :--- | :--- | :--- | :--- |
| `initialize` | `escrow`, `initialized` | `depositor`, `recipient`, `amount` | No |
| `release` | `escrow`, `released` | `recipient`, `amount` | No |
| `refund` | `refunded` | `depositor`, `amount` | No |
| `release_partial` | `partial_released` / `released` | `recipient`, `release_amount`, `remaining` | No |
| `cancel` | `escrow`, `cancelled` | `depositor`, `amount` | No |
| `propose_new_arbiter` | `arbiter_rotation_proposed` | `depositor`, `new_arbiter`, `now` | No |
| `accept_arbiter_rotation` | `arbiter_rotation_accepted` | `new_arbiter`, `now` | No |

### Audit conclusion: **No information disclosure found**

1. **Topics carry only fixed event-name literals.** Every topic is a hardcoded `Symbol::new(&env, "...")` (e.g. `escrow`, `released`, `refunded`) used solely for event *type* classification. No caller-supplied or user-controlled value ever appears in a topic, and no private metadata (memos, off-chain references, PII) exists in contract storage to leak.
2. **All data-payload values are already public on-chain state.** The payloads contain only addresses (`depositor`, `recipient`, `arbiter`, `new_arbiter`) and amounts/timestamps, each already disclosed by the public `get_state()` read function and ledger timestamps. Emitting them in events therefore reveals nothing that any on-chain observer could not already read directly.

**Guidance for future changes:** keep topics restricted to static event-type symbols. If a data point is considered sensitive, exclude it from the emitted payload rather than from storage, and remember that event *data* — not just topics — is public to all observers.

---

## Cargo.toml Dependencies

The contract specifies minimal, optimized dependencies in [Cargo.toml](./Cargo.toml):

- **`soroban-sdk`**: The standard SDK for writing Smart Contracts on Stellar. The `alloc` feature enables dynamic allocation support.
- **`testutils`**: Enables simulation, mocking, ledger manipulation, and event debugging inside the test environment.

---

## Deployment & Invocation Guide

Follow these commands to build, deploy, and invoke the contract locally or on the testnet.

### 1. Build the Contract
Compile the Rust contract into optimized WebAssembly:
```bash
cargo build --target wasm32-unknown-unknown --release
# Alternatively, use soroban contract build (if toolchain is installed):
# soroban contract build
```

### 2. Deploy to Testnet
Deploy the contract to the Stellar testnet and retrieve the contract ID:
```bash
soroban contract deploy \
  --wasm target/wasm32-unknown-unknown/release/stellar_payfi_escrow.wasm \
  --source-account my-keypair-name \
  --network testnet
```

### 3. Initialize Escrow (Example Command)
Lock 100 tokens with a future expiry timestamp (e.g. `1813689600`):
```bash
soroban contract invoke \
  --id CD_YOUR_CONTRACT_ID_HERE \
  --source-account depositor-keypair \
  --network testnet \
  -- \
  initialize \
  --depositor G_DEPOSITOR_ADDRESS \
  --recipient G_RECIPIENT_ADDRESS \
  --arbiter G_ARBITER_ADDRESS \
  --token C_TOKEN_CONTRACT_ADDRESS \
  --amount 1000000000 \
  --expiry 1813689600
```

### 4. Query Lifecycle State
```bash
soroban contract invoke \
  --id CD_YOUR_CONTRACT_ID_HERE \
  --source-account any-account \
  --network testnet \
  -- \
  get_state
```

### 5. Release Funds (by Arbiter)
```bash
soroban contract invoke \
  --id CD_YOUR_CONTRACT_ID_HERE \
  --source-account arbiter-keypair \
  --network testnet \
  -- \
  release \
  --arbiter G_ARBITER_ADDRESS
```

---

## Contract Upgrade Path

### Immutability Constraint

Soroban contracts are **immutable once deployed**. The escrow contract does not include an upgrade mechanism, meaning once deployed to mainnet, the contract code cannot be patched or modified. This is a fundamental design constraint of Soroban and ensures the security and predictability of deployed contracts.

### Upgrade Strategy

To deploy a new version of the escrow contract:

1. **Deploy a New Contract**: Build and deploy the updated contract to Soroban, which will generate a new contract ID.

2. **Migrate Active Escrows**: Transfer all active escrows from the old contract to the new contract:
   - **Manual Migration**: For each active escrow, call `refund()` on the old contract (if expired) or coordinate with the arbiter to release funds, then re-initialize on the new contract.
   - **Automated Migration Script**: Create a migration script that:
     - Reads all active escrow states from the old contract
     - Re-initializes each escrow on the new contract with the same parameters
     - Validates that all funds have been transferred correctly

3. **Update Contract Address Configuration**: Update the agent's configuration to reference the new contract address. This allows operators to swap contract addresses without code changes.

### Recommended Pattern: Configuration-Driven Addresses

To minimize downtime and simplify upgrades, store contract addresses in the agent's configuration file rather than hardcoding them:

```json
{
  "escrow_contract_address": "CD_CURRENT_CONTRACT_ID"
}
```

This approach allows operators to:
- Quickly switch to a new contract by updating the configuration
- Roll back to a previous contract if needed
- Test new contracts on testnet before mainnet deployment
- Avoid code deployments for contract address changes
