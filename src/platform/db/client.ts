import 'server-only';
import { PrismaClient } from '@prisma/client';

/**
 * The raw, unscoped Prisma client.
 *
 * Nothing outside `src/platform/db` may import this, and an ESLint rule enforces that. It is
 * unscoped by construction: a query issued through it sees every organization's rows. Business
 * code goes through `withTenant()` instead, which injects the organization filter and sets the
 * RLS session variable.
 *
 * The only legitimate unscoped callers are authentication (finding a user by email, before any
 * organization is known) and the seed script.
 */
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma: PrismaClient =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
  });

// Next.js hot-reloads modules in development; without this, every reload opens a new pool.
if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;

export type { PrismaClient };
