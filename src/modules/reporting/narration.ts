import 'server-only';
import {
  type AIProvider,
  type BriefNarrationInput,
  aiProvider,
  verifyGrounding,
} from '@/platform/ai';
import { formatMoney } from '@/platform/money';
import { type DailyBrief, deterministicBrief } from './brief';
import type { DashboardSnapshot } from './snapshot';

/**
 * Turning a snapshot into a brief, with the model as an optional last step.
 *
 * The order of operations is the design:
 *
 *   1. the deterministic brief is built first, always, from the snapshot
 *   2. the model is offered a stripped-down copy of the figures
 *   3. its answer is schema-validated
 *   4. its answer is grounding-checked against those same figures
 *   5. anything short of passing both, and the brief from step 1 is what the owner reads
 *
 * There is no path where a failure produces a blank panel, a partial brief, or a page that says
 * "summary unavailable". The narrated version is nicer prose over identical facts; losing it
 * costs polish and nothing else.
 */

export interface NarratedBrief {
  readonly brief: DailyBrief;
  /** Why the deterministic version is showing, when it is. Diagnostic, not user-facing copy. */
  readonly fallbackReason:
    | null
    | 'DISABLED'
    | 'PROVIDER_FAILED'
    | 'SCHEMA_INVALID'
    | 'NOT_GROUNDED';
  readonly provider: string | null;
  readonly model: string | null;
  readonly promptVersion: string | null;
}

/**
 * Reduces the snapshot to what a narrator may see.
 *
 * Three things are true of everything that survives this function: it is a number or a
 * pre-formatted amount, it was computed by this system, and it identifies nobody. No customer
 * name, no order number, no phone, no address, no message text, no reference. The dashboard
 * renders the largest order's customer name directly from the snapshot — it never travels here.
 *
 * Amounts are pre-formatted so the model has no opportunity to do arithmetic on them and no
 * reason to reformat them. Asking a model to render `342000000` as ETB 3,420,000.00 is asking
 * it to calculate, which is the one thing it must not do.
 */
export function buildNarrationInput(snapshot: DashboardSnapshot): BriefNarrationInput {
  const { currency } = snapshot;
  const money = (minor: bigint) => formatMoney({ amountMinor: minor, currency });

  const counts: Record<string, number> = {};
  const amounts: Record<string, string> = {};

  if (snapshot.sales) {
    counts.ordersCreated = snapshot.sales.ordersCreated;
    counts.quotationsCreated = snapshot.sales.quotationsCreated;
    counts.quotationsAccepted = snapshot.sales.quotationsAccepted;
    counts.quotationsRejected = snapshot.sales.quotationsRejected;
    amounts.orderValueToday = money(snapshot.sales.orderValueTodayMinor);
    amounts.quotationValueToday = money(snapshot.sales.quotationValueTodayMinor);
    amounts.acceptedValueToday = money(snapshot.sales.acceptedValueTodayMinor);
    if (snapshot.sales.acceptanceRate !== null) {
      counts.acceptanceRatePercent = Math.round(snapshot.sales.acceptanceRate * 100);
    }
  }

  if (snapshot.cash) {
    counts.paymentsConfirmedToday = snapshot.cash.paymentsConfirmedToday;
    counts.paymentsAwaitingReview = snapshot.cash.paymentsAwaitingReview;
    counts.overdueOrders = snapshot.cash.overdueCount;
    amounts.paymentsConfirmedToday = money(snapshot.cash.paymentsConfirmedTodayMinor);
    amounts.outstandingReceivables = money(snapshot.cash.outstandingReceivablesMinor);
    amounts.overdueReceivables = money(snapshot.cash.overdueReceivablesMinor);
  }

  if (snapshot.pipeline) {
    counts.followUpsOverdue = snapshot.pipeline.followUpsOverdue;
    counts.quotationsAwaitingApproval = snapshot.pipeline.quotationsAwaitingApproval;
    counts.inquiriesAwaitingReview = snapshot.pipeline.inquiriesAwaitingReview;
  }

  if (snapshot.operations) {
    counts.ordersAwaitingWarehouse = snapshot.operations.ordersAwaitingWarehouse;
    counts.deliveriesPending = snapshot.operations.deliveriesPending;
    counts.failedDeliveriesOpen = snapshot.operations.failedDeliveriesOpen;
    counts.ordersCompletedToday = snapshot.operations.ordersCompletedToday;
  }

  if (snapshot.inventory) {
    counts.lowStockProducts = snapshot.inventory.lowStockProducts;
    counts.openDiscrepancies = snapshot.inventory.openDiscrepancies;
    counts.reservationShortfalls = snapshot.inventory.reservationShortfalls;
    counts.returnsAwaitingProcessing = snapshot.inventory.returnsAwaitingProcessing;
  }

  // Kinds and tallies only. A reference or a title would carry a customer name into the payload
  // through the back door, and a title is also attacker-influenced text.
  const attentionByKind: Record<string, number> = {};
  for (const item of snapshot.attention) {
    attentionByKind[item.kind] = (attentionByKind[item.kind] ?? 0) + 1;
  }

  return {
    dateKey: snapshot.dateKey,
    currency,
    counts,
    amounts,
    attentionByKind,
  };
}

export interface NarrateOptions {
  /** Off by default. The deterministic brief is the product; narration is an addition to it. */
  readonly useAi?: boolean;
  readonly provider?: AIProvider;
}

export async function narrateBrief(
  snapshot: DashboardSnapshot,
  options: NarrateOptions = {},
): Promise<NarratedBrief> {
  const fallback = deterministicBrief(snapshot);

  if (!options.useAi) {
    return {
      brief: fallback,
      fallbackReason: 'DISABLED',
      provider: null,
      model: null,
      promptVersion: null,
    };
  }

  const provider = options.provider ?? aiProvider();
  const input = buildNarrationInput(snapshot);
  const outcome = await provider.narrateDailyBrief(input);

  if (!outcome.ok) {
    return {
      brief: fallback,
      fallbackReason: outcome.errorCode === 'SCHEMA_INVALID' ? 'SCHEMA_INVALID' : 'PROVIDER_FAILED',
      provider: outcome.meta.provider,
      model: outcome.meta.model,
      promptVersion: outcome.meta.promptVersion,
    };
  }

  /*
   * The grounding check.
   *
   * A well-formed paragraph containing a figure nobody calculated is the failure that matters
   * here, because it is the one a reader cannot catch: the rest of the sentence is correct, the
   * tone is right, and the number is simply wrong. So a narration carrying any figure not
   * traceable to the input is discarded whole rather than partially trusted — there is no
   * sensible way to keep the sentences that happen to be fine.
   */
  const verdict = verifyGrounding(outcome.value, input);
  if (!verdict.grounded) {
    return {
      brief: fallback,
      fallbackReason: 'NOT_GROUNDED',
      provider: outcome.meta.provider,
      model: outcome.meta.model,
      promptVersion: outcome.meta.promptVersion,
    };
  }

  return {
    brief: {
      summary: outcome.value.summary,
      highlights: outcome.value.highlights,
      attention: outcome.value.attention,
      source: 'AI',
    },
    fallbackReason: null,
    provider: outcome.meta.provider,
    model: outcome.meta.model,
    promptVersion: outcome.meta.promptVersion,
  };
}
