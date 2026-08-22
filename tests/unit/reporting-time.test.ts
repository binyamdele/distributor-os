import { describe, expect, it } from 'vitest';
import {
  compareDateToLocalToday,
  isOnOrBeforeLocalToday,
  lastLocalDays,
  localCalendarDate,
  localDateKey,
  localDay,
  localDaysIn,
  precedingLocalDays,
  previousLocalDay,
  startOfLocalDay,
  within,
} from '@/platform/time/reporting';

/**
 * Reporting boundaries.
 *
 * The most consequential tests in Phase 8. Every figure on the dashboard is "since some instant",
 * and if that instant is wrong by three hours then every figure is wrong by whatever happened in
 * those three hours — silently, plausibly, and in a way nobody can spot by looking at the page.
 *
 * Ethiopia is UTC+3 with no daylight saving, so the whole day is shifted: local midnight is
 * 21:00 UTC the previous day.
 */

const ADDIS = 'Africa/Addis_Ababa';
/** Two zones with daylight saving, in opposite hemispheres, to prove nothing is Ethiopia-shaped. */
const LONDON = 'Europe/London';
const AUCKLAND = 'Pacific/Auckland';

describe('the organization-local day', () => {
  it('starts at 21:00 UTC the previous day in Addis', () => {
    const noon = new Date('2026-08-22T09:00:00.000Z'); // 12:00 in Addis
    const day = localDay(ADDIS, noon);

    expect(day.start.toISOString()).toBe('2026-08-21T21:00:00.000Z');
    expect(day.end.toISOString()).toBe('2026-08-22T21:00:00.000Z');
  });

  it('is not the UTC day', () => {
    // The whole point. A naive implementation would return 2026-08-22T00:00:00Z here, and
    // silently drop everything that happened between local midnight and 3 a.m.
    const day = localDay(ADDIS, new Date('2026-08-22T09:00:00.000Z'));
    expect(day.start.toISOString()).not.toBe('2026-08-22T00:00:00.000Z');
  });

  it('puts 23:59:59 local on the day that is ending', () => {
    // 20:59:59 UTC is 23:59:59 in Addis on the 22nd.
    const lastSecond = new Date('2026-08-22T20:59:59.000Z');
    const day = localDay(ADDIS, lastSecond);

    expect(localDateKey(lastSecond, ADDIS)).toBe('2026-08-22');
    expect(within(day, lastSecond)).toBe(true);
  });

  it('puts 00:00:00 local on the day that is beginning', () => {
    // 21:00:00 UTC is exactly midnight in Addis on the 23rd.
    const firstInstant = new Date('2026-08-22T21:00:00.000Z');

    expect(localDateKey(firstInstant, ADDIS)).toBe('2026-08-23');

    const previous = localDay(ADDIS, new Date('2026-08-22T20:59:59.000Z'));
    // Half-open: the instant that ends one day is the instant that starts the next, and it
    // belongs to exactly one of them. Otherwise the daily figures would not sum to the week.
    expect(within(previous, firstInstant)).toBe(false);
    expect(previous.end.getTime()).toBe(firstInstant.getTime());
  });

  it('is exactly 24 hours long where there is no daylight saving', () => {
    const day = localDay(ADDIS, new Date('2026-08-22T09:00:00.000Z'));
    expect(day.end.getTime() - day.start.getTime()).toBe(86_400_000);
  });

  it('handles a UTC instant that falls on the previous local day', () => {
    // 00:30 UTC on the 22nd is 03:30 local on the 22nd — same date here, and worth pinning
    // because the reverse case is where naive code breaks.
    expect(localDateKey(new Date('2026-08-22T00:30:00.000Z'), ADDIS)).toBe('2026-08-22');
    // 22:30 UTC on the 22nd is already 01:30 on the 23rd locally.
    expect(localDateKey(new Date('2026-08-22T22:30:00.000Z'), ADDIS)).toBe('2026-08-23');
  });
});

describe('other timezones', () => {
  it('tracks a spring-forward boundary in London', () => {
    // 29 March 2026: BST begins at 01:00 UTC. The local day is 23 hours long.
    const day = localDay(LONDON, new Date('2026-03-29T12:00:00.000Z'));
    expect(day.start.toISOString()).toBe('2026-03-29T00:00:00.000Z');
    expect(day.end.toISOString()).toBe('2026-03-29T23:00:00.000Z');
    expect(day.end.getTime() - day.start.getTime()).toBe(23 * 3_600_000);
  });

  it('tracks an autumn-back boundary in London', () => {
    // 25 October 2026: BST ends at 02:00 local. The local day is 25 hours long.
    const day = localDay(LONDON, new Date('2026-10-25T12:00:00.000Z'));
    expect(day.end.getTime() - day.start.getTime()).toBe(25 * 3_600_000);
  });

  it('works south of the equator, where the offset is large and positive', () => {
    // Auckland in January is UTC+13. Local midnight is 11:00 UTC the previous day.
    const day = localDay(AUCKLAND, new Date('2026-01-15T00:00:00.000Z'));
    expect(day.start.toISOString()).toBe('2026-01-14T11:00:00.000Z');
    expect(localDateKey(new Date('2026-01-14T11:00:00.000Z'), AUCKLAND)).toBe('2026-01-15');
  });

  it('agrees with UTC in a zone that is UTC', () => {
    const day = localDay('UTC', new Date('2026-08-22T09:00:00.000Z'));
    expect(day.start.toISOString()).toBe('2026-08-22T00:00:00.000Z');
  });
});

