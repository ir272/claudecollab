import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RoomState, ROLE_RANK, atLeast, FLOOR_COLS, FLOOR_ROWS, HOST_ID, PALETTE } from './state.js';

// ── role ranking ────────────────────────────────────────────────────────────

test('ROLE_RANK orders viewer < prompter < host', () => {
  assert.ok(ROLE_RANK.viewer < ROLE_RANK.prompter);
  assert.ok(ROLE_RANK.prompter < ROLE_RANK.host);
});

test('atLeast compares roles, failing closed on unknowns', () => {
  assert.equal(atLeast('host', 'prompter'), true);
  assert.equal(atLeast('prompter', 'host'), false);
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
  assert.equal(s.setRole('g1', 'prompter'), true);
  assert.equal(s.roleOf('g1'), 'prompter');
  assert.equal(s.setRole('g1', 'host'), false, 'cannot promote a guest to host');
  assert.equal(s.setRole('g1', 'wizard'), false, 'unknown role rejected');
  assert.equal(s.roleOf('g1'), 'prompter', 'role unchanged after a rejected set');
  assert.equal(s.setRole(HOST_ID, 'viewer'), false, 'cannot demote the host');
  assert.equal(s.setRole('nobody', 'prompter'), false);
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
  s.setRole('c1', 'prompter'); // host promoted siddh
  s.removeGuest('c1'); // wifi drops

  // Same key reconnects under a NEW connection id, at the room default again…
  const g = s.addGuest('c2', { name: 'siddh', fp: 'SHA256:sid', role: 'prompter' });
  assert.equal(g.role, 'prompter', 'the prior role is restored, not the default');
  assert.equal(s.roleOf('c2'), 'prompter');
});

test('a fresh fingerprint gets the explicit/default role, not a stranger’s seat', () => {
  const s = new RoomState({ defaultRole: 'viewer' });
  s.addGuest('c1', { name: 'sid', fp: 'SHA256:sid' });
  s.setRole('c1', 'prompter');
  s.removeGuest('c1');
  const other = s.addGuest('c2', { name: 'mallory', fp: 'SHA256:mallory' });
  assert.equal(other.role, 'viewer', 'a different key is not handed the departed prompter’s role');
});

test('a keyless guest is never remembered — reconnect is a new session-only seat', () => {
  const s = new RoomState({ defaultRole: 'prompter' });
  const g1 = s.addGuest('c1', { name: 'anon', fp: null });
  s.setRole('c1', 'prompter');
  s.removeGuest('c1');
  const g2 = s.addGuest('c2', { name: 'anon', fp: null, role: 'prompter' });
  assert.equal(g2.role, 'prompter', 'keyless rejoin starts fresh (no role restore)');
  assert.notEqual(g1.id, g2.id);
});

test('the latest role held wins when a key reconnects more than once', () => {
  const s = new RoomState({ defaultRole: 'prompter' });
  s.addGuest('c1', { name: 'sid', fp: 'SHA256:sid' });
  s.setRole('c1', 'prompter');
  s.removeGuest('c1');
  const g2 = s.addGuest('c2', { name: 'sid', fp: 'SHA256:sid', role: 'prompter' });
  assert.equal(g2.role, 'prompter');
  s.setRole('c2', 'viewer'); // demoted, then drops again
  s.removeGuest('c2');
  const g3 = s.addGuest('c3', { name: 'sid', fp: 'SHA256:sid', role: 'prompter' });
  assert.equal(g3.role, 'viewer', 'the most recent role is the one restored');
});

// ── stable participant colors (palette of 8, per fingerprint) ──────────────────

test('the palette has 8 distinct colors', () => {
  assert.equal(PALETTE.length, 8);
  assert.equal(new Set(PALETTE).size, 8, 'no duplicates');
});

