import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // blog/ is a separate deployable (the Octypo Astro blog) but its logic is
    // plain TypeScript, so it runs in the same suite — one `npm test` gate.
    // admin/ is the Studio SPA; only its pure logic is tested here, for the
    // same reason: a guard that protects a client-facing document should not
    // sit outside the gate that runs before a deploy.
    include: [
      'src/**/*.test.ts',
      'test/**/*.test.ts',
      'blog/src/**/*.test.ts',
      'blog/test/**/*.test.ts',
      'admin/src/**/*.test.ts',
    ],
    environment: 'node',
    // The pipeline is money-spending and customer-facing; a hanging test is a
    // failing test, not a stalled CI run.
    testTimeout: 10_000,
  },
});
