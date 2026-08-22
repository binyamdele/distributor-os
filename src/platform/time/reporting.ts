/**
 * Reporting boundaries in the organization's timezone.
 *
 * The whole analytics layer rests on one question — where does "today" start and end — and
 * getting it wrong is not a rounding error. A distributor in Addis reading "sales today" at
 * 9 a.m. and seeing yesterday's afternoon included, because the server computed a UTC day, is
 * a bug that quietly discredits every other number on the page. Ethiopia is UTC+3 with no
 * daylight saving, so the failure is a silent three-hour smear rather than an obvious break.
 *
 * Everything here returns **UTC instants**. Timestamps are stored as `timestamptz` and compared
 * as instants; the timezone matters only for deciding where the boundaries fall, never for how
 * a row is stored. A function that returned a "local Date" would be inviting the caller to
 * compare it against a stored instant and be wrong by the offset.
 *
 * No dependency is added. `Intl.DateTimeFormat` already knows every IANA zone the platform
 * supports, and deriving the offset from it is a dozen lines that cannot drift from the
 * tzdata the rest of the application formats with.
 */

/**
 * The offset of `instant` in `timezone`, in minutes east of UTC.
 *
 * Derived by formatting the instant in the target zone, reading the wall-clock components back,
 * and asking how far they are from the same components read as UTC. That is the only approach
 * that stays correct across daylight saving without shipping a tz database of its own.
 */
function offsetMinutes(instant: Date, timezone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(instant);

  const read = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((part) => part.type === type)?.value ?? '0');

  // `hour12: false` yields 24 for midnight in some ICU versions. Normalised, or the boundary
  // computed from it lands a day out — exactly the class of bug this module exists to prevent.
  const hour = read('hour') % 24;

  const asUtc = Date.UTC(
    read('year'),
    read('month') - 1,
    read('day'),
    hour,
    read('minute'),
    read('second'),
  );

  return Math.round((asUtc - instant.getTime()) / 60_000);
}

/** The calendar date in `timezone` at `instant`, as its year, month and day components. */
export function localCalendarDate(
  instant: Date,
  timezone: string,
): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(instant);

  const read = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((part) => part.type === type)?.value ?? '0');

  return { year: read('year'), month: read('month'), day: read('day') };
}

/** `YYYY-MM-DD` for the organization-local calendar date. The key a daily snapshot is filed under. */
export function localDateKey(instant: Date, timezone: string): string {
  const { year, month, day } = localCalendarDate(instant, timezone);
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * The UTC instant at which a local calendar date begins.
 *
 * The offset is applied twice on purpose. The first pass uses the offset at the naive guess,
 * which is right except when the guess falls on the other side of a daylight-saving change from
 * the true boundary; the second pass corrects that. Ethiopia never needs the correction, and a
 * helper that only worked for Ethiopia would be a trap for the first organization elsewhere.
 */
export function startOfLocalDay(
  timezone: string,
  date: { year: number; month: number; day: number },
): Date {
  const naive = Date.UTC(date.year, date.month - 1, date.day, 0, 0, 0, 0);

  const firstGuess = new Date(naive - offsetMinutes(new Date(naive), timezone) * 60_000);
  const corrected = new Date(naive - offsetMinutes(firstGuess, timezone) * 60_000);

  return corrected;
}

export interface Period {
  /** Inclusive. */
  readonly start: Date;
  /** Exclusive — a half-open interval, so an event at exactly midnight belongs to one day only. */
  readonly end: Date;
}

/**
 * The organization-local day containing `asOf`, as a half-open UTC interval.
 *
 * Half-open is the load-bearing detail. With two inclusive bounds, an order created at exactly
 * 00:00:00 local would be counted in both the day that ended and the day that began, and the two
 * daily figures would not sum to the week.
 */
export function localDay(timezone: string, asOf: Date): Period {
  const today = localCalendarDate(asOf, timezone);
  const start = startOfLocalDay(timezone, today);
  const end = startOfLocalDay(timezone, addDays(today, 1));
  return { start, end };
}

/** The local day before the one containing `asOf`. */
export function previousLocalDay(timezone: string, asOf: Date): Period {
  const today = localCalendarDate(asOf, timezone);
  return {
    start: startOfLocalDay(timezone, addDays(today, -1)),
    end: startOfLocalDay(timezone, today),
  };
}

/**
 * The last `days` local days ending with the day containing `asOf`, inclusive.
 *
 * `lastLocalDays(tz, now, 7)` is "the last seven days including today", which is what an owner
 * means by it. Six days back plus today.
 */
export function lastLocalDays(timezone: string, asOf: Date, days: number): Period {
  const today = localCalendarDate(asOf, timezone);
  return {
    start: startOfLocalDay(timezone, addDays(today, -(days - 1))),
    end: startOfLocalDay(timezone, addDays(today, 1)),
  };
}

/** The `days`-long window immediately before `lastLocalDays(timezone, asOf, days)`. */
export function precedingLocalDays(timezone: string, asOf: Date, days: number): Period {
  const today = localCalendarDate(asOf, timezone);
  return {
    start: startOfLocalDay(timezone, addDays(today, -(days * 2 - 1))),
    end: startOfLocalDay(timezone, addDays(today, -(days - 1))),
  };
}

/** Each local day in a period, oldest first. For a seven-day series with no gaps. */
export function localDaysIn(timezone: string, asOf: Date, days: number): Period[] {
  const today = localCalendarDate(asOf, timezone);
  const out: Period[] = [];
  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const date = addDays(today, -offset);
    out.push({
      start: startOfLocalDay(timezone, date),
      end: startOfLocalDay(timezone, addDays(date, 1)),
    });
  }
  return out;
}

function addDays(
  date: { year: number; month: number; day: number },
  delta: number,
): { year: number; month: number; day: number } {
  // Arithmetic in UTC, where days are always 24 hours. Adding to a local wall clock would be
  // wrong across a daylight-saving change; adding to a calendar date never is.
  const shifted = new Date(Date.UTC(date.year, date.month - 1, date.day + delta));
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

/** True when `instant` falls inside the half-open period. */
export function within(period: Period, instant: Date): boolean {
  return instant.getTime() >= period.start.getTime() && instant.getTime() < period.end.getTime();
}

/**
 * Where a `@db.Date` column sits relative to the organization-local today.
 *
 * Returns a negative number for a past date, 0 for today, positive for the future — the number
 * itself is the difference in whole days.
 *
 * `payment_due_date` is a bare calendar date with no time and no zone, so it has to be compared
 * as a calendar date. Turning it into an instant and comparing against `now` would make an
 * invoice due today read as overdue for the first three hours of every Ethiopian morning, which
 * is the single most visible way this dashboard could lie.
 */
export function compareDateToLocalToday(dueDate: Date, timezone: string, asOf: Date): number {
  const today = localCalendarDate(asOf, timezone);
  // A Prisma `Date` column arrives as midnight UTC; its UTC components *are* the calendar date.
  const dueUtc = Date.UTC(
    dueDate.getUTCFullYear(),
    dueDate.getUTCMonth(),
    dueDate.getUTCDate(),
  );
  const todayUtc = Date.UTC(today.year, today.month - 1, today.day);

  return Math.round((dueUtc - todayUtc) / 86_400_000);
}

/** True when the due date is today or already past, in organization-local terms. */
export function isOnOrBeforeLocalToday(dueDate: Date, timezone: string, asOf: Date): boolean {
  return compareDateToLocalToday(dueDate, timezone, asOf) <= 0;
}
