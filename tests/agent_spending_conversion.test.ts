/**
 * tests/agent_spending_conversion.test.ts
 *
 * Covers the "convert" branch of SPENDING_LIMIT_UNKNOWN_ASSET_POLICY at the
 * PayFiAgent level: a payment in an asset other than XLM/X402_ASSET_CODE is
 * converted to the reference asset via ASSET_CONVERSION_RATES before being
 * checked and recorded, rather than rejected outright (the default —
 * covered in tests/agent_spending_atomicity.test.ts) or compared at face
 * value (the bug this guard closes).
 *
 * Kept in its own file because the "convert" policy and rate table are
 * process-wide config, set once for the whole file via vi.mock — mirroring
 * how tests/agent.test.ts fixes its config for its whole file.
 */

import Database from 'better-sqlite3';
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../backend/tools/StellarPaymentTool', () => ({
  StellarPaymentTool: vi.fn().mockImplementation(() => ({
    execute: vi.fn().mockResolvedValue({ txHash: 'mock_hash', ledger: 1 }),
  })),
}));
vi.mock('../backend/tools/SorobanInvokeTool', () => ({
  SorobanInvokeTool: vi.fn().mockImplementation(() => ({ execute: vi.fn() })),
}));
vi.mock('../backend/tools/X402PaymentTool', () => ({
  X402PaymentTool: vi.fn().mockImplementation(() => ({ respond: vi.fn() })),
}));
vi.mock('../backend/tools/AccountInfoTool', () => ({
  AccountInfoTool: vi.fn().mockImplementation(() => ({ fetch: vi.fn() })),
}));
vi.mock('../backend/tools/TrustlineTool', () => ({
  TrustlineTool: vi.fn().mockImplementation(() => ({ execute: vi.fn(), checkTrustline: vi.fn() })),
}));
vi.mock('../backend/tools/MultiSigPaymentTool', () => ({
  MultiSigPaymentTool: vi.fn().mockImplementation(() => ({ execute: vi.fn() })),
}));
vi.mock('../backend/tools/BatchPaymentTool', () => ({
  BatchPaymentTool: vi.fn().mockImplementation(() => ({ execute: vi.fn() })),
}));
vi.mock('../backend/tools/SorobanQueryTool', () => ({
  SorobanQueryTool: vi.fn().mockImplementation(() => ({ query: vi.fn() })),
}));
vi.mock('../backend/tools/BalanceCheckTool', () => ({
  BalanceCheckTool: vi.fn().mockImplementation(() => ({ getBalance: vi.fn() })),
}));
vi.mock('../backend/tools/PathPaymentTool', () => ({
  PathPaymentTool: vi.fn().mockImplementation(() => ({ execute: vi.fn() })),
}));
vi.mock('../backend/tools/FeeBumpTool', () => ({
  FeeBumpTool: vi.fn().mockImplementation(() => ({ execute: vi.fn() })),
}));
vi.mock('../backend/tools/DexOfferTool', () => ({
  DexOfferTool: vi.fn().mockImplementation(() => ({ execute: vi.fn() })),
}));
vi.mock('../backend/tools/LiquidityPoolTool', () => ({
  LiquidityPoolTool: vi.fn().mockImplementation(() => ({ execute: vi.fn() })),
}));
vi.mock('../backend/tools/StellarTomlTool', () => ({
  StellarTomlTool: vi.fn().mockImplementation(() => ({ fetchToml: vi.fn() })),
}));
vi.mock('../backend/tools/DataEntryTool', () => ({
  DataEntryTool: vi.fn().mockImplementation(() => ({ execute: vi.fn() })),
}));
vi.mock('../backend/tools/SequenceNumberTool', () => ({
  SequenceNumberTool: vi.fn().mockImplementation(() => ({ execute: vi.fn() })),
}));
vi.mock('../backend/tools/SponsoredAccountTool', () => ({
  SponsoredAccountTool: vi.fn().mockImplementation(() => ({ execute: vi.fn() })),
}));
vi.mock('../backend/tools/AnchorQuoteTool', () => ({
  AnchorQuoteTool: vi.fn().mockImplementation(() => ({ execute: vi.fn() })),
}));
vi.mock('../backend/tools/InflationTool', () => ({
  InflationTool: vi.fn().mockImplementation(() => ({ execute: vi.fn() })),
}));
vi.mock('../backend/tools/ContractEventListener', () => ({
  listen: vi.fn().mockReturnValue(() => {}),
}));
vi.mock('../backend/tools/ClaimableBalanceTool', () => ({
  ClaimableBalanceTool: vi.fn().mockImplementation(() => ({ execute: vi.fn() })),
}));
vi.mock('../backend/tools/SetOptionsTool', () => ({
  SetOptionsTool: vi.fn().mockImplementation(() => ({ execute: vi.fn() })),
}));
vi.mock('../backend/tools/SorobanEventIndexerTool', () => ({
  SorobanEventIndexerTool: vi.fn().mockImplementation(() => ({ query: vi.fn() })),
}));
vi.mock('../backend/tools/StellarIdentityTool', () => ({
  StellarIdentityTool: vi.fn().mockImplementation(() => ({ execute: vi.fn() })),
}));
vi.mock('../backend/tools/BalanceStreamTool', () => {
  const { EventEmitter } = require('events');
  return {
    BalanceStreamTool: vi.fn().mockImplementation(() => {
      const emitter = new EventEmitter();
      return { subscribe: vi.fn().mockReturnValue(emitter), stop: vi.fn() };
    }),
  };
});
vi.mock('../backend/webhook', () => ({ dispatchWebhook: vi.fn().mockResolvedValue(undefined) }));

