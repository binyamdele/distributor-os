/**
 * Identifier shape checking.
 *
 * Every id in this system is a UUID that arrives from a URL segment, which means it arrives
 * from whoever is typing in the address bar. Passing `not-a-uuid` straight to Prisma raises
 * `Inconsistent column data: Error creating UUID`, and passing it to a `::uuid` cast in raw SQL
 * raises `invalid input syntax for type uuid` — both of which surface as a 500 error page for
 * what is simply a request for something that does not exist.
 *
 * The distinction matters beyond tidiness. A 500 says "you broke something"; a 404 says "there
 * is nothing here". Someone probing for another organization's records should learn nothing
 * from the difference between a malformed id, an id belonging to another tenant, and an id that
 * was never issued — all three must look identical, and the only way to get that is to stop the
 * malformed one before it reaches the database.
 */
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}
