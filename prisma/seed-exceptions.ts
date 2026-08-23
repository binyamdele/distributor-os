/**
 * Phase 7 demo scenarios: inventory discrepancies, returns and delivery retries.
 *
 * Everything here is SYNTHETIC.
 *
 * Built on the Phase 6 scenarios, because the question Phase 7 answers is what happens when the
 * fulfilment flow goes wrong — and a discrepancy invented against no warehouse task, or a return
 * against no delivery, would demonstrate the screens while skipping the situations that produce
 * them.
 *
 * Written as rows for the same reason as the Phase 5 and 6 seeds: the seed connects as the
 * database owner and the modules require a tenant-scoped transaction and a signed-in actor. The
 * stock arithmetic is performed exactly as the module performs it — restock adds only the
 * sellable quantity, and nothing is written that the application would refuse to create.
 */
import type { PrismaClient } from '@prisma/client';
// The real rules, imported rather than restated. A seed that could produce a state the
// application refuses would be a demo teaching the opposite of the product.
import { assessInspection } from '../src/modules/inventory/returns-model';
import { assessReconciliation } from '../src/modules/inventory/discrepancy';

const MARKER = 'PHASE7-SCENARIO';

function hoursAgo(hours: number): Date {
  return new Date(Date.now() - hours * 3_600_000);
}

export const EXCEPTION_SCENARIO_NOTES = [
  'A — Physical shortage found while picking. The handoff is blocked until it is reconciled.',
  'B — Physical overage. A controlled positive correction, waiting for review.',
  'C — Counted below what is already committed. Cannot be recorded until a reservation gives way.',
  'D — Failed delivery, retried. A second attempt with no stock movement at all.',
  'E — Failed delivery returned intact. Every unit back on the sellable shelf.',
  'F — Failed delivery returned damaged. 4 units stay out of stock and stay in the record.',
  'G — Delivery written off. No stock returned, and the money that arrived stays arrived.',
  'H — A paid cash order whose goods never arrived. Financially settled, operationally open.',
];

/**
 * Unwinds the previous run.
 *
 * Called before the Phase 5 and 6 seeds rebuild their scenarios, for the same reason Phase 6's
 * unwind is: this data hangs off theirs, and the movement ledger and the resolved-discrepancy
 * trigger both refuse to be rewritten in place.
 */
export async function releaseExceptionScenarios(
  prisma: PrismaClient,
  organizationId: string,
): Promise<void> {
  const discrepancies = await prisma.inventoryDiscrepancy.findMany({
    where: { organizationId, reportNote: { startsWith: MARKER } },
    select: { id: true },
  });

  if (discrepancies.length > 0) {
    await prisma.$executeRawUnsafe(
      'ALTER TABLE inventory_discrepancies DISABLE TRIGGER inventory_discrepancies_resolved_immutable',
    );
    try {
      await prisma.inventoryDiscrepancy.deleteMany({
        where: { id: { in: discrepancies.map((row) => row.id) } },
      });
    } finally {
      await prisma.$executeRawUnsafe(
        'ALTER TABLE inventory_discrepancies ENABLE TRIGGER inventory_discrepancies_resolved_immutable',
      );
    }
  }

  /*
   * Every return in the demo organization, not only the ones this file labelled.
   *
   * Matching on the marker was wrong and Phase 9 found it: the E2E suite drives the real return
   * workflow through the UI against this same database, and those rows carry no marker. The
   * unwind skipped them, and the next seed hit the Phase 7 partial unique index — one live
   * return per delivery — and failed. Correctly, which is the only reason it was visible.
   *
   * The demo organization's rows all belong to the demo, however they were created, so the
   * unwind claims them all. It is also the same structural approach already used a few lines
   * below for retry deliveries, which never needed a marker either.
   */
  const returns = await prisma.return.findMany({
    where: { organizationId },
    include: { items: true },
  });

  for (const entry of returns) {
    // Take back what the previous run restocked, so re-seeding does not inflate the yard.
    if (entry.status === 'COMPLETED') {
      for (const item of entry.items) {
        if (!item.productId || item.quantityRestockable <= 0) continue;
        await prisma.product.update({
          where: { id: item.productId },
          data: { availableStock: { decrement: item.quantityRestockable } },
        });
      }
    }
  }

  if (returns.length > 0) {
    await prisma.returnItem.deleteMany({ where: { returnId: { in: returns.map((r) => r.id) } } });
    await prisma.return.deleteMany({ where: { id: { in: returns.map((r) => r.id) } } });
  }

  // The ledger is append-only for the application; the seed removes only its own rows, as the
  // owner, so a demo reset does not leave movements pointing at records that no longer exist.
  await prisma.inventoryMovement.deleteMany({
    where: { organizationId, reason: { contains: MARKER } },
  });

  // Retry attempts, and the resolutions recorded on the deliveries they came from.
  const retries = await prisma.delivery.findMany({
    where: { organizationId, retryOfDeliveryId: { not: null } },
    select: { id: true, retryOfDeliveryId: true },
  });
  if (retries.length > 0) {
    await prisma.delivery.deleteMany({ where: { id: { in: retries.map((r) => r.id) } } });
  }
  await prisma.delivery.updateMany({
    where: { organizationId, failureResolution: { not: null } },
    data: { failureResolution: null, resolvedById: null, resolvedAt: null },
  });

  await prisma.salesOrder.updateMany({
    where: { organizationId, operationalException: { not: null } },
    data: { operationalException: null, operationalExceptionNote: null },
  });
}

