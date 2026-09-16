/**
 * scripts/examples/x402_full_flow.ts
 *
 * Demonstrates a complete autonomous x402 payment flow end-to-end:
 *   1. Starts an offline mock Express server hosting a gated `/resource` endpoint
 *      that requires payment and issues a 402 Payment Required challenge.
 *   2. The agent attempts to access the gated resource, receives the 402 challenge,
 *      responds to it via `x402_respond` (completing the payment offline using mockHorizonServer),
 *      and obtains an `X402PaymentProof`.
 *   3. The agent replays the request with the proof attached in the `X-PAYMENT-PROOF` header,
 *      and prints the unlocked resource response body.
 *
 * Usage:
 *   npx ts-node scripts/examples/x402_full_flow.ts
 *
 * Runs offline without live network dependencies by mocking Horizon RPC calls.
 */

import express from 'express';
import axios from 'axios';
import { randomUUID } from 'crypto';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import { Keypair } from '@stellar/stellar-sdk';

// Mock rpc_client before importing agent so the script runs completely offline
import * as rpcClient from '../../backend/rpc_client';
import { createMockHorizonServer } from '../../tests/fixtures/MockHorizonServer';

const mockHorizon = createMockHorizonServer({
  submitResult: { hash: 'x402_mock_tx_hash_001', ledger: 12345 },
});

// Intercept all RPC calls on backend/rpc_client with our offline mock fixture
Object.assign(rpcClient, mockHorizon);

import { PayFiAgent } from '../../backend/agent';
import { X402Challenge, X402PaymentProof } from '../../backend/tools/X402PaymentTool';

const RESOURCE_SERVER_KEYPAIR = Keypair.random();
const ASSET_ISSUER_KEYPAIR = Keypair.random();
const ASSET_CODE = 'USDC';

async function main(): Promise<void> {
  console.log('=== Ledgera — Full Autonomous x402 Payment Flow Example ===\n');

  const app = express();
  app.use(express.json());

  let activeChallenge: X402Challenge;

  // Gated resource endpoint that enforces x402 payment
  app.get('/resource', (req, res) => {
    const proofHeader = req.headers['x-payment-proof'];

    if (!proofHeader) {
      console.log(
        '  [Server] Request received without proof -> returning 402 Payment Required challenge'
      );
      activeChallenge = {
        resource: `http://127.0.0.1:${(server.address() as AddressInfo).port}/resource`,
        amount: '0.5000000',
        assetCode: ASSET_CODE,
        assetIssuer: ASSET_ISSUER_KEYPAIR.publicKey(),
        payTo: RESOURCE_SERVER_KEYPAIR.publicKey(),
        nonce: randomUUID(),
        expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      };
      res.status(402).json(activeChallenge);
      return;
    }

    try {
      const raw = Array.isArray(proofHeader) ? proofHeader[0] : proofHeader;
      const proof: X402PaymentProof = JSON.parse(raw ?? '');

      if (proof.protocol === 'x402' && proof.txHash && proof.nonce === activeChallenge.nonce) {
        console.log('  [Server] Valid X402PaymentProof verified -> 200 OK access granted');
        res.status(200).json({
          status: 'success',
          message: '🎉 Access Granted! Premium AI Model Insights & Dataset unlocked.',
          unlockedAt: new Date().toISOString(),
          txHash: proof.txHash,
          payer: proof.payer,
        });
      } else {
        console.log('  [Server] Invalid payment proof -> 400 Bad Request');
        res.status(400).json({ error: 'Invalid payment proof' });
      }
    } catch {
      res.status(400).json({ error: 'Malformed X-PAYMENT-PROOF header' });
    }
  });

  // Start local server on an ephemeral port
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });

  const port = (server.address() as AddressInfo).port;
  const resourceUrl = `http://127.0.0.1:${port}/resource`;
  console.log(`[1] Gated Express server running at: ${resourceUrl}\n`);

  const agent = new PayFiAgent();

  try {
    // Step 1: Initial request to access gated resource
    console.log('[2] Agent requesting gated resource (unauthenticated)...');
    const initialResponse = await axios.get(resourceUrl, {
      validateStatus: () => true,
    });
    console.log(`    Response status: ${initialResponse.status} ${initialResponse.statusText}`);
    console.log('    Received 402 challenge payload:');
    console.log(JSON.stringify(initialResponse.data, null, 2), '\n');

    if (initialResponse.status !== 402) {
      throw new Error(`Expected HTTP 402 challenge, received ${initialResponse.status}`);
    }

    const challenge: X402Challenge = initialResponse.data;

    // Step 2: Agent responds autonomously to the x402 challenge
    console.log('[3] Agent autonomously executing x402_respond task...');
    const agentResult = await agent.run({
      type: 'x402_respond',
      payload: challenge,
    });

    if (!agentResult.success || !agentResult.data) {
      throw new Error(`Agent failed to respond to x402 challenge: ${agentResult.error}`);
    }

    const proof = agentResult.data as X402PaymentProof;
    console.log('    Payment settled! Generated X402PaymentProof:');
    console.log(JSON.stringify(proof, null, 2), '\n');

    // Step 3: Agent retries resource access with proof attached in header
    console.log('[4] Agent retrying request with X-PAYMENT-PROOF header...');
    const paidResponse = await axios.get(resourceUrl, {
      headers: {
        'X-PAYMENT-PROOF': JSON.stringify(proof),
      },
      validateStatus: () => true,
    });

    console.log(`    Response status: ${paidResponse.status} ${paidResponse.statusText}`);
    console.log('    Unlocked Resource Response Body:');
    console.log(JSON.stringify(paidResponse.data, null, 2), '\n');

    console.log('✅ Full x402 autonomous payment flow completed successfully!');
  } finally {
    agent.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

main().catch((err) => {
  console.error('\n❌ x402 flow failed:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
