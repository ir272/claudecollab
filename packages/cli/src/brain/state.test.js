import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RoomState, ROLE_RANK, atLeast, FLOOR_COLS, FLOOR_ROWS, HOST_ID } from './state.js';

// ── role ranking ────────────────────────────────────────────────────────────

test('ROLE_RANK orders viewer < prompter < driver < host', () => {
  assert.ok(ROLE_RANK.viewer < ROLE_RANK.prompter);
  assert.ok(ROLE_RANK.prompter < ROLE_RANK.driver);
  assert.ok(ROLE_RANK.driver < ROLE_RANK.host);
});

test('atLeast compares roles, failing closed on unknowns', () => {
  assert.equal(atLeast('driver', 'prompter'), true);
  assert.equal(atLeast('prompter', 'driver'), false);
  assert.equal(atLeast('host', 'host'), true);
  assert.equal(atLeast('viewer', 'viewer'), true);
  assert.equal(atLeast(undefined, 'viewer'), false, 'unknown role is below everything');
  assert.equal(atLeast('host', 'nope'), false, 'unknown floor is unreachable');
});

// ── participants & roles ──────────────────────────────────────────────────────

test('a fresh state has the host as the only participant', () => {
  const s = new RoomState({ hostName: 'ian' });
  assert.equal(s.list().length, 1);
  assert.equal(s.roleOf(HOST_ID), 'host');
  assert.equal(s.nameOf(HOST_ID), 'ian');
  assert.deepEqual(s.guests(), []);
});

test('guests default to prompter and can be overridden', () => {
  const s = new RoomState();
  const g = s.addGuest('g1', { name: 'siddh', fp: 'SHA256:abc' });
  assert.equal(g.role, 'prompter');
  assert.equal(s.roleOf('g1'), 'prompter');
  const s2 = new RoomState({ defaultRole: 'viewer' });
  assert.equal(s2.addGuest('g2', { name: 'x' }).role, 'viewer');
});

test('setRole changes a guest role but refuses host and unknown roles', () => {
  const s = new RoomState();
  s.addGuest('g1', { name: 'siddh' });
  assert.equal(s.setRole('g1', 'driver'), true);
  assert.equal(s.roleOf('g1'), 'driver');
  assert.equal(s.setRole('g1', 'host'), false, 'cannot promote a guest to host');
  assert.equal(s.setRole('g1', 'wizard'), false, 'unknown role rejected');
  assert.equal(s.roleOf('g1'), 'driver', 'role unchanged after a rejected set');
  assert.equal(s.setRole(HOST_ID, 'viewer'), false, 'cannot demote the host');
  assert.equal(s.setRole('nobody', 'driver'), false);
});

test('removeGuest drops a guest but never the host', () => {
  const s = new RoomState();
  s.addGuest('g1', { name: 'a' });
  assert.equal(s.removeGuest('g1'), true);
  assert.equal(s.get('g1'), undefined);
  assert.equal(s.removeGuest(HOST_ID), false);
  assert.equal(s.roleOf(HOST_ID), 'host');
});

// ── reconnect: role restore by fingerprint (spec §identity) ─────────────────────

test('a returning fingerprint resumes the role it last held this session', () => {
  const s = new RoomState({ defaultRole: 'prompter' });
  s.addGuest('c1', { name: 'siddh', fp: 'SHA256:sid' });
  s.setRole('c1', 'driver'); // host promoted siddh
  s.removeGuest('c1'); // wifi drops

  // Same key reconnects under a NEW connection id, at the room default again…
  const g = s.addGuest('c2', { name: 'siddh', fp: 'SHA256:sid', role: 'prompter' });
  assert.equal(g.role, 'driver', 'the prior role is restored, not the default');
  assert.equal(s.roleOf('c2'), 'driver');
});

