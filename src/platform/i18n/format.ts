import type { Locale } from './messages';

/**
 * Date and quantity formatting.
 *
 * Isolated in one module for two reasons. The obvious one is locale. The less obvious one is
 * that Ethiopia keeps its own calendar, and a pilot that outgrows Gregorian display will need
 * to change the calendar in one place rather than in ninety components. Nothing here converts
 * calendars today — it only makes doing so later a contained change.
 *
 * The timezone is always the organization's, never the server's. A distributor in Addis
 * reading "yesterday" on a report because the server runs in UTC is a bug that erodes trust in
 * every other number on the page.
 */
export const ETHIOPIA_TIMEZONE = 'Africa/Addis_Ababa';

const LOCALE_TAGS: Record<Locale, string> = {
  en: 'en-GB',
  am: 'am-ET',
};

export function formatDate(
  value: Date,
  locale: Locale = 'en',
  timezone: string = ETHIOPIA_TIMEZONE,
): string {
  return new Intl.DateTimeFormat(LOCALE_TAGS[locale], {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    timeZone: timezone,
  }).format(value);
}

export function formatDateTime(
  value: Date,
  locale: Locale = 'en',
  timezone: string = ETHIOPIA_TIMEZONE,
): string {
  return new Intl.DateTimeFormat(LOCALE_TAGS[locale], {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: timezone,
  }).format(value);
}

/** Quantities are whole units of the product's unit of measure: 500 bags, 80 pieces. */
export function formatQuantity(value: number, unit: string, locale: Locale = 'en'): string {
  return `${new Intl.NumberFormat(LOCALE_TAGS[locale]).format(value)} ${unit}`;
}
