/**
 * tests/server.test.ts
 *
 * Tests for backend/server.ts — the health-check HTTP server.
 *
 * Strategy:
 *   - Mock `http.createServer` so we can capture the request handler
 *     without opening a real TCP port.
 *   - Mock `config` to provide deterministic values for STELLAR_NETWORK
 *     and AGENT_PUBLIC_KEY.
 *   - Mock `getResults` from persistence to inject controlled data for
 *     the /status endpoint.
 *   - Invoke the captured handler with mock req/res objects and assert
 *     the response shapes.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Mock modules before importing the module under test ──────────────────────

// Mock http module to capture the request handler
let capturedHandler: http.RequestListener | null = null;
vi.mock('http', () => ({
  createServer: vi.fn((handler: http.RequestListener) => {
    capturedHandler = handler;
    return {
      listen: vi.fn(),
      close: vi.fn(),
    };
  }),
}));

// Mock config module with deterministic values
vi.mock('../backend/config', () => ({
  config: {
    STELLAR_NETWORK: 'testnet',
    AGENT_PUBLIC_KEY: 'GTEST1234567890123456789012345678901234567890123456',
    HEALTH_PORT: 3000,
    // server.ts pulls in rpc_client, which builds a Horizon.Server at import
    // time; without these the URI constructor throws and the suite cannot load.
    HORIZON_URL: 'https://horizon-testnet.stellar.org',
    SOROBAN_RPC_URL: 'https://soroban-testnet.stellar.org',
  },
}));

// Mock persistence module — getResults returns controlled data, or throws
// when a test wants to exercise the error path.
let mockResults: any[] = [];
let mockResultsError: unknown = null;
vi.mock('../backend/persistence', () => ({
  getResults: vi.fn((limit?: number) => {
    if (mockResultsError) throw mockResultsError;
    return mockResults.slice(0, limit ?? 100);
  }),
}));

import type * as http from 'http';
import { createHealthServer } from '../backend/server';
import {
  ContractError,
  NetworkTimeoutError,
  RateLimitError,
  UnauthorizedError,
  ValidationError,
} from '../backend/errors';
import { getResults } from '../backend/persistence';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeReq(
  method: string,
  url: string,
  headers: Record<string, string> = {}
): http.IncomingMessage {
  return { method, url, headers } as http.IncomingMessage;
}

function makeRes(): http.ServerResponse & {
  _statusCode: number;
  _body: string;
  _headers: Record<string, any>;
} {
  const res: any = {
    _statusCode: 0,
    _body: '',
    _headers: {},
    writeHead: vi.fn(function (this: any, statusCode: number, headers?: Record<string, any>) {
      this._statusCode = statusCode;
      if (headers) Object.assign(this._headers, headers);
    }),
    end: vi.fn(function (this: any, body?: string) {
      this._body = body ?? '';
    }),
  };
  return res;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('backend/server.ts — health check HTTP server', () => {
  beforeEach(() => {
    capturedHandler = null;
    mockResults = [];
    mockResultsError = null;
    vi.clearAllMocks();
  });

  it('creates an http server via http.createServer', () => {
    createHealthServer();
    // If createServer was called, our mock would have captured the handler
    expect(capturedHandler).toBeTypeOf('function');
  });

  describe('GET /health', () => {
    it("returns 200 with { status: 'ok', network, publicKey }", () => {
      createHealthServer();
      const req = makeReq('GET', '/health');
      const res = makeRes();

      capturedHandler!(req, res);

      expect(res._statusCode).toBe(200);
      const body = JSON.parse(res._body);
      expect(body).toEqual({
        status: 'ok',
        network: 'testnet',
        publicKey: 'GTEST1234567890123456789012345678901234567890123456',
      });
      expect(res._headers['Content-Type']).toBe('application/json');
    });

    it('health response matches expected shape', () => {
      createHealthServer();
      const req = makeReq('GET', '/health');
      const res = makeRes();

      capturedHandler!(req, res);

      expect(res._statusCode).toBe(200);
      const body = JSON.parse(res._body);
      expect(body).toMatchSnapshot();
    });

    it('includes the correct network value from config', () => {
      createHealthServer();
      const req = makeReq('GET', '/health');
      const res = makeRes();

      capturedHandler!(req, res);

      const body = JSON.parse(res._body);
      expect(body.network).toBe('testnet');
      expect(body).toHaveProperty('status');
      expect(body).toHaveProperty('network');
      expect(body).toHaveProperty('publicKey');
    });
  });

  describe('GET /status', () => {
    it('returns 200 with { results: [] } when no persisted results exist', () => {
      createHealthServer();
      const req = makeReq('GET', '/status');
      const res = makeRes();

      capturedHandler!(req, res);

      expect(res._statusCode).toBe(200);
      const body = JSON.parse(res._body);
      expect(body).toHaveProperty('results');
      expect(Array.isArray(body.results)).toBe(true);
      expect(body.results).toEqual([]);
      expect(getResults).toHaveBeenCalledWith(10);
    });

    it('returns 200 with the last 10 AgentResult records from persistence', () => {
      const fakeResults = Array.from({ length: 15 }, (_, i) => ({
        timestamp: `2026-07-24T10:0${i}:00.000Z`,
        taskType: 'stellar_payment',
        success: true,
        data: { txHash: `hash_${i}` },
      }));
      mockResults = fakeResults;

      createHealthServer();
      const req = makeReq('GET', '/status');
      const res = makeRes();

      capturedHandler!(req, res);

      expect(res._statusCode).toBe(200);
      const body = JSON.parse(res._body);
      expect(body).toHaveProperty('results');
      expect(Array.isArray(body.results)).toBe(true);
      expect(body.results).toHaveLength(10);
      // Should be the first 10 from our mock (getResults returns newest-first)
      expect(body.results[0].data.txHash).toBe('hash_0');
    });

    it('returns 500 when persistence throws an error', () => {
      vi.mocked(getResults).mockImplementationOnce(() => {
        throw new Error('Database unavailable');
      });

      createHealthServer();
      const req = makeReq('GET', '/status');
      const res = makeRes();

      capturedHandler!(req, res);

      expect(res._statusCode).toBe(500);
      const body = JSON.parse(res._body);
      expect(body.type).toBe('InternalServerError');
      // The raw failure message is deliberately not echoed back: /status has no
      // auth guard, so an internal fault must not describe itself to callers.
      expect(res._body).not.toContain('Database unavailable');
    });
  });

  // Audit finding S-2: /status returned recent AgentResult records
  // (correlation IDs, error text, tool data) to any caller when WEBHOOK_SECRET
  // was unset — the default. It now shares /spending's auth gate. Uses a
  // dynamic import after setting process.env.WEBHOOK_SECRET because
  // server.ts reads it into a module-level const at import time.
  describe('GET /status — auth gate (audit S-2)', () => {
    const ORIGINAL_SECRET = process.env.WEBHOOK_SECRET;

    afterEach(() => {
      if (ORIGINAL_SECRET === undefined) {
        delete process.env.WEBHOOK_SECRET;
      } else {
        process.env.WEBHOOK_SECRET = ORIGINAL_SECRET;
      }
    });

    it('returns 401 without a Bearer token when WEBHOOK_SECRET is configured', async () => {
      process.env.WEBHOOK_SECRET = 'test-webhook-secret';
      vi.resetModules();
      const { createHealthServer: createAuthedServer } = await import('../backend/server');
      createAuthedServer();
      const req = makeReq('GET', '/status');
      const res = makeRes();

      capturedHandler!(req, res);

      expect(res._statusCode).toBe(401);
      expect(getResults).not.toHaveBeenCalled();
    });

    it('returns 401 with the wrong Bearer token when WEBHOOK_SECRET is configured', async () => {
      process.env.WEBHOOK_SECRET = 'test-webhook-secret';
      vi.resetModules();
      const { createHealthServer: createAuthedServer } = await import('../backend/server');
      createAuthedServer();
      const req = makeReq('GET', '/status', { authorization: 'Bearer wrong-secret' });
      const res = makeRes();

      capturedHandler!(req, res);

      expect(res._statusCode).toBe(401);
    });

    it('returns 200 with the correct Bearer token when WEBHOOK_SECRET is configured', async () => {
      process.env.WEBHOOK_SECRET = 'test-webhook-secret';
      vi.resetModules();
      const { createHealthServer: createAuthedServer } = await import('../backend/server');
      createAuthedServer();
      const req = makeReq('GET', '/status', { authorization: 'Bearer test-webhook-secret' });
      const res = makeRes();

      capturedHandler!(req, res);

      expect(res._statusCode).toBe(200);
    });

    it('/health remains unauthenticated even when WEBHOOK_SECRET is configured', async () => {
      process.env.WEBHOOK_SECRET = 'test-webhook-secret';
      vi.resetModules();
      const { createHealthServer: createAuthedServer } = await import('../backend/server');
      createAuthedServer();
      const req = makeReq('GET', '/health');
      const res = makeRes();

      capturedHandler!(req, res);

      expect(res._statusCode).toBe(200);
    });
  });

  describe('404 handling', () => {
    it('returns 404 for unknown routes', () => {
      createHealthServer();
      const req = makeReq('GET', '/unknown');
      const res = makeRes();

      capturedHandler!(req, res);

      expect(res._statusCode).toBe(404);
    });

    it('returns 404 for POST /health', () => {
      createHealthServer();
      const req = makeReq('POST', '/health');
      const res = makeRes();

      capturedHandler!(req, res);

      expect(res._statusCode).toBe(404);
    });
  });

  describe('structured error responses', () => {
    async function requestStatusWith(err: unknown) {
      mockResultsError = err;
      createHealthServer();
      const req = makeReq('GET', '/status');
      const res = makeRes();
      await capturedHandler!(req, res);
      return res;
    }

    it('returns 400 when the handler throws a ValidationError', async () => {
      const res = await requestStatusWith(new ValidationError('bad limit'));
      expect(res._statusCode).toBe(400);
      expect(JSON.parse(res._body).type).toBe('ValidationError');
    });

    it('returns 401 when the handler throws an UnauthorizedError', async () => {
      const res = await requestStatusWith(new UnauthorizedError('no token'));
      expect(res._statusCode).toBe(401);
    });

    it('returns 429 with Retry-After when the handler throws a RateLimitError', async () => {
      const res = await requestStatusWith(new RateLimitError('slow down', 45));
      expect(res._statusCode).toBe(429);
      expect(res._headers['Retry-After']).toBe('45');
    });

    it('returns 503 when the handler throws a NetworkTimeoutError', async () => {
      const res = await requestStatusWith(new NetworkTimeoutError('horizon timed out'));
      expect(res._statusCode).toBe(503);
    });

    it('returns 500 for error types with no client-side meaning', async () => {
      const res = await requestStatusWith(new ContractError('trapped'));
      expect(res._statusCode).toBe(500);
    });

    it('returns 500 for a plain Error', async () => {
      const res = await requestStatusWith(new Error('boom'));
      expect(res._statusCode).toBe(500);
    });
  });

  // ── Docker / container health check contract (#463) ────────────────────────
  // The Docker Compose health check polls GET /health and greps for
  // `"status":"ok"` in the response body.  These tests pin that exact
  // contract so a refactor cannot silently break container readiness probes.
  describe('Docker health check contract', () => {
    it('GET /health returns 200 so curl exits 0', () => {
      createHealthServer();
      const req = makeReq('GET', '/health');
      const res = makeRes();

      capturedHandler!(req, res);

      expect(res._statusCode).toBe(200);
    });

    it('GET /health body contains "status":"ok" for the grep probe', () => {
      createHealthServer();
      const req = makeReq('GET', '/health');
      const res = makeRes();

      capturedHandler!(req, res);

      // The Compose health check runs:
      //   curl -sf http://localhost:3000/health | grep -q '"status":"ok"'
      // The body must contain that exact substring.
      expect(res._body).toContain('"status":"ok"');
    });

    it('GET /health body contains the STELLAR_NETWORK value', () => {
      createHealthServer();
      const req = makeReq('GET', '/health');
      const res = makeRes();

      capturedHandler!(req, res);

      const body = JSON.parse(res._body);
      // config.STELLAR_NETWORK is "testnet" in the test mock
      expect(body.network).toBe('testnet');
    });

    it('GET /health responds with Content-Type: application/json', () => {
      createHealthServer();
      const req = makeReq('GET', '/health');
      const res = makeRes();

      capturedHandler!(req, res);

      expect(res._headers['Content-Type']).toBe('application/json');
    });
  });
});
