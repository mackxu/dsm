import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@dsm/core': new URL('./packages/core/src/index.ts', import.meta.url).pathname,
      '@dsm/desktop-runtime': new URL(
        './packages/desktop-runtime/src/index.ts',
        import.meta.url,
      ).pathname,
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    restoreMocks: true,
  },
});