test('a fresh fingerprint gets the explicit/default role, not a stranger’s seat', () => {
  const s = new RoomState({ defaultRole: 'viewer' });
  s.addGuest('c1', { name: 'sid', fp: 'SHA256:sid' });
  s.setRole('c1', 'driver');
  s.removeGuest('c1');
  const other = s.addGuest('c2', { name: 'mallory', fp: 'SHA256:mallory' });
  assert.equal(other.role, 'viewer', 'a different key is not handed the departed driver’s role');
});

test('a keyless guest is never remembered — reconnect is a new session-only seat', () => {
  const s = new RoomState({ defaultRole: 'prompter' });
  const g1 = s.addGuest('c1', { name: 'anon', fp: null });
  s.setRole('c1', 'driver');
  s.removeGuest('c1');
  const g2 = s.addGuest('c2', { name: 'anon', fp: null, role: 'prompter' });
  assert.equal(g2.role, 'prompter', 'keyless rejoin starts fresh (no role restore)');
  assert.notEqual(g1.id, g2.id);
});

test('the latest role held wins when a key reconnects more than once', () => {
  const s = new RoomState({ defaultRole: 'prompter' });
  s.addGuest('c1', { name: 'sid', fp: 'SHA256:sid' });
  s.setRole('c1', 'driver');
  s.removeGuest('c1');
  const g2 = s.addGuest('c2', { name: 'sid', fp: 'SHA256:sid', role: 'prompter' });
  assert.equal(g2.role, 'driver');
  s.setRole('c2', 'viewer'); // demoted, then drops again
  s.removeGuest('c2');
  const g3 = s.addGuest('c3', { name: 'sid', fp: 'SHA256:sid', role: 'prompter' });
  assert.equal(g3.role, 'viewer', 'the most recent role is the one restored');
});

// ── mode & pause ──────────────────────────────────────────────────────────────

test('setMode reports whether the mode actually changed', () => {
  const s = new RoomState();
  assert.equal(s.mode, 'default');
  assert.equal(s.setMode('accept-edits'), true);
  assert.equal(s.mode, 'accept-edits');
  assert.equal(s.setMode('accept-edits'), false, 'no change → false');
});

test('setPaused toggles the pause flag', () => {
  const s = new RoomState();
  assert.equal(s.paused, false);
  s.setPaused(true);
  assert.equal(s.paused, true);
  s.setPaused(false);
  assert.equal(s.paused, false);
});

// ── size clamp (spec §renderer) ────────────────────────────────────────────────

test('clamp floors the shared view at 80x24 when everyone is at least that big', () => {
  const s = new RoomState({ hostSize: { cols: 120, rows: 40 } });
  s.addGuest('g1', { name: 'a' });
  s.setSize('g1', 100, 30);
  assert.deepEqual(s.clamp(), { cols: 100, rows: 30 }, 'min of qualifying participants');
});

test('clamp never drops below the 80x24 floor', () => {
  const s = new RoomState({ hostSize: { cols: 120, rows: 40 } });
  s.addGuest('g1', { name: 'a' });
  s.setSize('g1', 85, 24);
  assert.deepEqual(s.clamp(), { cols: 85, rows: 24 });
});

test('a below-floor participant spectates and does not shrink the shared view', () => {
  const s = new RoomState({ hostSize: { cols: 120, rows: 40 } });
  s.addGuest('small', { name: 'tiny' });
  s.setSize('small', 60, 20); // below the floor
  assert.equal(s.belowFloor('small'), true);
  assert.equal(s.belowFloor(HOST_ID), false);
  // small is excluded from the min; host (120x40) alone qualifies → clamp to host.
  assert.deepEqual(s.clamp(), { cols: 120, rows: 40 });
});

test('clamp falls back to the floor when no participant reports a size', () => {
  const s = new RoomState();
  assert.deepEqual(s.clamp(), { cols: FLOOR_COLS, rows: FLOOR_ROWS });
});

test('ageMs measures elapsed time from an injected clock', () => {
  let t = 1000;
  const s = new RoomState({ now: () => t });
  t = 1000 + 42 * 60 * 1000;
  assert.equal(s.ageMs(), 42 * 60 * 1000);
});