test('the host and each guest get a color from the palette', () => {
  const s = new RoomState({ hostName: 'ian' });
  assert.ok(PALETTE.includes(s.colorOf(HOST_ID)));
  const g = s.addGuest('g1', { name: 'siddh', fp: 'SHA256:sid' });
  assert.ok(PALETTE.includes(g.color));
  assert.equal(s.colorOf('g1'), g.color);
});

test('distinct participants get distinct colors, assigned in palette order', () => {
  const s = new RoomState();
  const host = s.colorOf(HOST_ID);
  const a = s.addGuest('a', { name: 'a', fp: 'SHA256:a' }).color;
  const b = s.addGuest('b', { name: 'b', fp: 'SHA256:b' }).color;
  assert.deepEqual([host, a, b], PALETTE.slice(0, 3));
});

test('a returning fingerprint keeps its color across reconnects', () => {
  const s = new RoomState();
  const first = s.addGuest('c1', { name: 'sid', fp: 'SHA256:sid' }).color;
  s.removeGuest('c1');
  // Someone else joins in between, taking the next palette slot…
  s.addGuest('c2', { name: 'mallory', fp: 'SHA256:mal' });
  // …then sid returns under a new connection id but the same key.
  const again = s.addGuest('c3', { name: 'sid', fp: 'SHA256:sid' }).color;
  assert.equal(again, first, 'the color is reused for the returning fingerprint');
});

test('keyless guests get a session-only color that is not remembered', () => {
  const s = new RoomState();
  const g1 = s.addGuest('c1', { name: 'anon', fp: null });
  assert.ok(PALETTE.includes(g1.color));
  s.removeGuest('c1');
  // A new keyless seat is a fresh assignment (a later palette slot), never restored.
  s.addGuest('c2', { name: 'other', fp: 'SHA256:o' });
  const g3 = s.addGuest('c3', { name: 'anon2', fp: null });
  assert.ok(PALETTE.includes(g3.color));
});

test('colorOf returns null for an unknown participant', () => {
  const s = new RoomState();
  assert.equal(s.colorOf('nobody'), null);
});

test('colors wrap around the palette beyond 8 participants', () => {
  const s = new RoomState(); // host takes slot 0
  for (let i = 0; i < 8; i++) s.addGuest(`g${i}`, { name: `g${i}`, fp: `SHA256:${i}` });
  // slot 8 wraps to PALETTE[0] (same hue as the host); assignment never throws.
  assert.equal(s.colorOf('g7'), PALETTE[0]);
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

test('mirrorTargets excludes below-floor guests; spectators lists them', () => {
  const s = new RoomState({ hostSize: { cols: 120, rows: 40 } });
  s.addGuest('big', { name: 'big' });
  s.setSize('big', 100, 30); // above the floor → mirrored
  s.addGuest('small', { name: 'small' });
  s.setSize('small', 60, 20); // below the floor → spectates
  s.addGuest('unknown', { name: 'unknown' }); // no size yet → mirrored (not below floor)
  assert.deepEqual(s.mirrorTargets().sort(), ['big', 'unknown']);
  assert.deepEqual(s.spectators(), ['small']);
  // The host is never a mirror target or a spectator (guests only).
  assert.ok(!s.mirrorTargets().includes(HOST_ID));
});

test('mirrorTargets and spectators are empty in a solo room', () => {
  const s = new RoomState();
  assert.deepEqual(s.mirrorTargets(), []);
  assert.deepEqual(s.spectators(), []);
});

test('a spectator moves into mirrorTargets once it resizes above the floor', () => {
  const s = new RoomState({ hostSize: { cols: 120, rows: 40 } });
  s.addGuest('g', { name: 'g' });
  s.setSize('g', 40, 12);
  assert.deepEqual(s.spectators(), ['g']);
  assert.deepEqual(s.mirrorTargets(), []);
  s.setSize('g', 90, 30); // user made the terminal bigger
  assert.deepEqual(s.spectators(), []);
  assert.deepEqual(s.mirrorTargets(), ['g']);
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
