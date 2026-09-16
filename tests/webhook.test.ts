/**
 * tests/webhook.test.ts
 * Tests for dispatchWebhook: delivery, HMAC signature, retry, and no-op when unconfigured.
 *
 * Issue #448: HMAC signing implemented in backend/webhook.ts (X-Ledgera-Signature header).
 * Tests verify:
 *   - Dispatched request includes X-Ledgera-Signature with correct HMAC value
 *   - Signature can be independently verified with the shared secret
 *   - A tampered payload produces a detectable HMAC mismatch
 *   - Signature header is absent when WEBHOOK_SECRET is not configured
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHmac, timingSafeEqual } from 'crypto';
import { signPayload, dispatchWebhook, verifyWebhookSignature } from '../backend/webhook';
import type { AgentResult } from '../backend/agent';

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('axios', () => ({
  default: { post: vi.fn() },
}));

vi.mock('../backend/rpc_client', () => ({
  withRetry: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  DEFAULT_IS_RETRYABLE: vi.fn(() => true),
}));

// ─── Config mock — overridden per test ───────────────────────────────────────

vi.mock('../backend/config', () => ({
  config: {
    get WEBHOOK_URL() {
      return (globalThis as any).__webhookUrl;
    },
    get WEBHOOK_SECRET() {
      return (globalThis as any).__webhookSecret;
    },
  },
}));

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const successResult: AgentResult = {
  success: true,
  taskType: 'stellar_payment',
  data: { txHash: 'abc123', ledger: 10 },
};

const failureResult: AgentResult = {
  success: false,
  taskType: 'x402_respond',
  error: 'insufficient funds',
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('signPayload', () => {
  it('produces a valid HMAC-SHA256 hex string', () => {
    const payload = '{"foo":"bar"}';
    const secret = 'mysecret';
    const expected = createHmac('sha256', secret).update(payload).digest('hex');
    expect(signPayload(payload, secret)).toBe(expected);
  });
});

describe('verifyWebhookSignature', () => {
  it('returns true for a valid signature', () => {
    const payload = '{"foo":"bar"}';
    const secret = 'mysecret';
    const sig = signPayload(payload, secret);
    expect(verifyWebhookSignature(payload, sig, secret)).toBe(true);
  });

  it('returns false for an invalid signature', () => {
    const payload = '{"foo":"bar"}';
    const secret = 'mysecret';
    const sig = 'incorrectsignature';
    expect(verifyWebhookSignature(payload, sig, secret)).toBe(false);
  });

  it('returns false for a signature with incorrect length', () => {
    const payload = '{"foo":"bar"}';
    const secret = 'mysecret';
    const sig = 'abc';
    expect(verifyWebhookSignature(payload, sig, secret)).toBe(false);
  });

  it('returns false for a valid signature signed with a different secret', () => {
    const payload = '{"foo":"bar"}';
    const sig = signPayload(payload, 'wrongsecret');
    expect(verifyWebhookSignature(payload, sig, 'mysecret')).toBe(false);
  });

  it('returns false for a tampered payload', () => {
    const payload = '{"foo":"bar"}';
    const secret = 'mysecret';
    const sig = signPayload(payload, secret);
    const tamperedPayload = '{"foo":"baz"}';
    expect(verifyWebhookSignature(tamperedPayload, sig, secret)).toBe(false);
  });

  it('returns false for a wrong secret', () => {
    const payload = '{"foo":"bar"}';
    const correctSecret = 'mysecret';
    const wrongSecret = 'incorrectsecret';
    const sig = signPayload(payload, correctSecret);
    expect(verifyWebhookSignature(payload, sig, wrongSecret)).toBe(false);
  });

  it('returns false for signatures of different lengths without throwing', () => {
    const payload = '{"foo":"bar"}';
    const secret = 'mysecret';
    const shortSig = 'short';
    const longSig = signPayload(payload, secret) + 'extra';
    expect(() => verifyWebhookSignature(payload, shortSig, secret)).not.toThrow();
    expect(verifyWebhookSignature(payload, shortSig, secret)).toBe(false);
    expect(() => verifyWebhookSignature(payload, longSig, secret)).not.toThrow();
    expect(verifyWebhookSignature(payload, longSig, secret)).toBe(false);
  });
});

describe('dispatchWebhook', () => {
  let axiosPost: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.clearAllMocks();
    (globalThis as any).__webhookUrl = undefined;
    (globalThis as any).__webhookSecret = undefined;
    const axios = (await import('axios')).default;
    axiosPost = axios.post as ReturnType<typeof vi.fn>;
  });

  it('does nothing when WEBHOOK_URL is not set', async () => {
    (globalThis as any).__webhookUrl = undefined;
    await dispatchWebhook(successResult);
    expect(axiosPost).not.toHaveBeenCalled();
  });

  it('POSTs the AgentResult as JSON when WEBHOOK_URL is set', async () => {
    (globalThis as any).__webhookUrl = 'https://example.com/webhook';
    axiosPost.mockResolvedValueOnce({ status: 200 });

    await dispatchWebhook(successResult);

    expect(axiosPost).toHaveBeenCalledOnce();
    const calls = axiosPost.mock.calls;
    const call = calls[0];
    expect(call).toBeDefined();
    if (!call) return;
    const [url, body] = call;
    expect(url).toBe('https://example.com/webhook');
    expect(JSON.parse(body as string)).toMatchObject({
      success: true,
      taskType: 'stellar_payment',
    });
  });

  it('includes X-Ledgera-Signature header when WEBHOOK_SECRET is set', async () => {
    (globalThis as any).__webhookUrl = 'https://example.com/webhook';
    (globalThis as any).__webhookSecret = 'supersecret';
    axiosPost.mockResolvedValueOnce({ status: 200 });

    await dispatchWebhook(successResult);

    const call = axiosPost.mock.calls[0];
    expect(call).toBeDefined();
    if (!call) return;
    const [, body, opts] = call;
    const expectedSig = signPayload(body as string, 'supersecret');
    expect(opts.headers['X-Ledgera-Signature']).toBe(expectedSig);
  });

  it('POSTs on task failure result as well', async () => {
    (globalThis as any).__webhookUrl = 'https://example.com/webhook';
    axiosPost.mockResolvedValueOnce({ status: 200 });

    await dispatchWebhook(failureResult);

    const call = axiosPost.mock.calls[0];
    expect(call).toBeDefined();
    if (!call) return;
    const [, body] = call;
    expect(JSON.parse(body as string)).toMatchObject({ success: false, taskType: 'x402_respond' });
  });

  it('does not throw when axios.post rejects (swallows delivery errors)', async () => {
    (globalThis as any).__webhookUrl = 'https://example.com/webhook';
    axiosPost.mockRejectedValue(new Error('network error'));

    vi.useFakeTimers();
    try {
      const promise = dispatchWebhook(successResult);
      await vi.runAllTimersAsync();
      await expect(promise).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('retries 503 responses with exponential backoff and delivers on 200 (503 -> 503 -> 200)', async () => {
    (globalThis as any).__webhookUrl = 'https://example.com/webhook';
    axiosPost
      .mockRejectedValueOnce({ response: { status: 503 } })
      .mockRejectedValueOnce({ response: { status: 503 } })
      .mockResolvedValueOnce({ status: 200 });

    vi.useFakeTimers();
    try {
      const promise = dispatchWebhook(successResult);
      await vi.runAllTimersAsync();
      await promise;

      expect(axiosPost).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('retries when subscriber resolves with non-2xx status (503 -> 503 -> 200)', async () => {
    (globalThis as any).__webhookUrl = 'https://example.com/webhook';
    axiosPost
      .mockResolvedValueOnce({ status: 503 })
      .mockResolvedValueOnce({ status: 503 })
      .mockResolvedValueOnce({ status: 200 });

    vi.useFakeTimers();
    try {
      const promise = dispatchWebhook(successResult);
      await vi.runAllTimersAsync();
      await promise;

      expect(axiosPost).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not retry on HTTP 4xx (e.g. 400, 404) responses', async () => {
    (globalThis as any).__webhookUrl = 'https://example.com/webhook';
    axiosPost.mockRejectedValueOnce({ response: { status: 404 } });

    vi.useFakeTimers();
    try {
      const promise = dispatchWebhook(successResult);
      await vi.runAllTimersAsync();
      await promise;

      expect(axiosPost).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('retries on HTTP 429 rate limit responses', async () => {
    (globalThis as any).__webhookUrl = 'https://example.com/webhook';
    axiosPost
      .mockRejectedValueOnce({ response: { status: 429, headers: { 'retry-after': '1' } } })
      .mockResolvedValueOnce({ status: 200 });

    vi.useFakeTimers();
    try {
      const promise = dispatchWebhook(successResult);
      await vi.runAllTimersAsync();
      await promise;

      expect(axiosPost).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('ceases retrying after 3 failed attempts on persistent 5xx errors', async () => {
    (globalThis as any).__webhookUrl = 'https://example.com/webhook';
    axiosPost.mockRejectedValue({ response: { status: 500 } });

    vi.useFakeTimers();
    try {
      const promise = dispatchWebhook(successResult);
      await vi.runAllTimersAsync();
      await promise;

      expect(axiosPost).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ─── HMAC signature verification (Issue #448) ────────────────────────────────

/**
 * Helper: re-compute HMAC-SHA256 over a payload with a secret and return the
 * hex digest — mirrors what the receiver would do to verify the signature.
 */
