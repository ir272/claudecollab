import { test } from 'node:test';
import assert from 'node:assert/strict';
import { foldKnock } from './knocks.js';

const k = (id, fp, name = id) => ({ id, name, fp, seen: null });

test('a first knock is simply appended, nothing replaced', () => {
  const { pending, replaced } = foldKnock([], k('a', 'web:tok-a'));
  assert.deepEqual(pending.map((x) => x.id), ['a']);
  assert.deepEqual(replaced, []);
});

test('a re-knock from the same fingerprint REPLACES the prior card (finding 3)', () => {
  // The live bug: a WS reconnect during the join flow re-knocks with a new id but the
  // same fp. Only ONE pending knock (the newest) should remain; the stale id is denied.
  const first = foldKnock([], k('conn-1', 'web:tok-sid')).pending;
  const { pending, replaced } = foldKnock(first, k('conn-2', 'web:tok-sid'));
  assert.equal(pending.length, 1, 'exactly one pending knock for the fingerprint');
  assert.equal(pending[0].id, 'conn-2', 'the newest connection wins');
  assert.deepEqual(replaced, ['conn-1'], 'the stale connection is reported for denial');
});

test('a different fingerprint is a distinct guest and coexists', () => {
  const one = foldKnock([], k('a', 'web:tok-a')).pending;
  const { pending, replaced } = foldKnock(one, k('b', 'web:tok-b'));
  assert.deepEqual(pending.map((x) => x.id), ['a', 'b']);
  assert.deepEqual(replaced, []);
});

test('keyless guests (empty fp) are never deduped — each anonymous knock is distinct', () => {
  const one = foldKnock([], k('anon-1', '')).pending;
  const { pending, replaced } = foldKnock(one, k('anon-2', ''));
  assert.deepEqual(pending.map((x) => x.id), ['anon-1', 'anon-2'], 'both keyless knocks kept');
  assert.deepEqual(replaced, []);
});

test('a returning fingerprint that re-knocks twice collapses to one', () => {
  let list = [];
  list = foldKnock(list, k('c1', 'web:t')).pending;
  const r2 = foldKnock(list, k('c2', 'web:t'));
  list = r2.pending;
  const r3 = foldKnock(list, k('c3', 'web:t'));
  assert.equal(r3.pending.length, 1);
  assert.equal(r3.pending[0].id, 'c3');
  assert.deepEqual(r3.replaced, ['c2']);
});
