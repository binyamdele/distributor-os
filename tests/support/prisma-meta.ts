import { Prisma } from '@prisma/client';

/**
 * Prisma's runtime description of the schema.
 *
 * Exposed through test support so the tenancy and RBAC tests can assert against the *actual*
 * schema rather than a hand-maintained list. A list a developer has to remember to update is
 * exactly the thing that fails silently when a table is added in Phase 5.
 */
export interface ModelMeta {
  readonly name: string;
  readonly tableName: string;
  readonly fields: readonly string[];
}

export const MODELS: readonly ModelMeta[] = Prisma.dmmf.datamodel.models.map((model) => ({
  name: model.name,
  tableName: model.dbName ?? model.name,
  fields: model.fields.map((field) => field.name),
}));

/** The `Role` enum as the database defines it. */
export const PRISMA_ROLES: readonly string[] =
  Prisma.dmmf.datamodel.enums.find((e) => e.name === 'Role')?.values.map((v) => v.name) ?? [];

/** Any enum, by name, as the database defines it. */
export function prismaEnum(name: string): readonly string[] {
  return Prisma.dmmf.datamodel.enums.find((e) => e.name === name)?.values.map((v) => v.name) ?? [];
}

export const PRISMA_WAREHOUSE_TASK_STATUSES = prismaEnum('WarehouseTaskStatus');
export const PRISMA_DELIVERY_STATUSES = prismaEnum('DeliveryStatus');
export const PRISMA_DELIVERY_FAILURE_REASONS = prismaEnum('DeliveryFailureReason');

// Phase 7
export const PRISMA_DISCREPANCY_STATUSES = prismaEnum('DiscrepancyStatus');
export const PRISMA_DISCREPANCY_TYPES = prismaEnum('DiscrepancyType');
export const PRISMA_DISCREPANCY_RESOLUTIONS = prismaEnum('DiscrepancyResolution');
export const PRISMA_RETURN_STATUSES = prismaEnum('ReturnStatus');
export const PRISMA_RETURN_REASONS = prismaEnum('ReturnReason');
export const PRISMA_RETURN_DISPOSITIONS = prismaEnum('ReturnDisposition');
export const PRISMA_DELIVERY_FAILURE_RESOLUTIONS = prismaEnum('DeliveryFailureResolution');
export const PRISMA_MOVEMENT_TYPES = prismaEnum('InventoryMovementType');