function verifySignature(payload: string, secret: string, signature: string): boolean {
  const expected = createHmac('sha256', secret).update(payload).digest();
  const actual = Buffer.from(signature, 'hex');
  if (expected.length !== actual.length) return false;
  // Use timing-safe comparison to mirror real-world verification
  return timingSafeEqual(expected, actual);
}

describe('dispatchWebhook — HMAC signature verification (issue #448)', () => {
  const SECRET = 'test-webhook-secret-32-chars-long!';
  let axiosPost: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.clearAllMocks();
    (globalThis as any).__webhookUrl = 'https://example.com/hook';
    (globalThis as any).__webhookSecret = SECRET;
    const axios = (await import('axios')).default;
    axiosPost = axios.post as ReturnType<typeof vi.fn>;
    axiosPost.mockResolvedValue({ status: 200 });
  });

  // ── Presence and format ───────────────────────────────────────────────────

  it('dispatched request includes an X-Ledgera-Signature header', async () => {
    await dispatchWebhook(successResult);

    const [, , opts] = axiosPost.mock.calls[0]!;
    expect(opts.headers).toHaveProperty('X-Ledgera-Signature');
    expect(typeof opts.headers['X-Ledgera-Signature']).toBe('string');
    expect(opts.headers['X-Ledgera-Signature']).toHaveLength(64); // 32-byte SHA-256 → 64 hex chars
  });

  it('X-Ledgera-Signature header is absent when WEBHOOK_SECRET is not configured', async () => {
    (globalThis as any).__webhookSecret = undefined;

    await dispatchWebhook(successResult);

    const [, , opts] = axiosPost.mock.calls[0]!;
    expect(opts.headers).not.toHaveProperty('X-Ledgera-Signature');
  });

  // ── Correctness ───────────────────────────────────────────────────────────

  it('HMAC value is correct — can be independently verified with the shared secret', async () => {
    await dispatchWebhook(successResult);

    const [, body, opts] = axiosPost.mock.calls[0]!;
    const signature: string = opts.headers['X-Ledgera-Signature'];

    // Independently verify: receiver recomputes HMAC over the exact body bytes
    expect(verifySignature(body, SECRET, signature)).toBe(true);
  });

  it('signature is computed over the exact serialized JSON body', async () => {
    await dispatchWebhook(successResult);

    const [, body, opts] = axiosPost.mock.calls[0]!;
    const signature: string = opts.headers['X-Ledgera-Signature'];

    // The body must be the JSON serialisation of successResult
    expect(JSON.parse(body)).toMatchObject({ success: true, taskType: 'stellar_payment' });

    // Recompute manually — must match
    const expected = createHmac('sha256', SECRET).update(body).digest('hex');
    expect(signature).toBe(expected);
  });

  it('different payloads produce different signatures', async () => {
    axiosPost.mockResolvedValue({ status: 200 });

    await dispatchWebhook(successResult);
    const [, , opts1] = axiosPost.mock.calls[0]!;
    const sig1: string = opts1.headers['X-Ledgera-Signature'];

    vi.clearAllMocks();
    axiosPost.mockResolvedValue({ status: 200 });

    await dispatchWebhook(failureResult);
    const [, , opts2] = axiosPost.mock.calls[0]!;
    const sig2: string = opts2.headers['X-Ledgera-Signature'];

    expect(sig1).not.toBe(sig2);
  });

  it('different secrets produce different signatures for the same payload', () => {
    const payload = JSON.stringify(successResult);
    const sig1 = signPayload(payload, 'secret-one');
    const sig2 = signPayload(payload, 'secret-two');
    expect(sig1).not.toBe(sig2);
  });

  // ── Tamper detection ──────────────────────────────────────────────────────

  it('tampered payload produces a detectable HMAC mismatch', async () => {
    await dispatchWebhook(successResult);

    const [, body, opts] = axiosPost.mock.calls[0]!;
    const originalSignature: string = opts.headers['X-Ledgera-Signature'];

    // Simulate a man-in-the-middle modifying the payload after signing
    const tampered = body.replace(/"success":true/, '"success":false');

    // The tampered body must differ from the original
    expect(tampered).not.toBe(body);

    // Recomputing HMAC over tampered body must NOT match the original signature
    expect(verifySignature(tampered, SECRET, originalSignature)).toBe(false);
  });

  it('single-byte modification of payload invalidates the signature', async () => {
    await dispatchWebhook(successResult);

    const [, body, opts] = axiosPost.mock.calls[0]!;
    const signature: string = opts.headers['X-Ledgera-Signature'];

    // Flip one character anywhere in the body
    const idx = Math.floor(body.length / 2);
    const tampered = body.slice(0, idx) + (body[idx] === 'a' ? 'b' : 'a') + body.slice(idx + 1);

    expect(verifySignature(tampered, SECRET, signature)).toBe(false);
  });

  it('wrong secret cannot verify a valid signature', async () => {
    await dispatchWebhook(successResult);

    const [, body, opts] = axiosPost.mock.calls[0]!;
    const signature: string = opts.headers['X-Ledgera-Signature'];

    // Attacker has wrong secret — verification must fail
    expect(verifySignature(body, 'wrong-secret', signature)).toBe(false);
  });

  it('empty-string tamper (empty body) does not match original signature', async () => {
    await dispatchWebhook(successResult);

    const [, , opts] = axiosPost.mock.calls[0]!;
    const signature: string = opts.headers['X-Ledgera-Signature'];

    expect(verifySignature('', SECRET, signature)).toBe(false);
  });

  // ── signPayload unit tests ────────────────────────────────────────────────

  it('signPayload is deterministic — same inputs always produce the same digest', () => {
    const payload = '{"taskType":"stellar_payment","success":true}';
    const secret = 'determinism-test-secret';
    const sig1 = signPayload(payload, secret);
    const sig2 = signPayload(payload, secret);
    expect(sig1).toBe(sig2);
  });

  it('signPayload output is a 64-character lowercase hex string', () => {
    const sig = signPayload('any payload', 'any secret');
    expect(sig).toMatch(/^[0-9a-f]{64}$/);
  });
});
