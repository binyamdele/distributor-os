import 'server-only';
import type { TenantTransaction } from '@/platform/db';

/**
 * Phase 2 instrumentation.
 *
 * Deliberately queries over the operational tables rather than a separate events pipeline.
 * At pilot volume — a few hundred inquiries a week — an analytics system would be more
 * machinery than the questions justify, and the questions here are the ones from the brief's
 * success-metrics list that Phase 2 can actually answer:
 *
 *   - is the parser producing usable output at all
 *   - how much of its output do salespeople accept unchanged
 *   - where does the matching fall over: unresolved, ambiguous, or corrected
 *
 * The last is the one that decides whether the deterministic matcher earns its place. A high
 * correction rate means the alias corpus is thin; a high unresolved rate means the catalogue
 * is. They call for different fixes, which is why they are counted separately.
 */

export interface ParsingMetrics {
  readonly inquiriesTotal: number;
  readonly parsedSuccessfully: number;
  readonly parseFailed: number;
  /** Successful parses / parse attempts. Null when nothing has been attempted. */
  readonly parseSuccessRate: number | null;
  readonly awaitingReview: number;
  readonly readyForQuote: number;
}

export interface MatchMetrics {
  readonly items: number;
  readonly byMethod: Readonly<Record<string, number>>;
  readonly byReviewStatus: Readonly<Record<string, number>>;
  readonly ambiguous: number;
  /** Confirmed / (confirmed + corrected). Null when nothing has been reviewed. */
  readonly acceptanceRate: number | null;
  /** Corrected / (confirmed + corrected). The mirror of acceptance. */
  readonly correctionRate: number | null;
  /** Items the matcher could not name / all items. */
  readonly unresolvedRate: number | null;
  /** Mean proposed confidence over items where a product was proposed. */
  readonly averageConfidence: number | null;
}

export async function parsingMetrics(tx: TenantTransaction): Promise<ParsingMetrics> {
  const grouped = await tx.inquiry.groupBy({ by: ['status'], _count: { _all: true } });
  const counts = new Map(grouped.map((row) => [row.status as string, row._count._all]));
  const at = (status: string): number => counts.get(status) ?? 0;

  const inquiriesTotal = [...counts.values()].reduce((total, value) => total + value, 0);

  const succeeded = await tx.aiInteraction.count({ where: { purpose: 'parse_inquiry', valid: true } });
  const failed = await tx.aiInteraction.count({ where: { purpose: 'parse_inquiry', valid: false } });
  const attempts = succeeded + failed;

  return {
    inquiriesTotal,
    parsedSuccessfully: succeeded,
    parseFailed: failed,
    parseSuccessRate: attempts === 0 ? null : succeeded / attempts,
    awaitingReview: at('NEEDS_REVIEW'),
    readyForQuote: at('READY_FOR_QUOTE'),
  };
}

export async function matchMetrics(tx: TenantTransaction): Promise<MatchMetrics> {
  const [byMethodRows, byStatusRows, ambiguous, confidenceAgg, items] = await Promise.all([
    tx.inquiryItemProposal.groupBy({ by: ['matchMethod'], _count: { _all: true } }),
    tx.inquiryItemProposal.groupBy({ by: ['reviewStatus'], _count: { _all: true } }),
    tx.inquiryItemProposal.count({ where: { ambiguous: true } }),
    tx.inquiryItemProposal.aggregate({ _avg: { proposedConfidence: true } }),
    tx.inquiryItemProposal.count(),
  ]);

  const byMethod = Object.fromEntries(
    byMethodRows.map((row) => [row.matchMethod as string, row._count._all]),
  );
  const byReviewStatus = Object.fromEntries(
    byStatusRows.map((row) => [row.reviewStatus as string, row._count._all]),
  );

  const confirmed = byReviewStatus.CONFIRMED ?? 0;
  const corrected = byReviewStatus.CORRECTED ?? 0;
  const reviewed = confirmed + corrected;
  const unresolvedProposals = byMethod.UNRESOLVED ?? 0;
  const average = confidenceAgg._avg.proposedConfidence;

  return {
    items,
    byMethod,
    byReviewStatus,
    ambiguous,
    acceptanceRate: reviewed === 0 ? null : confirmed / reviewed,
    correctionRate: reviewed === 0 ? null : corrected / reviewed,
    unresolvedRate: items === 0 ? null : unresolvedProposals / items,
    averageConfidence: average === null ? null : Number(average),
  };
}
