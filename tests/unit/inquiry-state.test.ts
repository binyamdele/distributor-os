import { describe, expect, it } from 'vitest';
import {
  INQUIRY_STATUSES,
  type InquiryStatus,
  allowedTransitions,
  canTransition,
  isOpen,
  isTerminal,
} from '@/modules/inquiries/state';
import { type ReadinessItem, evaluateReadiness } from '@/modules/inquiries/readiness';

describe('the inquiry state machine', () => {
  it('permits exactly the documented transitions and no others', () => {
    const expected: Record<InquiryStatus, InquiryStatus[]> = {
      RECEIVED: ['PARSING', 'CANCELLED'],
      PARSING: ['NEEDS_REVIEW', 'PARSE_FAILED'],
      NEEDS_REVIEW: ['READY_FOR_QUOTE', 'PARSING', 'CANCELLED'],
      READY_FOR_QUOTE: ['NEEDS_REVIEW'],
      PARSE_FAILED: ['PARSING', 'CANCELLED'],
      CANCELLED: [],
    };

    // Every ordered pair, both directions of the assertion.
    for (const from of INQUIRY_STATUSES) {
      for (const to of INQUIRY_STATUSES) {
        const permitted = expected[from].includes(to);
        expect(canTransition(from, to), `${from} -> ${to}`).toBe(permitted);
      }
    }
  });

  it('never lets an inquiry re-enter a state it cannot leave', () => {
    expect(isTerminal('CANCELLED')).toBe(true);
    expect(allowedTransitions('CANCELLED')).toEqual([]);
  });

  it('withdraws readiness rather than leaving a stale claim standing', () => {
    // Editing a reviewed item must be able to take the inquiry back out of ready.
    expect(canTransition('READY_FOR_QUOTE', 'NEEDS_REVIEW')).toBe(true);
  });

  it('makes a failed parse recoverable', () => {
    expect(canTransition('PARSE_FAILED', 'PARSING')).toBe(true);
  });

  it('does not allow a ready inquiry to be cancelled from under a quotation', () => {
    expect(canTransition('READY_FOR_QUOTE', 'CANCELLED')).toBe(false);
  });

  it('does not allow parsing to skip review', () => {
    expect(canTransition('PARSING', 'READY_FOR_QUOTE')).toBe(false);
  });

  it('knows which states are still being worked', () => {
    expect(isOpen('NEEDS_REVIEW')).toBe(true);
    expect(isOpen('READY_FOR_QUOTE')).toBe(false);
    expect(isOpen('CANCELLED')).toBe(false);
  });
});

function item(overrides: Partial<ReadinessItem> = {}): ReadinessItem {
  return {
    id: 'item-1',
    position: 0,
    rawName: '12mm rebar',
    reviewStatus: 'CONFIRMED',
    matchedProductId: 'product-1',
    requestedQuantity: 80,
    unitCompatibility: 'match',
    stockShortfall: 100,
    shortfallUnit: 'piece',
    ...overrides,
  };
}

describe('the ready-for-quote gate', () => {
  it('passes a fully reviewed quotation request', () => {
    const verdict = evaluateReadiness('REQUEST_QUOTATION', [item()]);
    expect(verdict.ready).toBe(true);
    expect(verdict.blockers).toEqual([]);
    expect(verdict.retainedCount).toBe(1);
  });

  it('blocks an intent a quotation cannot follow from', () => {
    const verdict = evaluateReadiness('PAYMENT_QUERY', [item()]);
    expect(verdict.ready).toBe(false);
    expect(verdict.blockers[0]?.message).toMatch(/not a request for a quotation/i);
  });

  it('accepts a stock enquiry, which distributors do quote from', () => {
    expect(evaluateReadiness('STOCK_ENQUIRY', [item()]).ready).toBe(true);
  });

  it('blocks an inquiry with no items left', () => {
    expect(evaluateReadiness('REQUEST_QUOTATION', []).ready).toBe(false);
    const allRejected = evaluateReadiness('REQUEST_QUOTATION', [
      item({ reviewStatus: 'REJECTED' }),
    ]);
    expect(allRejected.ready).toBe(false);
    expect(allRejected.retainedCount).toBe(0);
  });

  it('blocks an item that is still only a suggestion', () => {
    // This is the heart of the phase: a machine proposal is not a decision.
    const verdict = evaluateReadiness('REQUEST_QUOTATION', [
      item({ reviewStatus: 'SUGGESTED', matchedProductId: null }),
    ]);
    expect(verdict.ready).toBe(false);
    expect(verdict.blockers[0]?.message).toMatch(/no confirmed product/i);
  });

  it('blocks an unresolved item', () => {
    const verdict = evaluateReadiness('REQUEST_QUOTATION', [
      item({ reviewStatus: 'UNRESOLVED', matchedProductId: null }),
    ]);
    expect(verdict.ready).toBe(false);
  });

  it('blocks an incompatible unit', () => {
    expect(
      evaluateReadiness('REQUEST_QUOTATION', [item({ unitCompatibility: 'mismatch' })]).ready,
    ).toBe(false);
    expect(
      evaluateReadiness('REQUEST_QUOTATION', [item({ unitCompatibility: 'unknown' })]).ready,
    ).toBe(false);
  });

  it('permits an assumed unit, with a warning', () => {
    const verdict = evaluateReadiness('REQUEST_QUOTATION', [
      item({ unitCompatibility: 'assumed' }),
    ]);
    expect(verdict.ready).toBe(true);
    expect(verdict.warnings).toHaveLength(1);
  });

  it('warns about short stock without blocking', () => {
    // The asymmetry that matters: distributors back-order and part-ship all the time. What they
    // cannot do is quote a product nobody has identified.
    const verdict = evaluateReadiness('REQUEST_QUOTATION', [item({ stockShortfall: -160 })]);
    expect(verdict.ready).toBe(true);
    expect(verdict.warnings[0]?.message).toMatch(/short by 160/i);
  });

  it('ignores rejected items entirely', () => {
    const verdict = evaluateReadiness('REQUEST_QUOTATION', [
      item(),
      item({ id: 'item-2', reviewStatus: 'REJECTED', matchedProductId: null, position: 1 }),
    ]);
    expect(verdict.ready).toBe(true);
    expect(verdict.retainedCount).toBe(1);
  });

  it('reports every blocker, not only the first', () => {
    const verdict = evaluateReadiness('REQUEST_QUOTATION', [
      item({ id: 'a', reviewStatus: 'UNRESOLVED', matchedProductId: null }),
      item({ id: 'b', position: 1, unitCompatibility: 'mismatch' }),
    ]);
    expect(verdict.blockers.length).toBeGreaterThanOrEqual(2);
  });

  it('names the line a blocker belongs to', () => {
    const verdict = evaluateReadiness('REQUEST_QUOTATION', [
      item({ reviewStatus: 'UNRESOLVED', matchedProductId: null, rawName: 'PVC pipe' }),
    ]);
    expect(verdict.blockers[0]?.message).toContain('PVC pipe');
    expect(verdict.blockers[0]?.itemId).toBe('item-1');
  });
});