export async function seedExceptionScenarios(
  prisma: PrismaClient,
  organizationId: string,
  options: { warehouseUserId: string; managerUserId: string },
): Promise<number> {
  let sequence = 7000;
  let seeded = 0;

  const nextNumber = (prefix: string) => {
    sequence += 1;
    return `${prefix}-2026${String(sequence).padStart(5, '0')}`.slice(0, 12);
  };

  // --- A and B: counts against a task that is still being picked -------------
  const pickingTask = await prisma.warehouseTask.findFirst({
    where: { organizationId, status: { in: ['IN_PROGRESS', 'PREPARED'] } },
    include: { items: true, salesOrder: true },
    orderBy: { createdAt: 'asc' },
  });

  if (pickingTask?.items[0]?.productId) {
    const item = pickingTask.items[0];
    const product = await prisma.product.findUniqueOrThrow({ where: { id: item.productId! } });

    // A — a shortage, which blocks the handoff for that task.
    await prisma.inventoryDiscrepancy.create({
      data: {
        organizationId,
        discrepancyNumber: nextNumber('IR'),
        warehouseTaskId: pickingTask.id,
        salesOrderId: pickingTask.salesOrderId,
        productId: product.id,
        discrepancyType: 'PHYSICAL_SHORTAGE',
        status: 'OPEN',
        systemOnHandQuantity: product.availableStock,
        systemReservedQuantity: product.reservedStock,
        expectedTaskQuantity: item.quantityRequired,
        physicalCountQuantity: Math.max(0, product.availableStock - 40),
        varianceQuantity: Math.max(0, product.availableStock - 40) - product.availableStock,
        reportNote: `${MARKER} A — counted bay 3 twice, forty short.`,
        reportedById: options.warehouseUserId,
        reportedAt: hoursAgo(5),
      },
    });
    seeded += 1;
  }

  // B — an overage on an unrelated product, under review.
  const overageProduct = await prisma.product.findFirst({
    where: { organizationId, sku: 'HB-20' },
  });
  if (overageProduct) {
    await prisma.inventoryDiscrepancy.create({
      data: {
        organizationId,
        discrepancyNumber: nextNumber('IR'),
        productId: overageProduct.id,
        discrepancyType: 'PHYSICAL_OVERAGE',
        status: 'UNDER_REVIEW',
        systemOnHandQuantity: overageProduct.availableStock,
        systemReservedQuantity: overageProduct.reservedStock,
        physicalCountQuantity: overageProduct.availableStock + 10,
        varianceQuantity: 10,
        reportNote: `${MARKER} B — a pallet nobody had booked in.`,
        reportedById: options.warehouseUserId,
        reportedAt: hoursAgo(9),
        reviewedById: options.managerUserId,
        reviewedAt: hoursAgo(3),
      },
    });
    seeded += 1;
  }

  // --- C: counted below what is committed, so a reservation must give way ----
  const committed = await prisma.stockReservation.findFirst({
    where: { organizationId, status: 'ACTIVE' },
    include: { product: true },
    orderBy: { quantity: 'desc' },
  });

  if (committed) {
    const counted = Math.max(0, committed.quantity - 5);
    const activeTotal = await prisma.stockReservation.aggregate({
      where: { organizationId, productId: committed.productId, status: 'ACTIVE' },
      _sum: { quantity: true },
    });
    const shortfall = (activeTotal._sum.quantity ?? 0) - counted;

    if (shortfall > 0) {
      // Checked against the real rule before writing: this must be a state the module would
      // itself produce, which is a refusal-to-finalise carrying a recorded shortfall.
      const verdict = assessReconciliationRule({
        currentOnHand: committed.product.availableStock,
        currentReserved: activeTotal._sum.quantity ?? 0,
        physicalCount: counted,
      });

      await prisma.inventoryDiscrepancy.create({
        data: {
          organizationId,
          discrepancyNumber: nextNumber('IR'),
          productId: committed.productId,
          discrepancyType: 'PHYSICAL_SHORTAGE',
          status: 'UNDER_REVIEW',
          systemOnHandQuantity: committed.product.availableStock,
          systemReservedQuantity: committed.product.reservedStock,
          physicalCountQuantity: counted,
          varianceQuantity: counted - committed.product.availableStock,
          reservationShortfall: verdict.shortfall,
          reportNote: `${MARKER} C — verified count cannot cover what is promised.`,
          reportedById: options.warehouseUserId,
          reportedAt: hoursAgo(7),
          reviewedById: options.managerUserId,
          reviewedAt: hoursAgo(2),
        },
      });
      seeded += 1;
    }
  }

  // --- D to H: the post-handoff exceptions ----------------------------------
  /*
   * Stage the failures this phase needs.
   *
   * A delivery failing is the precondition for every post-handoff exception, and Phase 6 leaves
   * only one. Rather than inventing failed deliveries against no shipment, the seed takes runs
   * that genuinely left the yard and records them as failed — which is exactly the event, and
   * keeps every downstream record hanging off a real handover.
   */
  const onTheRoad = await prisma.delivery.findMany({
    where: { organizationId, status: { in: ['PENDING', 'ASSIGNED', 'DISPATCHED'] }, retryOfDeliveryId: null },
    orderBy: { createdAt: 'asc' },
  });

  const reasons = ['CUSTOMER_UNAVAILABLE', 'WRONG_ADDRESS', 'VEHICLE_ISSUE'] as const;
  for (const [index, delivery] of onTheRoad.slice(0, 3).entries()) {
    await prisma.delivery.update({
      where: { id: delivery.id },
      data: {
        status: 'FAILED',
        dispatchedAt: delivery.dispatchedAt ?? hoursAgo(12),
        failedAt: hoursAgo(10),
        failureReason: reasons[index % reasons.length],
        failureNote: 'Nobody at the gate; the load came back on the lorry.',
      },
    });
    await prisma.salesOrder.update({
      where: { id: delivery.salesOrderId },
      data: { operationalException: 'DELIVERY_FAILED' },
    });
  }

  const failed = await prisma.delivery.findMany({
    where: { organizationId, status: 'FAILED', retryOfDeliveryId: null },
    include: { salesOrder: true, warehouseTask: { include: { items: true } } },
    orderBy: { createdAt: 'asc' },
  });

  // D — retried. A new attempt, and demonstrably no stock movement.
  const retryTarget = failed[0];
  if (retryTarget) {
    await prisma.delivery.create({
      data: {
        organizationId,
        deliveryNumber: nextNumber('DL'),
        salesOrderId: retryTarget.salesOrderId,
        warehouseTaskId: retryTarget.warehouseTaskId,
        status: 'DISPATCHED',
        customerNameSnapshot: retryTarget.customerNameSnapshot,
        customerPhoneSnapshot: retryTarget.customerPhoneSnapshot,
        destinationTextSnapshot: retryTarget.destinationTextSnapshot,
        assignedDriverName: 'Getachew Alemu',
        assignedDriverPhone: '+251911000301',
        vehicleReference: 'AA-3-12345',
        assignedAt: hoursAgo(4),
        dispatchedAt: hoursAgo(2),
        retryOfDeliveryId: retryTarget.id,
        attemptNumber: retryTarget.attemptNumber + 1,
        createdAt: hoursAgo(4),
      },
    });
    await prisma.delivery.update({
      where: { id: retryTarget.id },
      data: {
        failureResolution: 'RETRY_DELIVERY',
        resolvedById: options.managerUserId,
        resolvedAt: hoursAgo(4),
      },
    });
    seeded += 1;
  }

  // E and F — returned intact, and returned damaged.
  const returnTargets = failed.slice(1, 3);
  for (const [index, delivery] of returnTargets.entries()) {
    const damaged = index === 0 ? 0 : 4;
    const taskItems = delivery.warehouseTask.items;
    if (taskItems.length === 0) continue;

    const returnNumber = nextNumber('RT');
    const created = await prisma.return.create({
      data: {
        organizationId,
        returnNumber,
        salesOrderId: delivery.salesOrderId,
        deliveryId: delivery.id,
        status: 'COMPLETED',
        returnReason: 'DELIVERY_FAILED',
        note: `${MARKER} ${index === 0 ? 'E' : 'F'} — came back ${damaged > 0 ? 'with breakages' : 'intact'}.`,
        receivedById: options.warehouseUserId,
        receivedAt: hoursAgo(6),
        inspectedById: options.warehouseUserId,
        inspectedAt: hoursAgo(5),
        completedAt: hoursAgo(4),
        createdById: options.managerUserId,
        createdAt: hoursAgo(8),
      },
    });

    for (const [lineIndex, item] of taskItems.entries()) {
      const lineDamaged = lineIndex === 0 ? Math.min(damaged, item.quantityRequired) : 0;
      const restockable = item.quantityRequired - lineDamaged;

      // The real inspection rule, so the seed cannot write a split that does not add up.
      const verdict = assessInspection({
        quantityDispatched: item.quantityRequired,
        quantityExpected: item.quantityRequired,
        quantityReceived: item.quantityRequired,
        quantityRestockable: restockable,
        quantityDamaged: lineDamaged,
      });
      if (!verdict.valid) {
        throw new Error(`seed return line would be refused: ${verdict.detail}`);
      }

      await prisma.returnItem.create({
        data: {
          organizationId,
          returnId: created.id,
          salesOrderItemId: item.salesOrderItemId,
          productId: item.productId,
          skuSnapshot: item.skuSnapshot,
          descriptionSnapshot: item.descriptionSnapshot,
          unitSnapshot: item.unitSnapshot,
          quantityDispatched: item.quantityRequired,
          quantityExpected: item.quantityRequired,
          quantityReceived: item.quantityRequired,
          quantityRestockable: restockable,
          quantityDamaged: lineDamaged,
          quantityMissing: verdict.quantityMissing,
          disposition: verdict.disposition,
        },
      });

      if (item.productId && restockable > 0) {
        const product = await prisma.product.update({
          where: { id: item.productId },
          data: { availableStock: { increment: restockable } },
        });
        await prisma.inventoryMovement.create({
          data: {
            organizationId,
            productId: item.productId,
            movementType: 'RETURN_RESTOCK',
            delta: restockable,
            stockAfter: product.availableStock,
            reason: `${MARKER} ${returnNumber}: returned from ${delivery.deliveryNumber}, inspected as sellable`,
            relatedOrderId: delivery.salesOrderId,
            relatedReturnId: created.id,
            actorId: options.warehouseUserId,
            createdAt: hoursAgo(4),
          },
        });
      }
    }

    await prisma.delivery.update({
      where: { id: delivery.id },
      data: {
        failureResolution: 'RETURNED_TO_WAREHOUSE',
        resolvedById: options.managerUserId,
        resolvedAt: hoursAgo(8),
      },
    });
    await prisma.salesOrder.update({
      where: { id: delivery.salesOrderId },
      data: {
        operationalException: 'GOODS_RETURNED',
        operationalExceptionNote: `Goods from ${delivery.deliveryNumber} came back on ${returnNumber}.`,
      },
    });
    seeded += 1;
  }

  // G and H — written off. No stock returns, and no payment is touched.
  const lossTarget = failed[3];
  if (lossTarget) {
    await prisma.delivery.update({
      where: { id: lossTarget.id },
      data: {
        failureResolution: 'LOST_OR_UNRECOVERABLE',
        resolvedById: options.managerUserId,
        resolvedAt: hoursAgo(3),
        failureNote: 'Vehicle broken into overnight; load gone.',
      },
    });
    await prisma.salesOrder.update({
      where: { id: lossTarget.salesOrderId },
      data: {
        operationalException: 'DELIVERY_LOST',
        operationalExceptionNote: 'Vehicle broken into overnight; load gone.',
      },
    });
    seeded += 1;
  }

  return seeded;
}

/**
 * The reconciliation rule, reduced to what the seed needs.
 *
 * Imported logic would be better still, but `assessReconciliation` takes a status the seed does
 * not have at that point. The shortfall arithmetic is the part that matters and it is the same
 * subtraction, kept here so the seeded figure cannot disagree with the one the module computes.
 */
function assessReconciliationRule(inputs: {
  currentOnHand: number;
  currentReserved: number;
  physicalCount: number;
}): { shortfall: number } {
  const verdict = assessReconciliation({
    status: 'UNDER_REVIEW',
    currentOnHand: inputs.currentOnHand,
    currentReserved: inputs.currentReserved,
    physicalCount: inputs.physicalCount,
    reportedSystemOnHand: inputs.currentOnHand,
  });
  return { shortfall: verdict.reservationShortfall };
}