vi.mock('../backend/rpc_client', () => ({
  loadAccount: vi.fn(),
  submitTransaction: vi.fn(),
  prepareSorobanTx: vi.fn(),
  prepareSorobanTxWithEvents: vi.fn(),
  simulateSorobanTx: vi.fn(),
  horizonServer: { payments: vi.fn(() => ({ forAccount: vi.fn(() => ({ stream: vi.fn() })) })) },
  sorobanServer: {},
  resolveNetworkPassphrase: vi.fn(() => 'Test SDF Network ; September 2015'),
  StellarRPCError: class extends Error {},
}));

const DEST = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
const ISSUER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';

vi.mock('../backend/config', () => ({
  config: {
    STELLAR_NETWORK: 'mainnet',
    HORIZON_URL: 'https://horizon.stellar.org',
    SOROBAN_RPC_URL: 'https://soroban-mainnet.stellar.org',
    AGENT_PUBLIC_KEY: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
    X402_ASSET_CODE: 'USDC',
    X402_ASSET_ISSUER: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
    MAX_RETRIES: 3,
    RETRY_DELAY_MS: 100,
    MAX_CONCURRENT_TASKS: 10,
    AGENT_SPENDING_LIMIT: '1000',
    SPENDING_WINDOW_MS: 24 * 60 * 60 * 1000,
    DB_PATH: ':memory:',
    SPENDING_LIMIT_UNKNOWN_ASSET_POLICY: 'convert',
    ASSET_CONVERSION_RATES: { BTC: 65_000 }, // no ETH entry — used by the "missing rate" test
    agentKeypair: () => ({
      secret: () => 'SADQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQP54X',
    }),
  },
  MAINNET_SPENDING_CAP: 10_000,
}));

import { PayFiAgent, spendingTracker } from '../backend/agent';
import { StellarPaymentTool } from '../backend/tools/StellarPaymentTool';
import { _setDb } from '../backend/persistence';

describe('PayFiAgent — SPENDING_LIMIT_UNKNOWN_ASSET_POLICY=convert', () => {
  beforeEach(() => {
    _setDb(new Database(':memory:'));
    spendingTracker.clear();
    vi.mocked(StellarPaymentTool).mockImplementation(
      () => ({ execute: vi.fn().mockResolvedValue({ txHash: 'mock_hash', ledger: 1 }) }) as any
    );
  });

  it('converts a non-reference asset via the configured rate and allows it within the limit', async () => {
    const agent = new PayFiAgent();

    // 0.01 BTC * 65,000 = 650 reference-asset units — within the 1000 limit
    // and the (mocked) 10,000 mainnet cap.
    const result = await agent.run({
      type: 'stellar_payment',
      payload: { destination: DEST, amount: '0.01', assetCode: 'BTC', assetIssuer: ISSUER },
    });

    expect(result.success).toBe(true);
  });

  it('records the converted amount, not the raw one, against the rolling window', async () => {
    const agent = new PayFiAgent();

    const first = await agent.run({
      type: 'stellar_payment',
      payload: { destination: DEST, amount: '0.01', assetCode: 'BTC', assetIssuer: ISSUER },
    });
    expect(first.success).toBe(true); // 650 recorded, not 0.01

    // A second 0.01 BTC payment would bring the cumulative converted total to
    // 1300 > 1000. If the raw "0.01" were recorded instead of 650, this would
    // wrongly succeed.
    const second = await agent.run({
      type: 'stellar_payment',
      payload: { destination: DEST, amount: '0.01', assetCode: 'BTC', assetIssuer: ISSUER },
    });
    expect(second.success).toBe(false);
    expect(second.error).toMatch(/Cumulative spending.*exceeds limit/);
  });

  it('rejects when no conversion rate is configured for the asset', async () => {
    const agent = new PayFiAgent();

    const result = await agent.run({
      type: 'stellar_payment',
      payload: { destination: DEST, amount: '1', assetCode: 'ETH', assetIssuer: ISSUER },
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/No conversion rate configured for asset ETH/);
  });

  it('a large converted amount is rejected using the converted value, not the small-looking raw one', async () => {
    const agent = new PayFiAgent();

    // 0.2 BTC looks small, but converts to 13,000 reference-asset units —
    // above both AGENT_SPENDING_LIMIT (1000) and the mainnet cap (10,000).
    // Whichever guard trips first, the raw "0.2" must never be what's compared.
    const result = await agent.run({
      type: 'stellar_payment',
      payload: { destination: DEST, amount: '0.2', assetCode: 'BTC', assetIssuer: ISSUER },
    });

    expect(result.success).toBe(false);
    // Proves the guard reasoned about the conversion (0.2 BTC -> 13,000
    // reference-asset units), not just the raw "0.2" from the payload.
    expect(result.error).toMatch(/converted from 0\.2 BTC at rate 65000/);
  });
});
