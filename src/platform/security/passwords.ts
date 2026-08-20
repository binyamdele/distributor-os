import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

/**
 * scrypt from Node's standard library rather than Argon2 from a native module: no compiler
 * toolchain, no postinstall step, and no binary that has to be rebuilt for the pilot machine.
 *
 * N=2^15 with r=8 is the commonly cited interactive-login setting. The parameters are encoded
 * in the stored hash, so they can be raised later without invalidating existing credentials.
 *
 * Ported from CommerceOS `packages/security/src/passwords.ts`.
 */
const PARAMS = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 } as const;
const KEY_BYTES = 64;
const SALT_BYTES = 16;

export const MINIMUM_PASSWORD_LENGTH = 12;

export async function hashPassword(password: string): Promise<string> {
  if (password.length < MINIMUM_PASSWORD_LENGTH) {
    throw new Error(`password must be at least ${MINIMUM_PASSWORD_LENGTH} characters`);
  }
  const salt = randomBytes(SALT_BYTES);
  const derived = await scrypt(password, salt, KEY_BYTES, PARAMS);
  return ['scrypt', PARAMS.N, PARAMS.r, PARAMS.p, salt.toString('base64'), derived.toString('base64')].join(
    '$',
  );
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

  const [, nRaw, rRaw, pRaw, saltB64, hashB64] = parts as [
    string,
    string,
    string,
    string,
    string,
    string,
  ];
  const expected = Buffer.from(hashB64, 'base64');

  try {
    const derived = await scrypt(password, Buffer.from(saltB64, 'base64'), expected.length, {
      N: Number(nRaw),
      r: Number(rRaw),
      p: Number(pRaw),
      maxmem: PARAMS.maxmem,
    });
    return derived.length === expected.length && timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

/** Opaque session token. Returned once, to the cookie; only its hash is persisted. */
export function generateToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}
