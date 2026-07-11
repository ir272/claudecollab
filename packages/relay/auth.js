// Shared credential comparison for both relay doors (ssh server.js, web web.js).

import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * Constant-time string comparison via digests (equal-length inputs for
 * timingSafeEqual, and no length leak from the secret itself). Non-strings
 * never match. Used for the relay ROOM_SECRET and per-room join passwords.
 * @param {unknown} a
 * @param {unknown} b
 * @returns {boolean}
 */
export function secretsMatch(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const da = createHash('sha256').update(a).digest();
  const db = createHash('sha256').update(b).digest();
  return timingSafeEqual(da, db);
}
