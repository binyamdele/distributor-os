import type { UnitCompatibility } from '@/modules/catalog';

/**
 * The ready-for-quote gate.
 *
 * A pure function, so the rule that decides whether unreviewed work can flow into Phase 3 can
 * be enumerated in a unit test rather than inferred from a UI.
 *
 * The important asymmetry, and the reason this is not one boolean: **insufficient stock is a
 * warning, unresolved identity is a blocker.** A distributor quotes short all the time — they
 * back-order, they part-ship, they source from a competitor. What they cannot do is quote a
 * product nobody has identified. So the gate refuses uncertainty about *what* and permits
 * uncertainty about *how many*.
 */

/** Intents a quotation can legitimately follow from. */
export const QUOTABLE_INTENTS = ['REQUEST_QUOTATION', 'STOCK_ENQUIRY'] as const;

export type ReadinessItem = {
  readonly id: string;
  readonly position: number;
  readonly rawName: string;
  readonly reviewStatus: 'SUGGESTED' | 'CONFIRMED' | 'CORRECTED' | 'UNRESOLVED' | 'REJECTED';
  readonly matchedProductId: string | null;
  readonly requestedQuantity: number;
  readonly unitCompatibility: UnitCompatibility | null;
  /** Free-to-sell stock minus the requested quantity. Negative means short. */
  readonly stockShortfall: number | null;
  /** The unit the shortfall is expressed in, for the warning message. */
  readonly shortfallUnit: string | null;
};

export interface ReadinessProblem {
  readonly itemId: string | null;
  readonly message: string;
}

export interface ReadinessVerdict {
  readonly ready: boolean;
  readonly blockers: readonly ReadinessProblem[];
  readonly warnings: readonly ReadinessProblem[];
  /** Items that would carry through to a quotation. */
  readonly retainedCount: number;
}

export function evaluateReadiness(
  intent: string,
  items: readonly ReadinessItem[],
): ReadinessVerdict {
  const blockers: ReadinessProblem[] = [];
  const warnings: ReadinessProblem[] = [];

  if (!QUOTABLE_INTENTS.includes(intent as (typeof QUOTABLE_INTENTS)[number])) {
    blockers.push({
      itemId: null,
      message:
        `This message reads as ${intent.toLowerCase().replace(/_/g, ' ')}, not a request for a ` +
        'quotation. Correct the interpretation if that is wrong.',
    });
  }

  const retained = items.filter((item) => item.reviewStatus !== 'REJECTED');

  if (retained.length === 0) {
    blockers.push({ itemId: null, message: 'No requested items remain on this inquiry.' });
  }

  for (const item of retained) {
    const label = `Line ${item.position + 1} ("${item.rawName}")`;

    if (item.reviewStatus === 'UNRESOLVED' || !item.matchedProductId) {
      blockers.push({
        itemId: item.id,
        message: `${label} has no confirmed product.`,
      });
      continue;
    }

    if (item.reviewStatus === 'SUGGESTED') {
      blockers.push({
        itemId: item.id,
        message: `${label} is still only a suggestion. Confirm or correct it.`,
      });
    }

    if (item.requestedQuantity <= 0) {
      blockers.push({ itemId: item.id, message: `${label} has no valid quantity.` });
    }

    if (item.unitCompatibility === 'mismatch' || item.unitCompatibility === 'unknown') {
      blockers.push({
        itemId: item.id,
        message: `${label} asks for a unit this product is not sold in.`,
      });
    }

    if (item.unitCompatibility === 'assumed') {
      warnings.push({
        itemId: item.id,
        message: `${label} gave no unit; the product's own unit is assumed.`,
      });
    }

    if (item.stockShortfall !== null && item.stockShortfall < 0) {
      warnings.push({
        itemId: item.id,
        message:
          `${label} is short by ${Math.abs(item.stockShortfall).toLocaleString()} ` +
          `${item.shortfallUnit ?? 'units'}. A quotation can still be prepared.`,
      });
    }
  }

  return {
    ready: blockers.length === 0,
    blockers,
    warnings,
    retainedCount: retained.length,
  };
}
