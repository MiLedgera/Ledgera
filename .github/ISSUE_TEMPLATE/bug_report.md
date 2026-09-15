---
name: Bug Report
about: Report a bug to help us improve Ledgera
title: "[BUG] "
labels: bug
assignees: ''

---

<!--
  Thank you for filing a bug report! Filling in the sections below helps us
  triage and reproduce the issue faster and reduces back-and-forth.
  Please remove any placeholder text before submitting.
-->

## Summary

A clear and concise description of what the bug is.

---

## Environment

| Field | Value |
|---|---|
| **Node.js version** | (e.g. `20.x`) |
| **npm version** | (e.g. `10.x`) |
| **TypeScript version** | (e.g. `5.x`) |
| **Stellar network** | `testnet` / `mainnet` / `local` |
| **OS** | (e.g. Ubuntu 22.04, macOS 14, Windows 11) |
| **Branch / commit** | (e.g. `main`, `feat/my-feature`, or commit SHA) |
| **Docker** | Yes / No — if yes, include Compose version |

---

## Affected File / Module

Which file(s) or module(s) are involved?

- [ ] `backend/agent.ts`
- [ ] `backend/config.ts`
- [ ] `backend/server.ts`
- [ ] `backend/tools/StellarPaymentTool.ts`
- [ ] `backend/tools/SorobanInvokeTool.ts`
- [ ] `backend/tools/X402PaymentTool.ts`
- [ ] `backend/tools/` — other tool (specify below)
- [ ] `contracts/escrow/`
- [ ] `tests/`
- [ ] Other (specify below)

**Specify file(s):**

```
backend/tools/YourTool.ts
```

---

## Steps to Reproduce

Provide a minimal, complete, and verifiable example.

1. Configure `.env` with `...`
2. Run `npx ts-node scripts/examples/...`
3. Observe error at step `...`

**Minimal reproduction code:**

```typescript
import { PayFiAgent } from "./backend/agent";

const agent = new PayFiAgent();
const result = await agent.run({
  type: "stellar_payment",
  payload: {
    // paste your payload here
  },
});
console.log(result);
agent.destroy();
```

---

## Expected Behavior

What did you expect to happen?

---

## Actual Behavior

What actually happened? Paste the full error message or unexpected output.

---

## Logs

Paste relevant log output. Use `LOG_LEVEL=debug` for verbose output and redact any secrets.

```
[paste logs here]
```

---

## Additional Context

Any other context, screenshots, or related issues that might be helpful.

<!-- e.g. "This worked on v1.0.0 but broke after upgrading to v1.1.0" -->
