import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Windows runners (and the PowerShell-backed secret store) can take
    // seconds per operation — never let slowness masquerade as a test failure.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
