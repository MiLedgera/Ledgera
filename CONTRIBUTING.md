# Contributing to Ledgera

Thank you for your interest in contributing to Ledgera! This document outlines our contribution workflow and guidelines.

---

## Stellar Wave & Drips Points

Ledgera participates in the **[Stellar Wave](https://stellar.org/wave)** programme — a developer contribution sprint where every merged PR on a labelled issue earns you **Drips points** that can be redeemed within the Stellar ecosystem.

### What are Drips points?

Drips points are contribution credits issued by the Stellar Development Foundation to reward open-source work. Points are tracked per-contributor and accumulated over each sprint cycle.

### How to earn points

1. **Find a Wave-eligible issue**: Browse the [Issues](https://github.com/MiLedgera/Ledgera/issues) tab and filter by `good first issue`, `help wanted`, or any issue carrying a `complexity: <score>` label.
2. **Claim the issue**: Comment on it so maintainers can assign it to you and avoid duplicate work.
3. **Submit a PR**: Reference the issue number (`Closes #<number>`) in your PR description. Follow the branch-naming and commit-message conventions below.
4. **Get it merged**: Once your PR passes CI and review, it is merged and your Drips points are recorded.

### Sprint cycle cadence

Stellar Wave runs in **two-week sprints**. Issues labelled for the current sprint are prioritised for review. Check the project board or issue comments for the active sprint tag.

### Finding Wave-eligible issues

| Filter | What it means |
|---|---|
| `good first issue` | Well-scoped, low-complexity tasks ideal for new contributors |
| `help wanted` | Explicitly open for community contributions |
| `complexity: 100` | Small tasks (~1–2 h); earn **100 Drips points** on merge |
| `complexity: 150` | Medium tasks (~3–4 h); earn **150 Drips points** on merge |
| `complexity: 200` | Larger tasks (~5+ h); earn **200 Drips points** on merge |

### Drips points table

| Complexity Score | Estimated effort | Drips points awarded |
|:-:|:-:|:-:|
| 100 | ~1–2 hours | 100 |
| 150 | ~3–4 hours | 150 |
| 200 | ~5+ hours | 200 |

Points are awarded **once per merged PR** on an issue carrying a `complexity` label. A single PR that closes multiple issues earns the sum of their individual scores.

---

## Stellar Wave Sprint Workflow

We are actively participating in the **Stellar Wave** program! Here's how you can earn Drips points for your contributions:

1. **Find an Issue**: Browse the [Issues](https://github.com/MiLedgera/Ledgera/issues) tab for tickets tagged `good first issue` (ideal for new contributors) or `help wanted`.
2. **Claim the Issue**: Comment on the issue to let maintainers know you're working on it.
3. **Submit a PR**: Follow the guidelines below and reference the issue in your PR.
4. **Earn Drips Points**: Once your PR is merged, you'll be eligible for Drips points!

---

## Branch Naming

Please use these prefixes for your branches:
- `feat/<description>`: New features
- `fix/<description>`: Bug fixes
- `docs/<description>`: Documentation updates
- `test/<description>`: Test additions or improvements
- `refactor/<description>`: Code refactoring

Example:
```bash
git checkout -b feat/33-add-dev-env-validation
```

---

## Commit Message Format

We follow the **Conventional Commits** specification. Your commit messages should be structured like this:

```
<type>(<scope>): <description>
```

Examples:
- `feat(#33): Add environment validation to dev.sh`
- `fix: Handle RPC timeouts gracefully`
- `docs: Update CONTRIBUTING.md with branch naming rules`
- `test: Add coverage for x402 payment tool`

---

## Pull Request Checklist

Before submitting your PR, make sure:
- ✅ All tests pass (`npm run test` and `cargo test --manifest-path contracts/escrow/Cargo.toml`)
- ✅ TypeScript compiles cleanly (`tsc --noEmit`)
- ✅ Linting passes (`npm run lint`)
- ✅ Formatting passes (`npm run format:check`) — run `npm run format` to auto-fix
- ✅ No secrets or private keys are in the diff
- ✅ You've referenced the issue number in your PR description

---

## Development Workflow

1. **Check Issues**: Browse the [Issues](https://github.com/MiLedgera/Ledgera/issues) tab for tickets tagged `good first issue` or `help wanted`.

2. **Create a Feature Branch**:
   ```bash
   git checkout -b feat/<issue-number>-<description>
   # Example: git checkout -b feat/30-github-actions-ci
   ```

3. **Make Your Changes**:
   - Follow the project structure in `README.md`
   - Ensure all tests pass: `npm run test`
   - Run the linter: `npm run lint`
   - Check formatting: `npm run format:check` (or `npm run format` to auto-fix)
   - For TypeScript changes, compile: `npm run build`
   - For Rust changes, test: `cargo test --manifest-path contracts/escrow/Cargo.toml`

4. **Commit with Clear Messages**:
   ```bash
   git commit -m "feat(#30): Add GitHub Actions CI workflow"
   ```

5. **Push and Open a Pull Request**:
   ```bash
   git push origin feat/<issue-number>-<description>
   ```

---

## Adding a New Tool

The most common contribution to this repo is adding a new tool to the agent (e.g. a new Stellar operation). Follow this checklist rather than reverse-engineering the pattern from existing tools:

1. **Create `backend/tools/YourTool.ts`** with a Zod input schema, a class with an `execute()` (or similarly-named) method, and JSDoc on the exported schema/class. Look at `backend/tools/StellarPaymentTool.ts` for the shape: exported `YourToolInputSchema`, an inferred `YourToolInput` type, and a class that validates its input with `YourToolInputSchema.parse(rawInput)` before doing anything else.
2. **Add a new task type** to the `TaskType` union in `backend/agent.ts` (e.g. `"your_task"`).
3. **Import and instantiate your tool** in the `PayFiAgent` constructor in `backend/agent.ts`, alongside the existing tool instances (`paymentTool`, `sorobanTool`, `x402Tool`, etc.).
4. **Add a `case "your_task":`** to the `switch` in `PayFiAgent.run()` (`backend/agent.ts`) that delegates to your tool's execute method, matching the existing cases (`"stellar_payment"`, `"soroban_invoke"`, `"x402_respond"`, ...).
5. **Add a mock for your tool** in every test file's `vi.mock("../backend/tools/YourTool")` block that exercises `agent.ts` (e.g. wherever `PayFiAgent`/`run()` is tested), so agent-level tests don't hit the real network.
6. **Create `tests/your_tool.test.ts`** covering input validation (schema edge cases), the happy path, and network/error handling — see `tests/payment.test.ts` for the expected level of coverage (validation, happy path, network errors, retry exhaustion, state verification).
7. **Add an entry to the README's [API Reference](./README.md#api-reference) table** (`TaskType` union and the `PayFiAgent` method table) describing the new task type.
8. **Update [ARCHITECTURE.md](./ARCHITECTURE.md)'s** tool list and task-routing diagram/description so the new tool shows up alongside the others.

---

## Automated Checks

All pull requests are automatically validated by GitHub Actions. The CI workflow (`.github/workflows/ci.yml`) runs:

- **Build**: Compiles TypeScript with `npm run build`
- **Lint**: Enforces code style with `npm run lint` and formatting with `npm run format:check`
- **Test**: Runs integration tests with `npm run test`
- **Test Rust**: Validates Soroban contracts with `cargo test`
- **Audit**: Checks for vulnerabilities in npm and Cargo dependencies

All jobs **must pass** before your PR can be merged.

---

## Code Formatting

This repo uses [Prettier](https://prettier.io/) to keep formatting consistent and diffs small. Configuration lives in `.prettierrc.json`; files listed in `.prettierignore` (build output, dependencies, generated docs, etc.) are excluded.

- `npm run format` — formats `backend/`, `tests/`, and `scripts/` TypeScript files in place.
- `npm run format:check` — verifies formatting without writing changes; this is what CI runs.

Run `npm run format` before committing to avoid CI failures.

---

## Running Tests in Docker

For a fast, isolated test run that doesn't require booting the full `agent` HTTP server, use the `test-only` Compose profile. It starts only `stellar-quickstart` and the test runner:

```bash
docker-compose --profile test-only up --build --abort-on-container-exit --exit-code-from test-runner-only
```

Use the `test` profile instead if you need the full stack (including the running `agent` service) for your test run:

```bash
docker-compose --profile test up --build
```

See the [README's Docker section](./README.md#docker) for more details.

---

## Test Conventions

### Global timer and spy cleanup

The file `tests/helpers/globalSetup.ts` is registered as a Vitest `setupFiles` entry in `vitest.config.ts`. It registers an `afterEach` hook that fires after **every** test in the suite:

```typescript
afterEach(() => {
  vi.useRealTimers();    // restore real timers after every test
  vi.restoreAllMocks();  // restore all spied/mocked functions
});
```

**What this means for you when writing tests:**

- You **do not** need to call `vi.useRealTimers()` or `vi.restoreAllMocks()` yourself in `afterEach` / `afterAll` — the global hook covers it.
- You **may still** call `vi.useFakeTimers()` inside an individual test or `beforeEach` block whenever you need controlled time. The global hook will clean up after the test completes.
- You **should not** add a bare `vi.useFakeTimers()` at the top level of a test file (outside a `beforeEach`) unless you also pair it with an explicit `afterEach(() => vi.useRealTimers())` — module-level calls run only once and can affect test ordering.

**Why the hook exists:**

Individual test files previously called `vi.useFakeTimers()` / `vi.restoreAllMocks()` inconsistently. When a file forgot to clean up, fake timer state leaked into the next file executed on the same worker thread, causing timing-sensitive tests (polling, retries, streams) to hang or behave non-deterministically. The global hook eliminates this class of flaky test.

---

## Local Git Hooks

This repository uses **Husky** to enforce code quality through local git hooks. These hooks run automatically before key git operations:

### Pre-Commit Hook (`.husky/pre-commit`)

Runs `scan-secrets.sh` to prevent accidental commits of sensitive data (API keys, private keys, etc.).

### Pre-Push Hook (`.husky/pre-push`)

**NEW**: Runs `npm test` automatically before allowing pushes to the remote repository.

This prevents broken tests from being pushed and failing only during CI checks. If your tests fail locally, the push is blocked with output showing which tests failed. Fix the failing tests and try pushing again.

**To bypass** (not recommended):
```bash
git push --no-verify
```

---

## Branch Protection Rules

Repository maintainers should enable the following branch protection rules on `main`:

1. **Require status checks to pass before merging**:
   - ✅ Build (TypeScript)
   - ✅ Lint
   - ✅ Test (TypeScript)
   - ✅ Test Rust Contracts
   - ✅ Audit

2. **Dismiss stale pull request approvals when new commits are pushed**

3. **Require a pull request review before merging** (recommended: 1 approval minimum)

**To configure**:
1. Go to **Settings** → **Branches** → **Branch protection rules**
2. Create a rule for `main`
3. Check:
   - "Require a pull request before merging"
   - "Require status checks to pass before merging"
   - "Require branches to be up to date before merging"
4. Add the CI job names to the status checks list

---

## Code Style

- **TypeScript**: Follow ESLint rules defined in `.eslintrc.cjs`
- **Rust**: Follow standard `cargo fmt` and Clippy recommendations
- **Env Access**: Always use `backend/config.ts` for environment variables, never `process.env` directly in tool code
- **Logging**: In `backend/` source files, always use the structured logger from `backend/utils/logger.ts` (via `createLogger`) instead of raw `console.log` or `console.error`. The `no-console` ESLint rule is enforced as an error for all files under `backend/**`, except `backend/logger.ts` itself (which is the logger implementation). Violating this rule will fail CI.

  ```typescript
  // ✅ Correct
  import { createLogger } from "../utils/logger";
  const log = createLogger("my-tool");
  log.info({ someField: "value" }, "Operation completed");

  // ❌ Forbidden in backend/ (ESLint error)
  console.log("Operation completed");
  ```

---

## Automated PR Labelling

Pull requests are automatically labelled by a GitHub Actions workflow (`.github/workflows/labeller.yml`) based on the file paths changed. This reduces triage effort for maintainers and helps contributors understand which theme their PR falls under.

| Files changed | Label applied |
|---|---|
| `backend/tools/**` | `tooling` |
| `backend/**` (non-tools) | `backend` |
| `contracts/**` | `smart-contracts` |
| `tests/**` | `testing` |
| `.github/**` | `ci-cd` |
| `docs/**`, `*.md` | `documentation` |
| `scripts/**` | `dx` |

Labels are defined in `.github/labeler.yml`. To add a new path-to-label mapping, open a PR editing that file.

---

## Release Process

Ledgera uses [Conventional Commits](https://www.conventionalcommits.org/) to automate changelog generation and GitHub Releases.

### How it works

1. **Version tags trigger the release workflow** (`.github/workflows/release.yml`).  
   Push a tag matching `v<major>.<minor>.<patch>` (or a pre-release like `v1.2.3-rc.1`) to `main`:
   ```bash
   git tag v1.2.3
   git push origin v1.2.3
   ```
2. The workflow runs `npm run changelog:update`, which prepends a new section to `CHANGELOG.md` from all conventional commits since the previous tag.
3. A GitHub Release is created automatically with the extracted changelog section as its body.
4. The updated `CHANGELOG.md` is committed back to `main` via a `[skip ci]` commit.

### Updating the changelog locally

To preview or manually update the changelog without pushing a tag:

```bash
npm run changelog:update
```

This appends new entries to `CHANGELOG.md` in place.  Review the diff and commit it if it looks correct:

```bash
git add CHANGELOG.md
git commit -m "chore(release): update CHANGELOG.md"
```

### Conventional Commits quick reference

| Prefix | Release type | Example |
|---|---|---|
| `fix:` | Patch | `fix(agent): handle missing nonce in x402 payload` |
| `feat:` | Minor | `feat(tools): add SponsoredAccountTool` |
| `feat!:` or `BREAKING CHANGE:` | Major | `feat!: remove deprecated TaskType aliases` |
| `chore:`, `docs:`, `test:`, `refactor:` | No release | `docs: update CONTRIBUTING.md` |

---

## Dependency Auditing

To check for vulnerabilities in dependencies:
- **npm dependencies**: `npm run audit`
- **Fix vulnerabilities**: `npm audit fix` (use with caution)
- **Rust dependencies**: `cargo audit` (requires `cargo-audit` to be installed)

---

## Security

- Never commit sensitive credentials (private keys, API tokens, etc.)
- All secrets must be managed via environment variables
- Refer to [backend/config.ts](./backend/config.ts) for the canonical vault of config validation

---

## Code of Conduct

We are committed to providing a welcoming and inclusive environment for all contributors. Please refer to [CODE_OF_CONDUCT.md](.github/CODE_OF_CONDUCT.md) for our full expectations. In summary:
- Be respectful and considerate of others
- Use inclusive language
- Accept constructive feedback gracefully
- Focus on what is best for the community

---

## Questions?

Open an issue on GitHub with the `question` label, and a maintainer will get back to you shortly.

---

Thank you for contributing to Ledgera! 🚀
