import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export const testAlias = {
  '@': fileURLToPath(new URL('./src', import.meta.url)),
  // `server-only` throws by design when imported outside a React Server Component. That guard
  // is for the bundler; under Node it would simply stop the tests from importing the modules
  // they exist to test.
  'server-only': fileURLToPath(new URL('./tests/support/server-only-stub.ts', import.meta.url)),
};

export default defineConfig({
  resolve: { alias: testAlias },
});
