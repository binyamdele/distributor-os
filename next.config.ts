import type { NextConfig } from 'next';

const config: NextConfig = {
  reactStrictMode: true,
  /*
   * Standalone output, for the container image only.
   *
   * It traces the dependencies the server actually reaches for and copies them beside a minimal
   * server.js — no build toolchain, no source, no dev dependencies. Smaller attack surface and a
   * faster cold start.
   *
   * Conditional because producing it requires creating symlinks, which Windows refuses without
   * developer mode. Unconditional, every local build on Windows would emit an EPERM warning it
   * cannot act on — and a warning nobody can fix is a warning everybody learns to ignore. The
   * Dockerfile sets NEXT_STANDALONE=1, and its build runs on Linux where symlinks are ordinary.
   */
  ...(process.env.NEXT_STANDALONE === '1' ? { output: 'standalone' as const } : {}),
  // The database layer is server-only; nothing in it may be bundled for the browser.
  serverExternalPackages: ['@prisma/client'],
  eslint: {
    dirs: ['src', 'prisma', 'tests'],
  },
};

export default config;
