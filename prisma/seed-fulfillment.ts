/**
 * Phase 6 demo scenarios: warehouse fulfilment and delivery.
 *
 * Everything here is SYNTHETIC, including the driver names and vehicle plates.
 *
 * These scenarios build on the Phase 5 orders rather than creating new ones, because the
 * question Phase 6 answers is what happens to an order *after* it clears its payment gate. An
 * order invented here with `paymentStatus` stamped on it would demonstrate the warehouse
 * workflow while quietly bypassing the gate that decides who reaches it — which is the one
 * thing worth showing.
 *
 * Written as rows rather than driven through the module functions, for the same reason as the
 * Phase 5 seed: the seed connects as the database owner and the modules require a tenant-scoped
 * transaction and a signed-in actor. The stock arithmetic below is therefore performed exactly
 * as `completeWarehouseTask` performs it — both figures together, reservations to CONSUMED — so
 * the demo data satisfies the same invariants the application maintains.
 */
import type { PrismaClient } from '@prisma/client';
// The real eligibility rule, imported rather than restated. A seed that could produce a state
// the application refuses to create would be a demo teaching the opposite of the product.
import { assessEligibility } from '../src/modules/fulfillment/state';

interface Scenario {
  key: string;
  note: string;
  /** Which Phase 5 scenario's order to build on, by its `PHASE5-SCENARIO <key>` marker. */
  fromPaymentScenario: string;
  deliveryRequired: boolean;
  /**
   * Put the order on credit terms before building on it.
   *
   * Needed because most Phase 5 scenarios are deliberately *unpaid* cash orders — that is what
   * they exist to show — and an unpaid cash order must never reach the warehouse. Rather than
   * stamping READY onto one and pretending, the seed puts it on the terms that make it
   * genuinely eligible, which is a decision a distributor makes every day. Every scenario that
   * raises a task is then checked against the real `assessEligibility` before anything is
   * written, so this file cannot produce a state the application would refuse to create.
   */
  onCreditTerms?: boolean;
  /** How far to take it. */
  stage:
    | 'NO_TASK'
    | 'PENDING'
    | 'IN_PROGRESS'
    | 'PREPARED'
    | 'HANDED_OVER'
    | 'DISPATCHED'
    | 'DELIVERED'
    | 'FAILED'
    | 'PICKED_UP';
  /** Break a reservation on purpose, so the blocked-completion path is visible. */
  breakReservation?: number;
  driver?: { name: string; phone: string; vehicle: string };
  failureReason?: 'CUSTOMER_UNAVAILABLE' | 'WRONG_ADDRESS' | 'VEHICLE_ISSUE' | 'CUSTOMER_REJECTED' | 'OTHER';
}

/**
 * Ten situations a yard actually meets.
 *
 * Chosen so that every branch of the handoff and every delivery outcome is visible without
 * anyone having to construct one — including the three that are easy to forget: an order the
 * warehouse must not be able to touch, a reservation that no longer adds up, and a delivery
 * that failed with the goods still out there.
 */
