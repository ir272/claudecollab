import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dispatch, classifySend, sendAllowed, VIEWER_TOAST } from './gate.js';

// ── raw byte vocabulary ─────────────────────────────────────────────────────
const CTRL_C = '\x03';
const ESC = '\x1b';
const SHIFT_TAB = '\x1b[Z';
const ARROW_LEFT = '\x1b[D';
const ROLES = ['viewer', 'prompter', 'driver', 'host'];

// dispatch with a fresh toast set each call unless one is supplied.
const d = (userId, role, bytes, ctx = {}) => dispatch(userId, role, bytes, { toasted: new Set(), ...ctx });

// ── the input table, class by class (spec §per-role input table) ────────────────

test('printable draft typing: prompter+ composes, viewer is blocked', () => {
  assert.equal(d('u', 'viewer', 'a').kind, 'toast');
  assert.deepEqual(d('u', 'prompter', 'a'), { kind: 'draft', bytes: 'a' });
  assert.deepEqual(d('u', 'driver', 'a'), { kind: 'draft', bytes: 'a' });
  assert.deepEqual(d('u', 'host', 'a'), { kind: 'draft', bytes: 'a' });
});

test('Enter and editing keys route to the draft editor for prompter+', () => {
  for (const role of ['prompter', 'driver', 'host']) {
    assert.equal(d('u', role, '\r').kind, 'draft', role);
    assert.equal(d('u', role, ARROW_LEFT).kind, 'draft', `${role} arrow edits the draft`);
  }
  assert.notEqual(d('u', 'viewer', '\r').kind, 'draft');
});

test('Escape interrupts Claude (→ pty) for prompter+, blocked for viewer', () => {
  assert.equal(d('u', 'viewer', ESC).kind, 'toast');
  for (const role of ['prompter', 'driver', 'host']) {
    assert.deepEqual(d('u', role, ESC), { kind: 'pty', data: ESC }, role);
  }
});

test('y/n answers an ask (→ pty) only for driver+ and only while armed', () => {
  // armed: driver+ answer, prompter types into draft, viewer blocked
  assert.deepEqual(d('u', 'driver', 'y', { armed: true }), { kind: 'pty', data: 'y' });
  assert.deepEqual(d('u', 'host', 'n', { armed: true }), { kind: 'pty', data: 'n' });
  assert.deepEqual(d('u', 'host', 'Y', { armed: true }), { kind: 'pty', data: 'Y' });
  assert.equal(d('u', 'prompter', 'y', { armed: true }).kind, 'draft', 'prompter y is just typing');
  assert.equal(d('u', 'viewer', 'y', { armed: true }).kind, 'toast');

  // NOT armed (fail closed): a lone y/n is ordinary draft input for EVERYONE,
  // including the host — a missed/absent ask must never turn "yes, ship it" into a
  // bare keystroke sent to Claude (spec §fail-closed). The host is no longer an
  // "always forward" escape hatch; unarmed, its y/n composes like any other char.
  assert.equal(d('u', 'driver', 'y', { armed: false }).kind, 'draft');
  assert.equal(d('u', 'host', 'y', { armed: false }).kind, 'draft', 'unarmed host y composes');
  assert.equal(d('u', 'host', 'n', { armed: false }).kind, 'draft', 'unarmed host n composes');
  assert.equal(d('u', 'host', 'Y', { armed: false }).kind, 'draft', 'unarmed host Y composes');
});

test('Ctrl+C detaches a guest but is normal input for the host', () => {
  assert.deepEqual(d('u', 'viewer', CTRL_C), { kind: 'detach' });
  assert.deepEqual(d('u', 'prompter', CTRL_C), { kind: 'detach' });
  assert.deepEqual(d('u', 'driver', CTRL_C), { kind: 'detach' });
  assert.deepEqual(d('u', 'host', CTRL_C), { kind: 'pty', data: CTRL_C });
});

