import 'server-only';

export { prisma } from './client';
export {
  CrossTenantAccessError,
  EXTENSION_SCOPED_ONLY_MODELS,
  INTENTIONALLY_GLOBAL_MODELS,
  TENANT_SCOPED_MODELS,
  tenantClient,
  tenantExtension,
  withTenant,
} from './tenant';
export type { TenantClient, TenantTransaction } from './tenant';
