// Unit tests for the relay pin store (TOFU host-key verification, CLI side).
// Pure filesystem + comparison logic — the wire half lives in relay-client.test.js.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadPins, savePin, createPinCheck } from './known-relays.js';

const FP_A = 'SHA256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const FP_B = 'SHA256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

function tempStore(t) {
  const dir = mkdtempSync(join(tmpdir(), 'cs-pins-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, 'known_relays.json');
}

test('known-relays: first sighting pins, same key matches, a changed key mismatches', (t) => {
  const file = tempStore(t);

  // First contact: adopt the identity and persist it.
  const first = createPinCheck({ key: 'relay.example:2222', file });
  assert.equal(first.verify(FP_A), true, 'first contact proceeds');
  assert.equal(first.outcome(), 'first-seen');
  assert.equal(loadPins(file)['relay.example:2222'], FP_A, 'the pin is stored');

  // Next run, same identity: clean match.
  const again = createPinCheck({ key: 'relay.example:2222', file });
  assert.equal(again.verify(FP_A), true);
  assert.equal(again.outcome(), 'match');

  // Next run, DIFFERENT identity: refuse, and report both sides for the warning.
  const changed = createPinCheck({ key: 'relay.example:2222', file });
  assert.equal(changed.verify(FP_B), false, 'a changed key is refused');
  assert.equal(changed.outcome(), 'mismatch');
  assert.equal(changed.expected(), FP_A);
  assert.equal(changed.seen(), FP_B);
  assert.equal(loadPins(file)['relay.example:2222'], FP_A, 'a mismatch never overwrites the pin');
});

test('known-relays: an explicit expected fingerprint pins without consulting the store', (t) => {
  const file = tempStore(t);
  savePin(file, 'relay.example:2222', FP_A); // a stale TOFU pin that must NOT win

  const pin = createPinCheck({ key: 'relay.example:2222', file, expected: FP_B });
  assert.equal(pin.verify(FP_B), true, '--fingerprint is the sole authority');
  assert.equal(pin.outcome(), 'match');

  const veto = createPinCheck({ key: 'relay.example:2222', file, expected: FP_B });
  assert.equal(veto.verify(FP_A), false, 'even the stored pin cannot override an explicit one');
  assert.equal(veto.outcome(), 'mismatch');
});

test('known-relays: pins are per host:port; a corrupt store reads as empty', (t) => {
  const file = tempStore(t);
  savePin(file, 'a.example:2222', FP_A);
  savePin(file, 'b.example:2222', FP_B);
  assert.deepEqual(loadPins(file), { 'a.example:2222': FP_A, 'b.example:2222': FP_B });

  // Two relays, two independent identities.
  const b = createPinCheck({ key: 'b.example:2222', file });
  assert.equal(b.verify(FP_B), true);
  assert.equal(b.outcome(), 'match');

  // Corruption (a bad write, a stray editor) degrades to "no pins", never a crash.
  writeFileSync(file, 'not json{{{');
  assert.deepEqual(loadPins(file), {});
  const fresh = createPinCheck({ key: 'a.example:2222', file });
  assert.equal(fresh.verify(FP_B), true, 'a wiped store re-pins on first use');
  assert.equal(fresh.outcome(), 'first-seen');
  assert.equal(JSON.parse(readFileSync(file, 'utf8'))['a.example:2222'], FP_B);
});