describe('calendar arithmetic', () => {
  it('reads back the local calendar date', () => {
    expect(localCalendarDate(new Date('2026-08-22T20:59:59.000Z'), ADDIS)).toEqual({
      year: 2026,
      month: 8,
      day: 22,
    });
  });

  it('crosses a month boundary', () => {
    const day = localDay(ADDIS, new Date('2026-08-31T21:30:00.000Z'));
    expect(localDateKey(day.start, ADDIS)).toBe('2026-09-01');
  });

  it('crosses a year boundary', () => {
    expect(localDateKey(new Date('2026-12-31T21:30:00.000Z'), ADDIS)).toBe('2027-01-01');
  });

  it('handles a leap day', () => {
    const start = startOfLocalDay(ADDIS, { year: 2028, month: 2, day: 29 });
    expect(localDateKey(start, ADDIS)).toBe('2028-02-29');
  });
});

describe('periods', () => {
  const noon = new Date('2026-08-22T09:00:00.000Z');

  it('gives yesterday as the day immediately before', () => {
    const today = localDay(ADDIS, noon);
    const yesterday = previousLocalDay(ADDIS, noon);

    expect(yesterday.end.getTime()).toBe(today.start.getTime());
    expect(localDateKey(yesterday.start, ADDIS)).toBe('2026-08-21');
  });

  it('counts the last seven days as six back plus today', () => {
    const week = lastLocalDays(ADDIS, noon, 7);
    expect(localDateKey(week.start, ADDIS)).toBe('2026-08-16');
    expect(week.end.getTime() - week.start.getTime()).toBe(7 * 86_400_000);
  });

  it('places the preceding window immediately before, with no gap or overlap', () => {
    const week = lastLocalDays(ADDIS, noon, 7);
    const before = precedingLocalDays(ADDIS, noon, 7);

    expect(before.end.getTime()).toBe(week.start.getTime());
    expect(before.end.getTime() - before.start.getTime()).toBe(7 * 86_400_000);
  });

  it('enumerates seven contiguous days, oldest first', () => {
    const days = localDaysIn(ADDIS, noon, 7);

    expect(days).toHaveLength(7);
    expect(localDateKey(days[0]!.start, ADDIS)).toBe('2026-08-16');
    expect(localDateKey(days[6]!.start, ADDIS)).toBe('2026-08-22');

    for (let index = 1; index < days.length; index += 1) {
      expect(days[index]!.start.getTime()).toBe(days[index - 1]!.end.getTime());
    }
  });

  it('sums the daily periods to exactly the weekly period', () => {
    // The property that makes a seven-day chart agree with a seven-day total.
    const week = lastLocalDays(ADDIS, noon, 7);
    const days = localDaysIn(ADDIS, noon, 7);

    expect(days[0]!.start.getTime()).toBe(week.start.getTime());
    expect(days[days.length - 1]!.end.getTime()).toBe(week.end.getTime());
  });
});

describe('comparing a due date against local today', () => {
  // A @db.Date arrives as midnight UTC; its UTC components are the calendar date.
  const dueOn = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

  it('calls a date due today zero, throughout the local day', () => {
    // The case a naive instant comparison gets wrong: at 06:00 local (03:00 UTC) an invoice due
    // today would look overdue if the due date were treated as midnight UTC and compared to now.
    const earlyMorning = new Date('2026-08-22T03:00:00.000Z');
    const lateEvening = new Date('2026-08-22T20:00:00.000Z');

    expect(compareDateToLocalToday(dueOn('2026-08-22'), ADDIS, earlyMorning)).toBe(0);
    expect(compareDateToLocalToday(dueOn('2026-08-22'), ADDIS, lateEvening)).toBe(0);
  });

  it('does not call an invoice due today overdue in the Ethiopian morning', () => {
    // Stated separately because it is the regression that would matter most.
    const sixAm = new Date('2026-08-22T03:00:00.000Z');
    expect(compareDateToLocalToday(dueOn('2026-08-22'), ADDIS, sixAm) < 0).toBe(false);
  });

  it('counts whole days late and whole days ahead', () => {
    const noon = new Date('2026-08-22T09:00:00.000Z');
    expect(compareDateToLocalToday(dueOn('2026-08-15'), ADDIS, noon)).toBe(-7);
    expect(compareDateToLocalToday(dueOn('2026-08-29'), ADDIS, noon)).toBe(7);
    expect(compareDateToLocalToday(dueOn('2026-08-21'), ADDIS, noon)).toBe(-1);
  });

  it('rolls over at local midnight, not UTC midnight', () => {
    const dueDate = dueOn('2026-08-22');

    // 20:59 UTC — still the 22nd locally, so the invoice is due today.
    expect(compareDateToLocalToday(dueDate, ADDIS, new Date('2026-08-22T20:59:00.000Z'))).toBe(0);
    // 21:01 UTC — the 23rd locally, so it is now a day overdue.
    expect(compareDateToLocalToday(dueDate, ADDIS, new Date('2026-08-22T21:01:00.000Z'))).toBe(-1);
  });

  it('agrees with the on-or-before helper', () => {
    const noon = new Date('2026-08-22T09:00:00.000Z');
    expect(isOnOrBeforeLocalToday(dueOn('2026-08-22'), ADDIS, noon)).toBe(true);
    expect(isOnOrBeforeLocalToday(dueOn('2026-08-21'), ADDIS, noon)).toBe(true);
    expect(isOnOrBeforeLocalToday(dueOn('2026-08-23'), ADDIS, noon)).toBe(false);
  });

  it('crosses a month boundary correctly', () => {
    const noon = new Date('2026-09-01T09:00:00.000Z');
    expect(compareDateToLocalToday(dueOn('2026-08-31'), ADDIS, noon)).toBe(-1);
  });
});
