/**
 * tests/multisig_payment.test.ts
 * Tests for MultiSigPaymentTool (#108)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Keypair } from '@stellar/stellar-sdk';
import { MultiSigPaymentTool, MultiSigInputSchema } from '../backend/tools/MultiSigPaymentTool';
import * as rpcClient from '../backend/rpc_client';
import { ValidationError } from '../backend/errors';

const TEST_SECRET = Keypair.random().secret();

vi.mock('../backend/rpc_client', () => ({
  loadAccount: vi.fn(),
  submitTransaction: vi.fn(),
  horizonServer: {},
  sorobanServer: {},
  simulateSorobanTx: vi.fn(),
  prepareSorobanTx: vi.fn(),
  resolveNetworkPassphrase: vi.fn(() => 'Test SDF Network ; September 2015'),
}));

vi.mock('../backend/config', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Keypair } = require('@stellar/stellar-sdk');
  const secret = Keypair.random().secret();
  return {
    config: {
      STELLAR_NETWORK: 'testnet',
      HORIZON_URL: 'https://horizon-testnet.stellar.org',
      SOROBAN_RPC_URL: 'https://soroban-testnet.stellar.org',
      AGENT_PUBLIC_KEY: Keypair.fromSecret(secret).publicKey(),
      X402_ASSET_CODE: 'USDC',
      X402_ASSET_ISSUER: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
      MAX_RETRIES: 3,
      RETRY_DELAY_MS: 100,
      AGENT_SPENDING_LIMIT: '100',
      agentKeypair: () => Keypair.fromSecret(secret),
    },
  };
});

const DEST = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
const SIGNER2 = 'GBN52ISCBRJIVLVH554CGMITR3ZJURROF75FWSZ2H2HRDPFWSZXVPYFN';
const ISSUER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';

function makeMockAccount() {
  const { Keypair } = require('@stellar/stellar-sdk');
  const publicKey = Keypair.fromSecret(TEST_SECRET).publicKey();
  return {
    accountId: () => publicKey,
    sequenceNumber: () => '100',
    incrementSequenceNumber: vi.fn(),
    sequence: '100',
    incrementedSequenceNumber: () => '101',
    thresholds: { low_threshold: 0, med_threshold: 0, high_threshold: 0 },
    flags: { auth_required: false, auth_revocable: false, auth_immutable: false },
    balances: [{ asset_type: 'native', balance: '10000.0000000' }],
    signers: [],
    data_attr: {},
    subentry_count: 0,
    home_domain: '',
    inflation_dest: null,
  };
}

describe('MultiSigPaymentTool', () => {
  let tool: MultiSigPaymentTool;

  beforeEach(() => {
    vi.clearAllMocks();
    tool = new MultiSigPaymentTool(TEST_SECRET);
    vi.mocked(rpcClient.loadAccount).mockResolvedValue(makeMockAccount() as any);
  });

  // Audit finding Q-5: StellarPaymentTool/PathPaymentTool guard against paying
  // the agent's own address; MultiSigPaymentTool previously had no equivalent
  // check despite building the same kind of payment operation.
  it('rejects a destination equal to the agent\'s own public key (Q-5)', async () => {
    const { Keypair } = await import('@stellar/stellar-sdk');
    const ownPublicKey = Keypair.fromSecret(TEST_SECRET).publicKey();

    await expect(
      tool.execute({
        destination: ownPublicKey,
        amount: '100',
        assetCode: 'XLM',
        additionalSigners: [SIGNER2],
        minSignatures: 2,
      })
    ).rejects.toThrow(/own address/);
    expect(rpcClient.loadAccount).not.toHaveBeenCalled();
  });

  it('returns unsigned XDR when no signatures provided', async () => {
    const result = await tool.execute({
      destination: DEST,
      amount: '100',
      assetCode: 'XLM',
      additionalSigners: [SIGNER2],
      minSignatures: 2,
    });
    expect(result.unsignedXDR).toBeDefined();
    expect(typeof result.unsignedXDR).toBe('string');
    expect(result.txHash).toBeUndefined();
  });

  it('rejects invalid additional signers before any network call', async () => {
    await expect(
      tool.execute({
        destination: DEST,
        amount: '100',
        assetCode: 'XLM',
        additionalSigners: ['A'.repeat(56)],
        minSignatures: 2,
      })
    ).rejects.toThrow(/Invalid signer public key/);
    expect(rpcClient.loadAccount).not.toHaveBeenCalled();
  });

  it('unsigned XDR is valid base64-encoded XDR (non-empty)', async () => {
    const result = await tool.execute({
      destination: DEST,
      amount: '50',
      assetCode: 'XLM',
      additionalSigners: [SIGNER2],
      minSignatures: 2,
    });
    // Valid XDR can be decoded from base64
    expect(() => Buffer.from(result.unsignedXDR!, 'base64')).not.toThrow();
    expect(result.unsignedXDR!.length).toBeGreaterThan(50);
  });

  it('does not call submitTransaction when returning unsignedXDR', async () => {
    await tool.execute({
      destination: DEST,
      amount: '100',
      assetCode: 'XLM',
      additionalSigners: [SIGNER2],
      minSignatures: 2,
    });
    expect(rpcClient.submitTransaction).not.toHaveBeenCalled();
  });

  it('returns unsignedXDR when signatures are insufficient (1 provided, 2 required)', async () => {
    const result = await tool.execute({
      destination: DEST,
      amount: '100',
      assetCode: 'XLM',
      additionalSigners: [SIGNER2],
      minSignatures: 2,
      signatures: ['sig1'], // Only 1 signature, but minSignatures is 2
    });
    expect(result.unsignedXDR).toBeDefined();
    expect(typeof result.unsignedXDR).toBe('string');
    expect(result.txHash).toBeUndefined();
    expect(rpcClient.submitTransaction).not.toHaveBeenCalled();
  });

  it('submits and returns txHash when sufficient signatures provided', async () => {
    vi.mocked(rpcClient.submitTransaction).mockResolvedValue({
      hash: 'multisig_hash',
      ledger: 10,
    } as any);
    const validSigXdr =
      'AAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    const result = await tool.execute({
      destination: DEST,
      amount: '100',
      assetCode: 'XLM',
      additionalSigners: [SIGNER2],
      minSignatures: 1,
      signatures: [validSigXdr],
    });
    expect(result.txHash).toBe('multisig_hash');
    expect(result.ledger).toBe(10);
  });

  it('throws ValidationError when minSignatures exceeds total available signers', async () => {
    await expect(
      tool.execute({
        destination: DEST,
        amount: '100',
        assetCode: 'XLM',
        additionalSigners: [SIGNER2],
        minSignatures: 5, // only 2 signers (agent + SIGNER2)
      })
    ).rejects.toThrow(ValidationError);

    await expect(
      tool.execute({
        destination: DEST,
        amount: '100',
        assetCode: 'XLM',
        additionalSigners: [SIGNER2],
        minSignatures: 5,
      })
    ).rejects.toThrow(/minSignatures.*exceeds total available signers/);
  });

  it('fails schema validation when minSignatures exceeds total signers count', () => {
    const parseResult = MultiSigInputSchema.safeParse({
      destination: DEST,
      amount: '100',
      assetCode: 'XLM',
      additionalSigners: [SIGNER2],
      minSignatures: 3, // only 2 available: agent + SIGNER2
    });
    expect(parseResult.success).toBe(false);
    if (!parseResult.success) {
      expect(parseResult.error.issues[0]?.message).toContain(
        'minSignatures exceeds total available signers'
      );
    }
  });

  it('throws when non-XLM asset has no issuer', async () => {
    await expect(
      tool.execute({
        destination: DEST,
        amount: '100',
        assetCode: 'USDC',
        additionalSigners: [SIGNER2],
        minSignatures: 1,
      })
    ).rejects.toThrow(/Asset issuer is required/);
  });

  it('accepts custom asset with issuer and returns XDR', async () => {
    const result = await tool.execute({
      destination: DEST,
      amount: '100',
      assetCode: 'USDC',
      assetIssuer: ISSUER,
      additionalSigners: [SIGNER2],
      minSignatures: 2,
    });
    expect(result.unsignedXDR).toBeDefined();
  });
});
