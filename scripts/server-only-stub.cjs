/**
 * Lets a CLI script import modules marked `server-only`.
 *
 * `server-only` is a package whose entire body is `throw new Error(...)`. Next.js swaps it for a
 * harmless stub when it bundles for the server, so the throw only ever fires if a module marked
 * server-only ends up in a client bundle. That is exactly the guard rail we want in application
 * code and exactly the wrong behaviour in `tsx`, which has no such swap and simply hits the
 * throw.
 *
 * So the admin and ops scripts preload this, which resolves `server-only` to an empty module.
 * The alternative would be dropping the marker from `@/platform/db` and friends — trading a real
 * protection on the code that ships for the convenience of the code that does not.
 *
 * The test suite solves the same problem the same way, via an alias in `vitest.config.ts`.
 *
 * CommonJS on purpose: it has to be loaded with `--require`, before any ESM resolution happens.
 */
const Module = require('node:module');

const originalResolve = Module._resolveFilename;

Module._resolveFilename = function resolveFilename(request, ...rest) {
  if (request === 'server-only' || request === 'client-only') {
    return require.resolve('./server-only-empty.cjs');
  }
  return originalResolve.call(this, request, ...rest);
};
