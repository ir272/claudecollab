// Relay identity pinning — the CLI-side half of host-key verification (spec
// §trust: the host must know it is talking to ITS relay, not an impersonator).
// Works like ssh's known_hosts, trust-on-first-use: the first connection to a
// relay stores its SHA256:… key fingerprint under "host:port"; every later
// connection must present the same one or the CLI refuses to connect.
//
// An explicit expected fingerprint (--fingerprint, e.g. copied from the relay's
// boot log) skips the store entirely and pins exactly that value.

import fs from 'node:fs';
import path from 'node:path';

/** Read the pin store (a flat {"host:port": "SHA256:…"} map). Missing/corrupt ⇒ empty. */
export function loadPins(file) {
  try {
    const o = JSON.parse(fs.readFileSync(file, 'utf8'));
    return o !== null && typeof o === 'object' && !Array.isArray(o) ? o : {};
  } catch {
    return {};
  }
}

/** Persist one pin. Best-effort: an unwritable home degrades to session-only TOFU. */
export function savePin(file, key, fp) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const pins = loadPins(file);
    pins[key] = fp;
    fs.writeFileSync(file, JSON.stringify(pins, null, 2) + '\n', { mode: 0o600 });
  } catch {
    /* home not writable — the in-memory pin still guards this run */
  }
}

/**
 * One pin check per connection attempt, handed to connectRelay's verifyHostKey.
 * `verify` returns whether to proceed; afterwards `outcome()` says what happened
 * so the caller can tell a mismatch (scary, do not retry) from a plain failure.
 *
 * @param {object} opts
 * @param {string} opts.key         store key, "host:port"
 * @param {string} opts.file        pin-store path (~/.claude-share/known_relays.json)
 * @param {string} [opts.expected]  explicit fingerprint; when set the store is not consulted
 * @returns {{verify(fp:string):boolean, outcome():'first-seen'|'match'|'mismatch'|null, expected():string|null, seen():string|null}}
 */
export function createPinCheck({ key, file, expected }) {
  let want = expected ?? null;
  let outcome = null;
  let seen = null;
  const verify = (fp) => {
    seen = fp;
    if (!want) {
      want = loadPins(file)[key] ?? null;
      if (!want) {
        // First contact: adopt and store this identity (TOFU, like ssh).
        savePin(file, key, fp);
        want = fp;
        outcome = 'first-seen';
        return true;
      }
    }
    outcome = fp === want ? 'match' : 'mismatch';
    return outcome === 'match';
  };
  return { verify, outcome: () => outcome, expected: () => want, seen: () => seen };
}
