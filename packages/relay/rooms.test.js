import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createRegistry } from './rooms.js';
import { adjectives, animals } from './wordlists.js';

const TTL = 10 * 60 * 1000;

test('wordlists carry ~100 lowercase single-word entries each', () => {
  assert.ok(adjectives.length >= 100, `adjectives: ${adjectives.length}`);
  assert.ok(animals.length >= 100, `animals: ${animals.length}`);
  for (const w of [...adjectives, ...animals]) assert.match(w, /^[a-z]+$/);
  assert.equal(new Set(adjectives).size, adjectives.length, 'adjectives unique');
  assert.equal(new Set(animals).size, animals.length, 'animals unique');
});

test('create returns a unique adjective-animal room', () => {
  const reg = createRegistry();
  const room = reg.create();
  assert.equal(typeof room.code, 'string');
  assert.match(room.code, /^[a-z]+-[a-z]+$/);
  assert.equal(reg.get(room.code), room);
});

test('create never repeats a code across many rooms', () => {
  const reg = createRegistry();
  const seen = new Set();
  for (let i = 0; i < 300; i++) {
    const { code } = reg.create();
    assert.ok(!seen.has(code), `duplicate code ${code}`);
    seen.add(code);
  }
});

test('create falls back to a third word after collisions', () => {
  const reg = createRegistry({ wordlists: { adjectives: ['brave'], animals: ['otter'] } });
  const first = reg.create();
  assert.equal(first.code, 'brave-otter');
  const second = reg.create();
  assert.equal(second.code.split('-').length, 3, second.code);
  assert.notEqual(second.code, first.code);
});

test('get returns undefined for an unknown code', () => {
  const reg = createRegistry();
  assert.equal(reg.get('no-such-room'), undefined);
});

test('a fresh room has the documented shape', () => {
  const reg = createRegistry();
  const room = reg.create();
  assert.ok(room.guests instanceof Map);
  assert.ok(room.banned instanceof Set);
  assert.equal(room.cap, 8);
  assert.equal(room.guests.size, 0);
});

test('create honors a requested cap, clamped to [1, relayCap]', () => {
  const reg = createRegistry(); // relayCap defaults to 8
  assert.equal(reg.create({ cap: 2 }).cap, 2, 'a modest request is honored');
  assert.equal(reg.create({ cap: 99 }).cap, 8, 'clamped down to the relay ceiling');
  assert.equal(reg.create({ cap: 0 }).cap, 1, 'clamped up to at least 1');
  assert.equal(reg.create().cap, 8, 'no request → the relay ceiling');
});

test('cap: the room holds 8 guests and rejects the 9th', () => {
  const reg = createRegistry();
  const { code } = reg.create();
  for (let i = 0; i < 8; i++) {
    assert.equal(reg.addGuest(code, `g${i}`, { name: `n${i}`, fp: `fp${i}` }), true, `guest ${i}`);
  }
  assert.equal(reg.addGuest(code, 'g8', { name: 'n8', fp: 'fp8' }), false);
  assert.equal(reg.get(code).guests.size, 8);
});

test('addGuest defaults the role to prompter', () => {
  const reg = createRegistry();
  const { code } = reg.create();
  reg.addGuest(code, 'g1', { name: 'sid', fp: 'fp1' });
  assert.equal(reg.get(code).guests.get('g1').role, 'prompter');
});

test('a banned fingerprint cannot rejoin', () => {
  const reg = createRegistry();
  const { code } = reg.create();
  reg.addGuest(code, 'g1', { name: 'mallory', fp: 'evil' });
  reg.ban(code, 'evil');
  assert.ok(reg.get(code).banned.has('evil'));
  assert.equal(reg.get(code).guests.has('g1'), false, 'ban evicts current guest');
  assert.equal(reg.addGuest(code, 'g2', { name: 'mallory', fp: 'evil' }), false);
});

test('removeGuest drops a guest by id', () => {
  const reg = createRegistry();
  const { code } = reg.create();
  reg.addGuest(code, 'g1', { name: 'sid', fp: 'fp1' });
  assert.equal(reg.removeGuest(code, 'g1'), true);
  assert.equal(reg.get(code).guests.has('g1'), false);
});

test('TTL: hostDropped closes the room after 10 minutes', (t) => {
  mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => mock.timers.reset());
  const reg = createRegistry();
  const { code } = reg.create();
  reg.hostDropped(code);
  mock.timers.tick(TTL - 1000);
  assert.ok(reg.get(code), 'still open just before TTL');
  mock.timers.tick(2000);
  assert.equal(reg.get(code), undefined, 'closed once TTL elapses');
});

test('hostReturned cancels a pending TTL timer', (t) => {
  mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => mock.timers.reset());
  const reg = createRegistry();
  const { code } = reg.create();
  reg.hostDropped(code);
  mock.timers.tick(5 * 60 * 1000);
  reg.hostReturned(code);
  mock.timers.tick(TTL);
  assert.ok(reg.get(code), 'host came back, room stays open');
});

test('close removes the room immediately', () => {
  const reg = createRegistry();
  const { code } = reg.create();
  reg.close(code);
  assert.equal(reg.get(code), undefined);
});

test('tryKnock allows 5 attempts per minute per ip, then locks out', () => {
  let clock = 0;
  const reg = createRegistry({ now: () => clock });
  const { code } = reg.create();
  for (let i = 0; i < 5; i++) {
    assert.equal(reg.tryKnock(code, '1.2.3.4'), true, `knock ${i}`);
  }
  assert.equal(reg.tryKnock(code, '1.2.3.4'), false, 'locked out on the 6th');
  assert.equal(reg.tryKnock(code, '5.6.7.8'), true, 'a different ip is unaffected');
  clock += 61 * 1000; // window slides past
  assert.equal(reg.tryKnock(code, '1.2.3.4'), true, 'allowed again after the window');
});

test('tryKnock returns false for an unknown room', () => {
  const reg = createRegistry();
  assert.equal(reg.tryKnock('no-room', '1.2.3.4'), false);
});