const SCENARIOS: Scenario[] = [
  {
    key: 'A',
    note: 'A — Paid cash order, ready for the warehouse. Nothing raised yet; press "Send to warehouse".',
    fromPaymentScenario: 'E',
    deliveryRequired: true,
    stage: 'NO_TASK',
  },
  {
    key: 'B',
    note: 'B — Partly paid cash order. Does not appear in the warehouse list at all, and cannot be sent there.',
    fromPaymentScenario: 'F',
    deliveryRequired: true,
    stage: 'NO_TASK',
  },
  {
    key: 'C',
    note: 'C — Credit order with nothing paid, waiting to be picked. Terms were already granted, so the yard may start.',
    fromPaymentScenario: 'I',
    deliveryRequired: true,
    stage: 'PENDING',
  },
  {
    key: 'D',
    note: 'D — Being picked right now. The order cannot be cancelled while this is open.',
    fromPaymentScenario: 'J',
    deliveryRequired: true,
    stage: 'IN_PROGRESS',
  },
  {
    key: 'E',
    note: 'E — Picked and waiting by the door. No stock has moved yet — that happens at handoff.',
    fromPaymentScenario: 'K',
    onCreditTerms: true,
    deliveryRequired: false,
    stage: 'PREPARED',
  },
  {
    key: 'F',
    note: 'F — Reservation mismatch. Completion is blocked and names the product and both quantities.',
    fromPaymentScenario: 'C',
    onCreditTerms: true,
    deliveryRequired: false,
    stage: 'PREPARED',
    breakReservation: 5,
  },
  {
    key: 'G',
    note: 'G — Handed over, delivery waiting for a driver. Stock has been consumed and the reservation closed.',
    fromPaymentScenario: 'B',
    onCreditTerms: true,
    deliveryRequired: true,
    stage: 'HANDED_OVER',
  },
  {
    key: 'H',
    note: 'H — Out for delivery. Mark it delivered to complete the order.',
    fromPaymentScenario: 'D',
    onCreditTerms: true,
    deliveryRequired: true,
    stage: 'DISPATCHED',
    driver: { name: 'Getachew Alemu', phone: '+251911000301', vehicle: 'AA-3-12345' },
  },
  {
    key: 'I',
    note: 'I — Failed delivery. The goods are still out there; nothing was returned to stock.',
    fromPaymentScenario: 'G',
    onCreditTerms: true,
    deliveryRequired: true,
    stage: 'FAILED',
    driver: { name: 'Meseret Tadesse', phone: '+251911000302', vehicle: 'AA-3-67890' },
    failureReason: 'WRONG_ADDRESS',
  },
  {
    key: 'K',
    note: 'K — Handed over and out on the road. The load Phase 7 uses to show a write-off.',
    fromPaymentScenario: 'A',
    onCreditTerms: true,
    deliveryRequired: true,
    stage: 'DISPATCHED',
    driver: { name: 'Tigist Bekele', phone: '+251911000303', vehicle: 'AA-3-24680' },
  },
  {
    key: 'J',
    note: 'J — Collected by the customer. Completed with no delivery record at all.',
    fromPaymentScenario: 'H',
    onCreditTerms: true,
    deliveryRequired: false,
    stage: 'PICKED_UP',
  },
];

function hoursAgo(hours: number): Date {
  return new Date(Date.now() - hours * 3_600_000);
}

const MARKER = 'PHASE6-SCENARIO';

/**
 * Unwinds the previous run's Phase 6 scenarios.
 *
 * Exported and called *before* the Phase 5 seed rather than at the start of this one, because
 * the Phase 5 seed deletes its scenario orders and their reservations — and a CONSUMED
 * reservation refuses to be deleted. The ordering is the fix: Phase 6 puts the goods back on
 * the shelf, then Phase 5 rebuilds its orders, then Phase 6 walks them out again.
 *
 * A CONSUMED reservation is immutable by trigger, and the trigger is right: it is the only
 * record that specific goods left against a specific order. Resetting a demo is the one
 * legitimate exception, so it is taken deliberately, narrowed to this table, and restored in a
 * finally — rather than by weakening the trigger for everyone.
 */
