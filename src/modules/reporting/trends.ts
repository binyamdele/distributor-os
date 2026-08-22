/**
 * Deterministic period-over-period comparison.
 *
 * Two periods, subtraction, division. No forecasting, no extrapolation, no seasonality, no
 * moving averages — and above all no causal claim. The dashboard may say a figure is higher than
 * last week; it may not say why, because nothing in this system knows why.
 *
 * The interesting cases are all divisions by zero, and there are three of them with genuinely
 * different meanings. Collapsing them into "0%" is how a dashboard ends up telling an owner
 * their sales fell 100% on their first quiet Sunday.
 */

export type TrendDirection = 'UP' | 'DOWN' | 'FLAT';

export interface Trend {
  readonly current: number;
  readonly previous: number;
  readonly absoluteChange: number;
  /**
   * Fractional change, or `null` when it is undefined.
   *
   * `null` means "there is no percentage to state", not "no change". It arises when the previous
   * period was zero: going from nothing to something is not an increase of any percentage, and
   * every alternative — 0%, 100%, ∞ — says something untrue.
   */
  readonly percentChange: number | null;
  readonly direction: TrendDirection;
  /** True when neither period had anything. Renders as "no activity", not as "0%". */
  readonly bothEmpty: boolean;
}

export function compare(current: number, previous: number): Trend {
  const absoluteChange = current - previous;

  const direction: TrendDirection =
    absoluteChange > 0 ? 'UP' : absoluteChange < 0 ? 'DOWN' : 'FLAT';

  return {
    current,
    previous,
    absoluteChange,
    // Undefined against a zero base. The direction is still meaningful and still shown; only the
    // percentage is withheld, because it is the part that would be a fabrication.
    percentChange:
      previous === 0 ? null : Math.round((absoluteChange / previous) * 1000) / 1000,
    direction,
    bothEmpty: current === 0 && previous === 0,
  };
}

/**
 * The same comparison for money, which is held in bigint minor units.
 *
 * The subtraction stays exact; only the ratio becomes a float, and only for display. Converting
 * the amounts to numbers first would silently lose precision above 2^53 santim — which is
 * unreachable for a pilot distributor and is exactly the sort of assumption that ages badly.
 */
export interface MoneyTrend {
  readonly currentMinor: bigint;
  readonly previousMinor: bigint;
  readonly absoluteChangeMinor: bigint;
  readonly percentChange: number | null;
  readonly direction: TrendDirection;
  readonly bothEmpty: boolean;
}

export function compareMoney(currentMinor: bigint, previousMinor: bigint): MoneyTrend {
  const absoluteChangeMinor = currentMinor - previousMinor;

  return {
    currentMinor,
    previousMinor,
    absoluteChangeMinor,
    percentChange:
      previousMinor === 0n
        ? null
        : Math.round((Number(absoluteChangeMinor) / Number(previousMinor)) * 1000) / 1000,
    direction:
      absoluteChangeMinor > 0n ? 'UP' : absoluteChangeMinor < 0n ? 'DOWN' : 'FLAT',
    bothEmpty: currentMinor === 0n && previousMinor === 0n,
  };
}

/** How a trend should read. Returns null when there is nothing honest to say. */
export function describeTrend(trend: Trend | MoneyTrend): string | null {
  if (trend.bothEmpty) return null;
  if (trend.percentChange === null) return 'no comparison available';

  const percent = Math.abs(Math.round(trend.percentChange * 100));
  if (trend.direction === 'FLAT') return 'unchanged';
  return `${percent}% ${trend.direction === 'UP' ? 'higher' : 'lower'} than the period before`;
}
