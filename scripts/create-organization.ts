/**
 * Creates a real organization and its first owner.
 *
 * Phase 9's assessment listed "there is no way to create the first real organization except
 * editing a seed file" as a production blocker, and it was: the seed also fabricates customers,
 * invents prices and — in the fulfilment scenarios — temporarily disables an immutability
 * trigger. Nobody should have to read all of that to onboard a distributor, and nobody should be
 * one uncommented line away from loading fiction into a real deployment.
 *
 * This creates exactly four things: an organization, its settings, a user, and an owner
 * membership. No customers, no products, no demo anything. Catalogue and customers arrive
 * through the import command, from the distributor's own spreadsheets.
 *
 * Usage:
 *   pnpm admin:create-organization \
 *     --name "Addis Build Supply PLC" \
 *     --timezone Africa/Addis_Ababa \
 *     --owner-email owner@example.com \
 *     --owner-name "Selamawit Bekele"
 *
 * The generated password is printed **once**, to stdout, and never logged, never stored in
 * plain text, and never written to a file. If it is lost, run the password reset rather than
 * looking for it somewhere — because there is nowhere.
 */
import { randomBytes } from 'node:crypto';
import { config as loadEnv } from 'dotenv';
import { PrismaClient } from '@prisma/client';
import { hashPassword } from '../src/platform/security/passwords';

loadEnv();

interface Args {
  name?: string;
  timezone?: string;
  currency?: string;
  ownerEmail?: string;
  ownerName?: string;
  password?: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith('--') || value === undefined) continue;

    switch (flag) {
      case '--name':
        args.name = value;
        break;
      case '--timezone':
        args.timezone = value;
        break;
      case '--currency':
        args.currency = value;
        break;
      case '--owner-email':
        args.ownerEmail = value;
        break;
      case '--owner-name':
        args.ownerName = value;
        break;
      /*
       * Accepted, and discouraged in the help text.
       *
       * A password on a command line lands in the shell history and in the process table, where
       * anyone on the box can read it. It exists because some provisioning systems have no way
       * to capture generated output, and the alternative would be that they invent something
       * worse.
       */
      case '--password':
        args.password = value;
        break;
    }
  }
  return args;
}

/**
 * A generated password with real entropy and no ambiguous characters.
 *
 * The owner will read this off a screen and type it once. Removing the characters people
 * confuse (0/O, 1/l/I) costs a fraction of a bit and saves a support call.
 */
function generatePassword(): string {
  const alphabet = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(24);
  let out = '';
  for (const byte of bytes) out += alphabet[byte % alphabet.length];
  return out;
}

function fail(message: string): never {
  console.error(`\n${message}\n`);
  process.exit(1);
}

function isValidTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!args.name || !args.ownerEmail || !args.ownerName) {
    fail(
      'Usage:\n' +
        '  pnpm admin:create-organization \\\n' +
        '    --name "Distributor Name" \\\n' +
        '    --owner-email owner@example.com \\\n' +
        '    --owner-name "Full Name" \\\n' +
        '    [--timezone Africa/Addis_Ababa] [--currency ETB]\n\n' +
        'A password is generated and printed once. Passing --password puts a secret in your\n' +
        'shell history and in the process table; prefer the generated one.',
    );
  }

  const timezone = args.timezone ?? 'Africa/Addis_Ababa';
  if (!isValidTimezone(timezone)) {
    fail(`"${timezone}" is not a timezone this platform recognises. Use an IANA name.`);
  }

  const email = args.ownerEmail.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    fail(`"${email}" does not look like an email address.`);
  }

  const currency = (args.currency ?? 'ETB').toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) fail(`"${currency}" is not an ISO-4217 currency code.`);

  const password = args.password ?? generatePassword();
  const generated = !args.password;

  // The owner's role, not the app role: this creates rows before any organization exists, so
  // there is no tenant context for RLS to scope by.
  const url = process.env.DIRECT_URL ?? process.env.DATABASE_URL;
  if (!url) fail('DIRECT_URL or DATABASE_URL must be set.');

  const prisma = new PrismaClient({ datasources: { db: { url } } });

  try {
    const existingUser = await prisma.user.findUnique({ where: { email } });
    const existingOrg = await prisma.organization.findFirst({ where: { name: args.name } });

    if (existingOrg) {
      fail(
        `An organization named "${args.name}" already exists.\n` +
          'Refusing rather than creating a second one with the same name — two organizations a\n' +
          'person cannot tell apart is a worse problem than this error.',
      );
    }

    const passwordHash = await hashPassword(password);

    /*
     * One transaction. A half-created organization — rows but no owner, or an owner with no
     * membership — is an account nobody can sign in to and nobody can easily clean up.
     */
    const created = await prisma.$transaction(async (tx) => {
      const organization = await tx.organization.create({
        data: {
          name: args.name!,
          currency,
          timezone,
          settings: { create: {} },
        },
      });

      const user =
        existingUser ??
        (await tx.user.create({
          data: { email, fullName: args.ownerName!, passwordHash },
        }));

      await tx.membership.create({
        data: { organizationId: organization.id, userId: user.id, role: 'OWNER_ADMIN' },
      });

      return { organization, user, reusedUser: Boolean(existingUser) };
    });

    console.log('');
    console.log('Organization created.');
    console.log('');
    console.log(`  Name        ${created.organization.name}`);
    console.log(`  Id          ${created.organization.id}`);
    console.log(`  Timezone    ${created.organization.timezone}`);
    console.log(`  Currency    ${created.organization.currency}`);
    console.log('');
    console.log(`  Owner       ${created.user.fullName} <${created.user.email}>`);

    if (created.reusedUser) {
      console.log('');
      console.log('  This email already existed, so the person was given an owner membership of');
      console.log('  the new organization. Their existing password is unchanged.');
    } else if (generated) {
      console.log('');
      console.log('  Password    ' + password);
      console.log('');
      console.log('  Shown once. It is stored only as a scrypt hash and cannot be recovered.');
      console.log('  Give it to the owner over a channel you trust and have them change it.');
    }

    console.log('');
    console.log('Next: pnpm admin:import --help to load customers, products and opening stock.');
    console.log('');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