export async function releaseFulfillmentScenarios(
  prisma: PrismaClient,
  organizationId: string,
): Promise<void> {
  const existing = await prisma.warehouseTask.findMany({
    where: { organizationId, notes: { startsWith: MARKER } },
    select: { id: true, salesOrderId: true },
  });
  if (existing.length === 0) return;

  {
    const taskIds = existing.map((task) => task.id);
    const orderIds = existing.map((task) => task.salesOrderId);

    await prisma.delivery.deleteMany({ where: { warehouseTaskId: { in: taskIds } } });
    await prisma.warehouseTaskItem.deleteMany({ where: { warehouseTaskId: { in: taskIds } } });
    await prisma.warehouseTask.deleteMany({ where: { id: { in: taskIds } } });

    await prisma.$executeRawUnsafe(
      'ALTER TABLE stock_reservations DISABLE TRIGGER stock_reservations_consumed_immutable',
    );
    try {
      // Put the consumed stock back, so re-seeding does not walk the yard down to nothing.
      const consumed = await prisma.stockReservation.findMany({
        where: { salesOrderId: { in: orderIds }, status: 'CONSUMED' },
      });
      for (const reservation of consumed) {
        await prisma.product.update({
          where: { id: reservation.productId },
          data: {
            availableStock: { increment: reservation.quantity },
            reservedStock: { increment: reservation.quantity },
          },
        });
        await prisma.stockReservation.update({
          where: { id: reservation.id },
          data: { status: 'ACTIVE', releasedAt: null },
        });
      }
    } finally {
      await prisma.$executeRawUnsafe(
        'ALTER TABLE stock_reservations ENABLE TRIGGER stock_reservations_consumed_immutable',
      );
    }

    // The ledger rows this seed wrote. Removed as the owner, so a demo reset does not leave
    // movements pointing at shipments that no longer exist.
    await prisma.inventoryMovement.deleteMany({
      where: { organizationId, reason: { contains: MARKER } },
    });

    await prisma.salesOrder.updateMany({
      where: { id: { in: orderIds } },
      data: { status: 'OPEN', completedAt: null, pickedUpAt: null, pickedUpById: null, pickupNote: null },
    });
  }
}

