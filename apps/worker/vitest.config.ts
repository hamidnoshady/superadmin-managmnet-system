import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    server: {
      deps: {
        // Vitest's builtin list predates node:sqlite — keep all node: builtins external.
        external: [/^node:/],
      },
    },
  },
});
