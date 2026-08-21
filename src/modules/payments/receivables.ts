import 'server-only';
import type { TenantTransaction } from '@/platform/db';
import { summariseBalance } from './balance';

/**
 * Receivables and collections priority.
 *
 * Everything here is **derived at query time** from `payment_due_date` and confirmed payments.
 * Nothing schedules a job to mark an order overdue, and no status column drifts out of date
 * overnight — an order is overdue because today is past its due date, which is a fact a query
 * can establish more reliably than a cron entry.
 *
 * The outstanding figure is `order total − Σ CONFIRMED payments`, never a typed "remaining
 * balance" and never anything a model produced.
 */

export type DueBucket = 'OVERDUE' | 'DUE_TODAY' | 'DUE_SOON' | 'NOT_DUE';

/** Within how many days a receivable counts as due soon. */
export const DUE_SOON_DAYS = 7;

export function daysBetweenDates(from: Date, to: Date): number {
  const a = Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate());
  const b = Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate());
  return Math.round((b - a) / (24 * 60 * 60 * 1000));
}

export function bucketFor(dueDate: Date | null, now: Date = new Date()): DueBucket {
  if (!dueDate) return 'NOT_DUE';
  const days = daysBetweenDates(now, dueDate);
  if (days < 0) return 'OVERDUE';
  if (days === 0) return 'DUE_TODAY';
  if (days <= DUE_SOON_DAYS) return 'DUE_SOON';
  return 'NOT_DUE';
}

/** Days past the due date. Zero when not yet due — never negative. */
export function daysOverdue(dueDate: Date | null, now: Date = new Date()): number {
  if (!dueDate) return 0;
  return Math.max(0, daysBetweenDates(dueDate, now));
}

export interface ReceivableRow {
  readonly orderId: string;
  readonly orderNumber: string;
  readonly customerId: string;
  readonly customerName: string;
  readonly customerPhone: string | null;
  readonly currency: string;
  readonly orderTotalMinor: bigint;
  readonly confirmedMinor: bigint;
  readonly outstandingMinor: bigint;
  readonly dueDate: Date | null;
  readonly bucket: DueBucket;
  readonly daysOverdue: number;
  readonly paymentTermsDays: number;
  readonly paymentType: string;
  /** Whoever raised the order — the person to chase with. */
  readonly ownerId: string | null;
}

/**
 * Sorting, deliberately dull.
 *
 * Overdue first, then by how long overdue, then by size. No model ranks this: a collections
 * list a finance clerk cannot predict is a list they will stop trusting, and "oldest and largest
 * first" is what they would do anyway.
 */
const BUCKET_ORDER: Readonly<Record<DueBucket, number>> = {
  OVERDUE: 0,
  DUE_TODAY: 1,
  DUE_SOON: 2,
  NOT_DUE: 3,
};

export function prioritise(rows: readonly ReceivableRow[]): ReceivableRow[] {
  return [...rows].sort((a, b) => {
    if (BUCKET_ORDER[a.bucket] !== BUCKET_ORDER[b.bucket]) {
      return BUCKET_ORDER[a.bucket] - BUCKET_ORDER[b.bucket];
    }
    if (a.daysOverdue !== b.daysOverdue) return b.daysOverdue - a.daysOverdue;
    if (a.outstandingMinor !== b.outstandingMinor) {
      return a.outstandingMinor > b.outstandingMinor ? -1 : 1;
    }
    return a.orderNumber.localeCompare(b.orderNumber);
  });
}

export async function receivables(
  tx: TenantTransaction,
  options: { now?: Date; buckets?: readonly DueBucket[] } = {},
): Promise<ReceivableRow[]> {
  const now = options.now ?? new Date();

  const orders = await tx.salesOrder.findMany({
    where: { status: 'OPEN' },
    include: {
      customer: { select: { id: true, companyName: true, phone: true } },
      payments: { where: { status: 'CONFIRMED' }, select: { amountConfirmedMinor: true } },
    },
    take: 500,
  });

  const rows = orders
    .map((order) => {
      const balance = summariseBalance(
        order.grandTotalMinor,
        order.payments.map((payment) => ({
          amountConfirmedMinor: payment.amountConfirmedMinor ?? 0n,
        })),
        order.currency,
      );

      return {
        orderId: order.id,
        orderNumber: order.orderNumber,
        customerId: order.customer.id,
        customerName: order.customer.companyName,
        customerPhone: order.customer.phone,
        currency: order.currency,
        orderTotalMinor: order.grandTotalMinor,
        confirmedMinor: balance.confirmedMinor,
        outstandingMinor: balance.outstandingMinor,
        dueDate: order.paymentDueDate,
        bucket: bucketFor(order.paymentDueDate, now),
        daysOverdue: daysOverdue(order.paymentDueDate, now),
        paymentTermsDays: order.paymentTermsDays,
        paymentType: order.paymentType,
        ownerId: order.createdById,
      } satisfies ReceivableRow;
    })
    // Settled orders are not receivables. An overpaid one is not either.
    .filter((row) => row.outstandingMinor > 0n)
    .filter((row) => !options.buckets || options.buckets.includes(row.bucket));

  return prioritise(rows);
}

export interface CustomerOutstanding {
  readonly customerId: string;
  readonly customerName: string;
  readonly currency: string;
  readonly outstandingMinor: bigint;
  readonly overdueMinor: bigint;
  readonly orderCount: number;
}

/** Outstanding by customer, so a collections call covers everything at once. */
export function aggregateByCustomer(rows: readonly ReceivableRow[]): CustomerOutstanding[] {
  const byCustomer = new Map<string, CustomerOutstanding>();

  for (const row of rows) {
    const existing = byCustomer.get(row.customerId);
    byCustomer.set(row.customerId, {
      customerId: row.customerId,
      customerName: row.customerName,
      currency: row.currency,
      outstandingMinor: (existing?.outstandingMinor ?? 0n) + row.outstandingMinor,
      overdueMinor:
        (existing?.overdueMinor ?? 0n) + (row.bucket === 'OVERDUE' ? row.outstandingMinor : 0n),
      orderCount: (existing?.orderCount ?? 0) + 1,
    });
  }

  return [...byCustomer.values()].sort((a, b) =>
    a.outstandingMinor > b.outstandingMinor ? -1 : a.outstandingMinor < b.outstandingMinor ? 1 : 0,
  );
}
