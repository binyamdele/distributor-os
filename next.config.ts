import type { NextConfig } from 'next';

const config: NextConfig = {
  reactStrictMode: true,
  // The database layer is server-only; nothing in it may be bundled for the browser.
  serverExternalPackages: ['@prisma/client'],
  eslint: {
    dirs: ['src', 'prisma', 'tests'],
  },
};

export default config;
