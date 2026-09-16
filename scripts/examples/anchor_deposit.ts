/**
 * scripts/examples/anchor_deposit.ts
 *
 * Demonstrates a complete PayFi onboarding scenario:
 *   1. Authenticate with a testnet anchor via SEP-0010 web auth.
 *   2. Fetch a SEP-0006 deposit address from the anchor.
 *   3. Send a test USDC payment to the returned deposit address.
 *   4. Print the anchor deposit confirmation details.
 *
 * Usage:
 *   npx ts-node scripts/examples/anchor_deposit.ts
 *
 * Required .env vars:
 *   AGENT_SECRET_KEY, HORIZON_URL, SOROBAN_RPC_URL, X402_ASSET_ISSUER,
 *   ANCHOR_URL, ANCHOR_ASSET_ISSUER
 *
 * Optional .env vars:
 *   ANCHOR_DEPOSIT_AMOUNT  — amount of USDC to deposit (default: "1.0000000")
 *   ANCHOR_ASSET_CODE      — asset code the anchor accepts (default: "USDC")
 *
 * Tested against the Stellar Demo Anchor (https://testanchor.stellar.org).
 */

// ⚠️  WARNING: This script submits live transactions on the Stellar testnet.
// Ensure STELLAR_NETWORK=testnet is set in your .env before running.

import * as dotenv from 'dotenv';
dotenv.config();

import { PayFiAgent } from '../../backend/agent';
import { StellarIdentityTool } from '../../backend/tools/StellarIdentityTool';
import { Keypair } from '@stellar/stellar-sdk';

// ---------------------------------------------------------------------------
// Configuration — read from environment, fall back to sensible testnet values
// ---------------------------------------------------------------------------

const ANCHOR_URL: string = process.env.ANCHOR_URL ?? 'https://testanchor.stellar.org';

const ANCHOR_ASSET_CODE: string = process.env.ANCHOR_ASSET_CODE ?? 'SRT';

// The Stellar Demo Anchor issues SRT (Stellar Reference Token) on testnet.
// Replace with your target anchor's USDC issuer on mainnet.
const ANCHOR_ASSET_ISSUER: string =
  process.env.ANCHOR_ASSET_ISSUER ?? 'GCDNJUBQSX7AJWLJACMJ7I4BC3Z47BQUTMHEICZLE6MU4KQBRYG5JY6';

const DEPOSIT_AMOUNT: string = process.env.ANCHOR_DEPOSIT_AMOUNT ?? '1.0000000';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Fetch the anchor's stellar.toml to locate the TRANSFER_SERVER and WEB_AUTH_ENDPOINT.
 * Returns a plain key-value map of well-known TOML fields.
 */
async function fetchStellarToml(anchorUrl: string): Promise<Record<string, string>> {
  const tomlUrl = `${anchorUrl.replace(/\/$/, '')}/.well-known/stellar.toml`;
  const res = await fetch(tomlUrl);
  if (!res.ok) {
    throw new Error(`Failed to fetch stellar.toml from ${tomlUrl}: HTTP ${res.status}`);
  }
  const text = await res.text();

  // Minimal TOML key="value" parser — sufficient for well-known Stellar fields.
  const parsed: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const match = line.match(/^\s*([A-Z_]+)\s*=\s*"([^"]+)"\s*$/);
    if (match) {
      parsed[match[1]] = match[2];
    }
  }
  return parsed;
}

/**
 * Initiate a SEP-0006 deposit with the anchor using the provided JWT.
 * Returns the deposit address and extra_memo (if any) from the anchor response.
 */
