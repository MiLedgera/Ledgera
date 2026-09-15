/**
 * vitest.config.ts
 *
 * Vitest configuration for Ledgera.
 *
 * ## Key Configuration Details:
 *
 * ### isolate: true
 * Each test file runs in a completely isolated V8 context. This provides three benefits:
 * 1. **Mock isolation**: Mocks defined in one test file cannot leak into another test file.
 * 2. **Global state isolation**: Global variables, timers, and other state are reset per file.
 * 3. **Thread safety**: Each isolation runs in its own worker thread, enabling true parallel test execution.
 *
 * In practice, this means if test A patches `StellarPaymentTool.execute()`, that patch
 * will not affect test B — even though both import and mock the same module. This is critical
 * for preventing flaky tests in a suite with many concurrent test files.
 *
 * ### Coverage Configuration
 * Coverage is measured using the V8 engine (the default and most reliable provider).
 * - include: Only the `backend` TypeScript files are instrumented for coverage.
 * - **exclude**: `config.ts` and `agent.ts` are excluded because:
 *   - `config.ts` is entirely mocked in all tests (coverage would be misleading).
 *   - `agent.ts` is a thin orchestrator that delegates to tools; its logic is tested
 *     indirectly through tool tests, and including it would inflate line-count metrics.
 * - **reporters**: Three formats are generated:
 *   - `text`: Human-readable summary in the terminal.
 *   - `lcov`: Machine-readable format (consumed by CI/CD tools and IDEs).
 *   - `html`: Interactive HTML report in `./coverage/index.html`.
 * - **thresholds**: Enforce minimum coverage to prevent regression:
 *   - `lines: 80` — At least 80% of lines must be executed.
 *   - `functions: 80` — At least 80% of functions must be called.
 *   - `branches: 70` — At least 70% of conditional branches must be taken (slightly relaxed for complexity).
 *   - `statements: 80` — At least 80% of statements must be executed.
 *
 * If a test run fails to meet these thresholds, the build will exit with status 1.
 *
 * ### Other Critical Settings
 * - **restoreMocks: true**: After each test, `vi.restoreAllMocks()` is called,
 *   restoring mocked modules to their original implementations.
 * - **clearMocks: true**: After each test, mock call history and instances are reset,
 *   preventing mock state from leaking between tests.
 * - **testTimeout: 15_000**: Tests have 15 seconds to complete. This is generous
 *   to accommodate polling-based tests (e.g., SorobanInvokeTool polling for tx confirmation).
 */

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Discover all test files under tests/ (excludes e2e — use npm run test:e2e)
    include: ["tests/**/*.test.ts"],
    exclude: ["tests/e2e/**"],
    // Each test file runs in its own isolated context — prevents mock bleed
    isolate: true,
    // Global setup file: enforces vi.useRealTimers() + vi.restoreAllMocks() after every
    // test to prevent fake timer and spy state from leaking across test files.
    // See tests/helpers/globalSetup.ts for the full rationale.
    setupFiles: ["./tests/helpers/globalSetup.ts"],
    // restoreMocks: true automatically calls vi.restoreAllMocks() after every test to restore original implementations
    restoreMocks: true,
    // clearMocks: true automatically resets mock.calls, mock.instances, etc. between tests so call history doesn't bleed
    clearMocks: true,
    // Global test timeout (ms) — generous for polling tests
    testTimeout: 15_000,
    // Coverage configuration (used by test:ts:coverage)
    coverage: {
      provider: "v8",
      include: ["backend/**/*.ts"],
      exclude: [
        "backend/config.ts", // config module is mocked in all tests
        "backend/agent.ts"   // thin orchestrator, excluded from coverage thresholds
      ],
      reporter: ["text", "lcov", "html"],
      reportsDirectory: "./coverage",
      // Enforce minimum coverage thresholds to prevent regression
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 70,
        statements: 80
      }
    },
  },
});
