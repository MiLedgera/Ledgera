---
name: Feature Request
about: Suggest a new feature or improvement for Ledgera
title: "[FEATURE] "
labels: enhancement
assignees: ''

---

<!--
  Thank you for suggesting a feature! The more detail you provide, the easier
  it is for maintainers to evaluate and prioritise your request.
  Please remove any placeholder text before submitting.
-->

## Summary

A clear and concise description of the feature you'd like to see added.

---

## Motivation

Why is this feature important? What problem does it solve, and what use case does it enable?

<!-- e.g. "Currently, batch payments fail silently when one payment in the
     batch exceeds the spending limit. I need the agent to..."  -->

---

## Affected Task Type

Which task type(s) does this feature touch, or does it introduce a new one?

- [ ] `stellar_payment`
- [ ] `soroban_invoke`
- [ ] `x402_respond`
- [ ] `path_payment`
- [ ] `fee_bump`
- [ ] `account_info`
- [ ] `batch_payment`
- [ ] `multisig_payment`
- [ ] `dex_offer`
- [ ] New task type (specify below)
- [ ] Not task-specific (infrastructure, DX, docs, etc.)

**If new task type, proposed name:**

```
my_new_task
```

---

## Proposed API Shape

How would a caller interact with this feature? Provide a TypeScript snippet using the `PayFiAgent` API.

```typescript
import { PayFiAgent } from "./backend/agent";

const agent = new PayFiAgent();

const result = await agent.run({
  type: "my_new_task",
  payload: {
    // describe the expected payload fields here
  },
});

// Expected result shape:
// result.data === { ... }
agent.destroy();
```

**Proposed payload schema (if applicable):**

```typescript
interface MyNewTaskPayload {
  field1: string;
  field2?: number;
}
```

---

## Complexity Estimate

How complex do you estimate this feature to be?

- [ ] **Small** — a few lines, no new files (e.g. add a new config option)
- [ ] **Medium** — new tool file, schema, and unit tests (e.g. add a new `TaskType`)
- [ ] **Large** — cross-cutting changes across multiple modules (e.g. new auth layer)
- [ ] **Unknown** — needs further investigation

---

## Acceptance Criteria

What defines "done" for this feature?

- [ ] Implementation in `backend/tools/` or relevant module
- [ ] New `TaskType` entry added (if applicable)
- [ ] Unit tests added in `tests/`
- [ ] README API Reference table updated
- [ ] ARCHITECTURE.md updated (if the design changes)
- [ ] Example script added to `scripts/examples/` (optional but encouraged)
- [ ] Documentation updated

---

## Alternative Approaches

Have you considered other ways to solve this? What are the trade-offs?

---

## Additional Context

Any other context, links to related issues, protocol specs, or design documents.