export async function seedFulfillmentScenarios(
  prisma: PrismaClient,
  organizationId: string,
  options: { warehouseUserId: string; managerUserId: string },
): Promise<number> {
  let sequence = 6000;
  let seeded = 0;

  for (const scenario of SCENARIOS) {
    const order = await prisma.salesOrder.findFirst({
      where: {
        organizationId,
        quotation: { internalNotes: `PHASE5-SCENARIO ${scenario.fromPaymentScenario}` },
      },
      include: { customer: true, items: true },
    });
    if (!order) continue;

    if (order.deliveryRequired !== scenario.deliveryRequired) {
      await prisma.salesOrder.update({
        where: { id: order.id },
        data: {
          deliveryRequired: scenario.deliveryRequired,
          deliveryAddressSnapshot: scenario.deliveryRequired
            ? (order.customer.address ?? 'Addis Ababa')
            : null,
        },
      });
    }

    if (scenario.stage === 'NO_TASK') {
      seeded += 1;
      continue;
    }

    /*
     * Make the order genuinely eligible, then prove it.
     *
     * Most Phase 5 scenarios are unpaid cash orders on purpose, and an unpaid cash order must
     * never appear on a warehouse floor. Putting one on credit terms is a real commercial
     * decision with a real consequence — the goods go out and the money is chased later — and
     * it is the honest way to get a fulfillable order out of one that is not.
     *
     * The assertion below is the point of the exercise. It runs the same `assessEligibility`
     * the application runs, so this file cannot write a warehouse task the product would have
     * refused to create. A seed that could do that would be demonstrating the opposite of what
     * the phase is about.
     */
    let readiness = {
      status: order.status,
      paymentStatus: order.paymentStatus,
      fulfillmentStatus: order.fulfillmentStatus,
      paymentType: order.paymentType as 'CASH' | 'CREDIT',
    };

    if (scenario.onCreditTerms) {
      const fallbackDue = new Date();
      fallbackDue.setUTCDate(fallbackDue.getUTCDate() + 30);
      fallbackDue.setUTCHours(0, 0, 0, 0);

      /*
       * Preserve what Phase 5 set up.
       *
       * An earlier version overwrote the due date unconditionally, which quietly erased the
       * 24-days-overdue order the receivables demo is built on — the collections list went from
       * having a top entry to having none. Phase 6 is a layer on top of those scenarios and has
       * no business rewriting their commercial terms.
       *
       * Payment status is preserved for the same reason: an order with confirmed part payment
       * stays PARTIALLY_PAID. Only an order with nothing confirmed becomes NOT_REQUIRED_YET,
       * which is what Phase 4 writes for a fresh credit order.
       */
      const nothingConfirmed =
        order.paymentStatus === 'UNPAID' || order.paymentStatus === 'NOT_REQUIRED_YET';
      const paymentStatus = nothingConfirmed ? 'NOT_REQUIRED_YET' : order.paymentStatus;

      await prisma.salesOrder.update({
        where: { id: order.id },
        data: {
          paymentType: 'CREDIT',
          paymentTermsDays: order.paymentTermsDays > 0 ? order.paymentTermsDays : 30,
          paymentDueDate: order.paymentDueDate ?? fallbackDue,
          // The two columns Phase 4 writes at conversion for a credit order. Nothing here marks
          // anything paid.
          paymentStatus,
          fulfillmentStatus: 'READY',
        },
      });
      readiness = {
        ...readiness,
        paymentType: 'CREDIT',
        paymentStatus,
        fulfillmentStatus: 'READY',
      };
    }

    const reserved = order.items.filter((item) => item.reservedQuantity > 0);
    const verdict = assessEligibility(readiness, reserved.length);
    if (!verdict.eligible) {
      throw new Error(
        `seed scenario ${scenario.key} would create a warehouse task the application refuses: ${verdict.refusal} — ${verdict.detail}`,
      );
    }

    sequence += 1;
    const suffix = String(sequence).padStart(5, '0');
    const reservedLines = reserved;

    const picking = scenario.stage !== 'PENDING';
    const picked = ['PREPARED', 'HANDED_OVER', 'DISPATCHED', 'DELIVERED', 'FAILED', 'PICKED_UP'].includes(
      scenario.stage,
    );
    const handedOver = ['HANDED_OVER', 'DISPATCHED', 'DELIVERED', 'FAILED', 'PICKED_UP'].includes(
      scenario.stage,
    );

    const task = await prisma.warehouseTask.create({
      data: {
        organizationId,
        taskNumber: `WT-2026${suffix}`.slice(0, 12),
        salesOrderId: order.id,
        status: handedOver ? 'COMPLETED' : picked ? 'PREPARED' : picking ? 'IN_PROGRESS' : 'PENDING',
        assignedUserId: picking ? options.warehouseUserId : null,
        startedAt: picking ? hoursAgo(6) : null,
        preparedAt: picked ? hoursAgo(4) : null,
        completedAt: handedOver ? hoursAgo(3) : null,
        notes: `${MARKER} ${scenario.key}`,
        createdById: options.managerUserId,
        createdAt: hoursAgo(8),
      },
    });

    for (const item of reservedLines) {
      await prisma.warehouseTaskItem.create({
        data: {
          organizationId,
          warehouseTaskId: task.id,
          salesOrderItemId: item.id,
          productId: item.productId,
          skuSnapshot: item.skuSnapshot,
          descriptionSnapshot: item.descriptionSnapshot,
          unitSnapshot: item.unitSnapshot,
          quantityRequired: item.reservedQuantity,
          quantityPrepared: picked ? item.reservedQuantity : 0,
          status: picked ? 'PREPARED' : 'PENDING',
        },
      });
    }

    // The mismatch scenario: shrink one reservation and its aggregate together, so the yard and
    // the system disagree in exactly the way §14 describes.
    if (scenario.breakReservation) {
      const reservation = await prisma.stockReservation.findFirst({
        where: { salesOrderId: order.id, status: 'ACTIVE' },
      });
      if (reservation && reservation.quantity > scenario.breakReservation) {
        await prisma.stockReservation.update({
          where: { id: reservation.id },
          data: { quantity: reservation.quantity - scenario.breakReservation },
        });
        await prisma.product.update({
          where: { id: reservation.productId },
          data: { reservedStock: { decrement: scenario.breakReservation } },
        });
      }
    }

    // --- the handoff: exactly what completeWarehouseTask does ---------------
    if (handedOver) {
      const reservations = await prisma.stockReservation.findMany({
        where: { salesOrderId: order.id, status: 'ACTIVE' },
      });

      for (const reservation of reservations) {
        const product = await prisma.product.update({
          where: { id: reservation.productId },
          data: {
            availableStock: { decrement: reservation.quantity },
            reservedStock: { decrement: reservation.quantity },
          },
        });
        await prisma.stockReservation.update({
          where: { id: reservation.id },
          data: { status: 'CONSUMED', releasedAt: hoursAgo(3) },
        });
        // Phase 7's ledger, written here too, so the demo can answer "why did this decrease"
        // for seeded shipments as well as for ones made through the application.
        await prisma.inventoryMovement.create({
          data: {
            organizationId,
            productId: reservation.productId,
            movementType: 'FULFILLMENT_CONSUMPTION',
            delta: -reservation.quantity,
            stockAfter: product.availableStock,
            reason: `${MARKER} ${task.taskNumber}: handed over against ${order.orderNumber}`,
            relatedOrderId: order.id,
            relatedReservationId: reservation.id,
            actorId: options.warehouseUserId,
            createdAt: hoursAgo(3),
          },
        });
      }
    }

    // --- the delivery -------------------------------------------------------
    if (handedOver && scenario.deliveryRequired) {
      const dispatched = ['DISPATCHED', 'DELIVERED', 'FAILED'].includes(scenario.stage);

      await prisma.delivery.create({
        data: {
          organizationId,
          deliveryNumber: `DL-2026${suffix}`.slice(0, 12),
          salesOrderId: order.id,
          warehouseTaskId: task.id,
          status:
            scenario.stage === 'DELIVERED'
              ? 'DELIVERED'
              : scenario.stage === 'FAILED'
                ? 'FAILED'
                : dispatched
                  ? 'DISPATCHED'
                  : 'PENDING',
          customerNameSnapshot: order.customer.companyName,
          customerPhoneSnapshot: order.customer.phone,
          destinationTextSnapshot:
            order.deliveryAddressSnapshot ?? order.customer.address ?? 'Addis Ababa',
          assignedDriverName: scenario.driver?.name ?? null,
          assignedDriverPhone: scenario.driver?.phone ?? null,
          vehicleReference: scenario.driver?.vehicle ?? null,
          assignedAt: scenario.driver ? hoursAgo(3) : null,
          dispatchedAt: dispatched ? hoursAgo(2) : null,
          deliveredAt: scenario.stage === 'DELIVERED' ? hoursAgo(1) : null,
          failedAt: scenario.stage === 'FAILED' ? hoursAgo(1) : null,
          failureReason: scenario.stage === 'FAILED' ? (scenario.failureReason ?? 'OTHER') : null,
          failureNote:
            scenario.stage === 'FAILED' ? 'The gate on the delivery note does not exist.' : null,
          createdAt: hoursAgo(3),
        },
      });
    }

    // --- collection, and operational completion -----------------------------
    if (scenario.stage === 'PICKED_UP') {
      await prisma.salesOrder.update({
        where: { id: order.id },
        data: {
          pickedUpAt: hoursAgo(2),
          pickedUpById: options.warehouseUserId,
          pickupNote: 'Collected by the site foreman.',
          status: 'COMPLETED',
          completedAt: hoursAgo(2),
        },
      });
    }

    if (scenario.stage === 'DELIVERED') {
      // Completed operationally. Payment status is untouched on purpose: a delivered credit
      // order still owes its balance and stays in receivables.
      await prisma.salesOrder.update({
        where: { id: order.id },
        data: { status: 'COMPLETED', completedAt: hoursAgo(1) },
      });
    }

    seeded += 1;
  }

  return seeded;
}

export const FULFILLMENT_SCENARIO_NOTES = SCENARIOS.map((scenario) => scenario.note);
