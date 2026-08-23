/**
 * Operational visibility.
 *
 * Three small pieces that only matter together: a correlation id that ties a user's report to a
 * request, structured logs that redact what must never be shipped, and an error reporter behind
 * an adapter so a real provider is one class rather than a change everywhere.
 *
 * The measure of this module is a support call. A distributor says "it failed when I confirmed
 * the payment", reads out `req_7F3A…`, and the engineer finds the request — without a stack
 * trace, a SQL fragment or a file path ever having been shown to anyone outside the building.
 */
export * from './correlation';
export * from './logger';
export * from './errors';
export * from './health';
export * as rateLimit from './rate-limit';
export { RATE_LIMITS, type RateLimitName, type RateLimitVerdict } from './rate-limit';