async function initiateDeposit(
  transferServerUrl: string,
  jwtToken: string,
  assetCode: string,
  accountId: string
): Promise<{ depositAddress: string; memo?: string; memoType?: string }> {
  const url = new URL(`${transferServerUrl.replace(/\/$/, '')}/deposit`);
  url.searchParams.set('asset_code', assetCode);
  url.searchParams.set('account', accountId);
  url.searchParams.set('type', 'crypto');

  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${jwtToken}` },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`SEP-0006 deposit initiation failed: HTTP ${res.status} — ${body}`);
  }

  const json = (await res.json()) as {
    how?: string;
    deposit_address?: string;
    extra_info?: { message?: string };
    memo?: string;
    memo_type?: string;
  };

  // `how` is the deposit address in SEP-0006; some anchors also expose
  // `deposit_address` directly.
  const depositAddress = json.how ?? json.deposit_address;
  if (!depositAddress) {
    throw new Error('Anchor did not return a deposit address in the `how` field.');
  }

  return {
    depositAddress,
    memo: json.memo,
    memoType: json.memo_type,
  };
}

// ---------------------------------------------------------------------------
// Main flow
// ---------------------------------------------------------------------------

const secretKey = process.env.AGENT_SECRET_KEY;
if (!secretKey) {
  throw new Error('AGENT_SECRET_KEY is not set in .env');
}
const agentPublicKey = Keypair.fromSecret(secretKey).publicKey();

console.log('=== Ledgera — Anchor Deposit Example ===\n');
console.log(`Agent public key : ${agentPublicKey}`);
console.log(`Anchor URL       : ${ANCHOR_URL}`);
console.log(`Asset            : ${ANCHOR_ASSET_CODE}:${ANCHOR_ASSET_ISSUER}`);
console.log(`Deposit amount   : ${DEPOSIT_AMOUNT}\n`);

// Step 1 — Discover anchor endpoints from stellar.toml
console.log('Step 1: Fetching stellar.toml ...');
const toml = await fetchStellarToml(ANCHOR_URL);
const webAuthEndpoint = toml['WEB_AUTH_ENDPOINT'] ?? `${ANCHOR_URL.replace(/\/$/, '')}/auth`;
const transferServer = toml['TRANSFER_SERVER'] ?? `${ANCHOR_URL.replace(/\/$/, '')}/sep6`;

console.log(`  WEB_AUTH_ENDPOINT : ${webAuthEndpoint}`);
console.log(`  TRANSFER_SERVER   : ${transferServer}\n`);

// Step 2 — SEP-0010 authentication
console.log('Step 2: Authenticating via SEP-0010 web auth ...');
const identityTool = new StellarIdentityTool(secretKey);

// StellarIdentityTool.execute() expects anchorUrl pointing to the auth base
// (i.e. the URL to which /auth is appended). We strip the `/auth` path suffix
// if the TOML already includes it, because the tool appends it internally.
const authBaseUrl = webAuthEndpoint.replace(/\/auth$/, '');
const authResult = await identityTool.execute({ anchorUrl: authBaseUrl });
const { token: jwtToken } = authResult;

console.log(`  JWT obtained successfully (${jwtToken.length} chars)\n`);

// Step 3 — Initiate SEP-0006 deposit to get the deposit address
console.log('Step 3: Initiating SEP-0006 deposit to obtain deposit address ...');
const depositInfo = await initiateDeposit(
  transferServer,
  jwtToken,
  ANCHOR_ASSET_CODE,
  agentPublicKey
);

console.log(`  Deposit address : ${depositInfo.depositAddress}`);
if (depositInfo.memo) {
  console.log(`  Memo (${depositInfo.memoType ?? 'text'})  : ${depositInfo.memo}`);
}
console.log();

// Step 4 — Send the USDC payment to the anchor's deposit address
console.log(`Step 4: Sending ${DEPOSIT_AMOUNT} ${ANCHOR_ASSET_CODE} to anchor deposit address ...`);
const agent = new PayFiAgent();

const paymentResult = await agent.run({
  type: 'stellar_payment',
  payload: {
    destination: depositInfo.depositAddress,
    amount: DEPOSIT_AMOUNT,
    assetCode: ANCHOR_ASSET_CODE,
    assetIssuer: ANCHOR_ASSET_ISSUER,
    ...(depositInfo.memo !== undefined && { memo: depositInfo.memo }),
  },
});

if (!paymentResult.success) {
  console.error('Payment failed:', paymentResult.error);
  agent.destroy();
  process.exit(1);
}

console.log(`  Transaction hash : ${(paymentResult.data as { txHash?: string })?.txHash ?? 'n/a'}`);
console.log(`  Duration         : ${paymentResult.durationMs ?? 'n/a'} ms\n`);

// Step 5 — Print deposit confirmation summary
console.log('=== Deposit Confirmation ===');
console.log(
  JSON.stringify(
    {
      anchor: ANCHOR_URL,
      asset: `${ANCHOR_ASSET_CODE}:${ANCHOR_ASSET_ISSUER}`,
      amount: DEPOSIT_AMOUNT,
      depositAddress: depositInfo.depositAddress,
      memo: depositInfo.memo,
      memoType: depositInfo.memoType,
      txHash: (paymentResult.data as { txHash?: string })?.txHash,
      jwtIssuedAt: new Date().toISOString(),
    },
    null,
    2
  )
);

agent.destroy();
