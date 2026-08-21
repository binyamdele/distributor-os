import { randomUUID } from 'node:crypto';
import { withTenant } from '@/platform/db';
import { createFromQuotation } from '@/modules/orders';
import { setFileStoreOverride } from '@/platform/storage';
import type { FileMetadata, FileStore, PutInput, StoredFile } from '@/platform/storage';
import { createHash } from 'node:crypto';
import type { ActorContext } from '@/platform/context';
import { owner } from './fixtures';
import { sentQuotation } from './order-fixtures';

/**
 * An in-memory FileStore for tests.
 *
 * Keeps evidence out of the working tree, and makes "was this actually written" and "did the
 * bytes change" directly assertable. It implements the same interface the local-disk store
 * does, so the payment module cannot tell the difference.
 */
export class MemoryFileStore implements FileStore {
  readonly name = 'memory';
  readonly objects = new Map<string, { bytes: Uint8Array; mimeType: string }>();

  async put(input: PutInput): Promise<StoredFile> {
    const key = `${input.organizationId}/${randomUUID()}`;
    this.objects.set(key, { bytes: input.bytes, mimeType: input.mimeType });
    return {
      key,
      contentHash: createHash('sha256').update(input.bytes).digest('hex'),
      sizeBytes: input.bytes.byteLength,
      mimeType: input.mimeType,
    };
  }

  async getMetadata(key: string): Promise<FileMetadata | null> {
    const object = this.objects.get(key);
    if (!object) return null;
    return {
      key,
      sizeBytes: object.bytes.byteLength,
      contentHash: createHash('sha256').update(object.bytes).digest('hex'),
    };
  }

  async read(key: string): Promise<Uint8Array | null> {
    return this.objects.get(key)?.bytes ?? null;
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }
}

export function useMemoryFileStore(): MemoryFileStore {
  const store = new MemoryFileStore();
  setFileStoreOverride(store);
  return store;
}

export function restoreFileStore(): void {
  setFileStoreOverride(null);
}

/**
 * Walks an accepted quotation all the way to an open sales order.
 *
 * Goes through the real Phase 2, 3 and 4 functions rather than inserting an order row, so a
 * Phase 5 test is exercising an order that actually came from the workflow — including the
 * stock reservation, which is what makes the cash-order readiness question meaningful.
 */
export async function openOrder(
  organizationId: string,
  context: ActorContext,
  options: {
    message?: string;
    companyName?: string;
    paymentType?: 'CASH' | 'CREDIT';
    paymentTermsDays?: number;
    seedProducts?: boolean;
  } = {},
): Promise<{ orderId: string; orderNumber: string; grandTotalMinor: bigint; customerId: string }> {
  const quotation = await sentQuotation(organizationId, context, {
    accept: true,
    message: options.message ?? '10 bags OPC cement',
    companyName: options.companyName ?? 'ABC Construction PLC',
    paymentType: options.paymentType,
    paymentTermsDays: options.paymentTermsDays,
    seedProducts: options.seedProducts,
  });

  const created = await withTenant(organizationId, (tx) =>
    createFromQuotation(tx, context, { quotationId: quotation.quotationId }),
  );
  if (!created.ok) throw new Error(`order creation failed: ${created.error.message}`);

  const order = await owner.salesOrder.findUniqueOrThrow({ where: { id: created.value.id } });

  return {
    orderId: order.id,
    orderNumber: order.orderNumber,
    grandTotalMinor: order.grandTotalMinor,
    customerId: quotation.customerId,
  };
}

/** Backdates a credit order's due date, so a receivable is overdue without waiting. */
export async function backdateDueDate(orderId: string, daysAgo: number): Promise<void> {
  const due = new Date();
  due.setUTCDate(due.getUTCDate() - daysAgo);
  due.setUTCHours(0, 0, 0, 0);
  await owner.salesOrder.update({ where: { id: orderId }, data: { paymentDueDate: due } });
}
