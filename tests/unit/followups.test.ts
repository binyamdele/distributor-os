import { describe, expect, it } from 'vitest';
import {
  FOLLOW_UP_STATUSES,
  type FollowUpStatus,
  canTransition,
  dueDateFor,
  isOpen,
  mayScheduleAnother,
} from '@/modules/followups';
import {
  acceptanceEligibility,
  isExpired,
} from '@/modules/quotations';

describe('follow-up due dates', () => {
  const sent = new Date('2026-08-21T09:00:00.000Z');

  it('schedules the first chase one interval after sending', () => {
    expect(dueDateFor(sent, 1, 2).toISOString()).toBe('2026-08-23T09:00:00.000Z');
  });

  it('spaces later chases by the same interval, measured from sending', () => {
    // Counted from the send rather than from the previous completion, so a salesperson who
    // chases late does not push every subsequent chase later with them.
    expect(dueDateFor(sent, 2, 2).toISOString()).toBe('2026-08-25T09:00:00.000Z');
    expect(dueDateFor(sent, 3, 2).toISOString()).toBe('2026-08-27T09:00:00.000Z');
  });

  it('honours a different configured interval', () => {
    expect(dueDateFor(sent, 1, 7).toISOString()).toBe('2026-08-28T09:00:00.000Z');
  });

  it('crosses a month boundary correctly', () => {
    const late = new Date('2026-08-30T09:00:00.000Z');
    expect(dueDateFor(late, 1, 3).toISOString()).toBe('2026-09-02T09:00:00.000Z');
  });
});

describe('the follow-up cap', () => {
  it('allows another chase below the cap', () => {
    expect(mayScheduleAnother(1, 4)).toBe(true);
    expect(mayScheduleAnother(3, 4)).toBe(true);
  });

  it('stops at the cap', () => {
    // The point of the cap: a queue that refills itself forever trains people to ignore it.
    expect(mayScheduleAnother(4, 4)).toBe(false);
    expect(mayScheduleAnother(5, 4)).toBe(false);
  });

  it('honours a cap of one', () => {
    expect(mayScheduleAnother(1, 1)).toBe(false);
  });
});

describe('the follow-up state machine', () => {
  it('permits exactly the documented transitions', () => {
    const expected: Record<FollowUpStatus, FollowUpStatus[]> = {
      DUE: ['COMPLETED', 'SNOOZED', 'CANCELLED'],
      SNOOZED: ['DUE', 'COMPLETED', 'CANCELLED'],
      COMPLETED: [],
      CANCELLED: [],
    };

    for (const from of FOLLOW_UP_STATUSES) {
      for (const to of FOLLOW_UP_STATUSES) {
        expect(canTransition(from, to), `${from} -> ${to}`).toBe(expected[from].includes(to));
      }
    }
  });

  it('treats a completed follow-up as final', () => {
    // A second attempt is a second row. Reopening one would lose the history the table exists for.
    expect(canTransition('COMPLETED', 'DUE')).toBe(false);
    expect(canTransition('CANCELLED', 'DUE')).toBe(false);
  });

  it('knows which statuses still need work', () => {
    expect(isOpen('DUE')).toBe(true);
    expect(isOpen('SNOOZED')).toBe(true);
    expect(isOpen('COMPLETED')).toBe(false);
    expect(isOpen('CANCELLED')).toBe(false);
  });
});

describe('quotation expiry', () => {
  const validity = new Date('2026-08-28T00:00:00.000Z');

  it('is not expired before the validity date', () => {
    expect(isExpired(validity, new Date('2026-08-27T23:00:00.000Z'))).toBe(false);
  });

  it('is not expired on the validity date itself', () => {
    // The last day counts. A quotation valid until the 28th is valid on the 28th.
    expect(isExpired(validity, new Date('2026-08-28T18:00:00.000Z'))).toBe(false);
  });

  it('is expired the day after', () => {
    expect(isExpired(validity, new Date('2026-08-29T00:00:01.000Z'))).toBe(true);
  });
});

describe('acceptance eligibility', () => {
  const base = {
    status: 'SENT' as const,
    approvalIsLive: true,
    validityDate: new Date('2026-12-31T00:00:00.000Z'),
    now: new Date('2026-08-21T00:00:00.000Z'),
  };

  it('accepts a live, in-date, sent quotation', () => {
    expect(acceptanceEligibility(base).eligible).toBe(true);
  });

  it('refuses anything that has not been sent', () => {
    for (const status of ['DRAFT', 'PENDING_APPROVAL', 'APPROVED'] as const) {
      const verdict = acceptanceEligibility({ ...base, status });
      expect(verdict.eligible, status).toBe(false);
      expect(verdict.reason).toMatch(/has been sent/i);
    }
  });

  it('refuses a quotation whose figures no longer match the approval', () => {
    const verdict = acceptanceEligibility({ ...base, approvalIsLive: false });
    expect(verdict.eligible).toBe(false);
    expect(verdict.reason).toMatch(/no longer match what was approved/i);
  });

  it('refuses an expired quotation and says why', () => {
    const verdict = acceptanceEligibility({
      ...base,
      validityDate: new Date('2026-08-01T00:00:00.000Z'),
    });
    expect(verdict.eligible).toBe(false);
    expect(verdict.reason).toMatch(/validity date/i);
    expect(verdict.reason).toMatch(/new quotation/i);
  });

  it('refuses an already-accepted quotation', () => {
    expect(acceptanceEligibility({ ...base, status: 'ACCEPTED' }).eligible).toBe(false);
  });
});