test('Ctrl+N (start a new draft) reaches the composer for prompter+, blocked for viewer', () => {
  const CTRL_N = '\x0e';
  for (const role of ['prompter', 'driver', 'host']) {
    assert.deepEqual(d('u', role, CTRL_N), { kind: 'draft', bytes: CTRL_N }, role);
  }
  assert.equal(d('u', 'viewer', CTRL_N).kind, 'toast');
});

test('mode flip (Shift+Tab) is driver+ only, dropped for prompter/viewer', () => {
  assert.deepEqual(d('u', 'driver', SHIFT_TAB), { kind: 'pty', data: SHIFT_TAB });
  assert.deepEqual(d('u', 'host', SHIFT_TAB), { kind: 'pty', data: SHIFT_TAB });
  assert.equal(d('u', 'prompter', SHIFT_TAB).kind, 'drop', 'prompter cannot flip modes');
  assert.equal(d('u', 'viewer', SHIFT_TAB).kind, 'drop');
});

// ── the viewer toast fires exactly once ────────────────────────────────────────

test('a viewer gets the role toast once, then silent drops', () => {
  const toasted = new Set();
  const first = dispatch('v1', 'viewer', 'a', { toasted });
  assert.equal(first.kind, 'toast');
  assert.equal(first.target, 'v1');
  assert.equal(first.message, VIEWER_TOAST);
  assert.equal(dispatch('v1', 'viewer', 'b', { toasted }).kind, 'drop', 'second attempt is silent');
  // a different viewer still gets their own first toast
  assert.equal(dispatch('v2', 'viewer', 'a', { toasted }).kind, 'toast');
});

test('dispatch accepts a Buffer as well as a string', () => {
  assert.deepEqual(d('u', 'prompter', Buffer.from('hi')), { kind: 'draft', bytes: 'hi' });
});

// ── send classification (what a sent draft actually is) ─────────────────────────

test('classifySend distinguishes command / claude-slash / bash / prompt', () => {
  assert.deepEqual(classifySend('/role @a driver'), { kind: 'command', name: 'role' });
  assert.deepEqual(classifySend('/end'), { kind: 'command', name: 'end' });
  assert.deepEqual(classifySend('/clear'), { kind: 'claude-slash' });
  assert.deepEqual(classifySend('/model opus'), { kind: 'claude-slash' });
  assert.deepEqual(classifySend('!ls -la'), { kind: 'bash' });
  assert.deepEqual(classifySend('make the hero full-bleed'), { kind: 'prompt' });
});

test('sendAllowed gates prompt (prompter+), claude-slash & bash (driver+)', () => {
  assert.equal(sendAllowed('prompt', 'prompter'), true);
  assert.equal(sendAllowed('prompt', 'viewer'), false);
  for (const kind of ['claude-slash', 'bash']) {
    assert.equal(sendAllowed(kind, 'prompter'), false, `${kind} not for prompter`);
    assert.equal(sendAllowed(kind, 'driver'), true, kind);
    assert.equal(sendAllowed(kind, 'host'), true, kind);
  }
  // command role-gating is commands.permitted()'s job; sendAllowed defers.
  assert.equal(sendAllowed('command', 'viewer'), true);
});

// ── a sanity sweep of the whole matrix produces a defined effect kind ───────────

test('every role × input class yields a known effect kind', () => {
  const inputs = ['a', '\r', ESC, CTRL_C, SHIFT_TAB, ARROW_LEFT, 'y'];
  const known = new Set(['draft', 'pty', 'detach', 'toast', 'drop']);
  for (const role of ROLES) {
    for (const bytes of inputs) {
      for (const armed of [true, false]) {
        const eff = dispatch('u', role, bytes, { armed, toasted: new Set() });
        assert.ok(known.has(eff.kind), `role=${role} bytes=${JSON.stringify(bytes)} armed=${armed} → ${eff.kind}`);
      }
    }
  }
});
