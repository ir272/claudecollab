import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from './card.js';
import { RoomState } from './state.js';
import { Log } from './log.js';
import { stringWidth } from '../renderer.js';

// Build a state + log fixture standing at a known clock, then a joiner arriving.
function fixture() {
  let t = 0;
  const now = () => t;
  const state = new RoomState({ hostName: 'ian', now });
  const log = new Log({ now });
  state.addGuest('j', { name: 'james' });
  // 42 minutes of history
  t = 10 * 60 * 1000;
  log.prompt('ian', 'refactor the navbar');
  t = 30 * 60 * 1000;
  log.prompt('james', 'fix the failing auth test');
  log.tool('Edit', ['src/Nav.tsx']);
  log.tool('Write', ['src/auth.test.ts', 'a.js', 'b.js', 'c.js']);
  t = 40 * 60 * 1000;
  log.prompt('ian', 'make the hero full-bleed');
  state.setMode('accept-edits');
  t = 42 * 60 * 1000;
  const joiner = state.addGuest('s', { name: 'siddh' });
  return { state, log, now, joiner };
}

test('the card leads with a titled session-so-far box and ends with the live marker', () => {
  const { state, log, now } = fixture();
  const card = build(state, log, { joinerId: 's', now, claudeState: 'busy' });
  const lines = card.split('\n');
  assert.ok(lines[0].includes('session so far'), 'title present');
  assert.ok(lines[0].startsWith('┌'), 'opens a box');
  assert.match(card, /42 min/, 'shows session age');
  assert.match(card, /└/, 'closes the box');
  assert.match(card, /── you're live ──\s*$/, 'ends with the attach marker');
});

test('the card names the people, the joiner, and the mode', () => {
  const { state, log, now } = fixture();
  const card = build(state, log, { joinerId: 's', now });
  assert.match(card, /ian/);
  assert.match(card, /james/);
  assert.match(card, /you join as siddh/);
  assert.match(card, /accept-edits/);
});

test('the card lists recent attributed prompts and touched files with a +N overflow', () => {
  const { state, log, now } = fixture();
  const card = build(state, log, { joinerId: 's', now });
  assert.match(card, /refactor the navbar/);
  assert.match(card, /fix the failing auth test/);
  assert.match(card, /make the hero full-bleed/);
  assert.match(card, /src\/Nav\.tsx/);
  // 5 files touched, card shows the first 3 + "+2"
  assert.match(card, /\+2/);
});

test('the card reflects Claude state and the last prompt author', () => {
  const { state, log, now } = fixture();
  const busy = build(state, log, { joinerId: 's', now, claudeState: 'busy' });
  assert.match(busy, /brewing/i);
  assert.match(busy, /ian/, 'on ian’s last prompt');
  const idle = build(state, log, { joinerId: 's', now, claudeState: 'idle' });
  assert.match(idle, /idle/i);
});

test('an empty room (no prompts, no files) still renders a valid box', () => {
  const now = () => 0;
  const state = new RoomState({ hostName: 'ian', now });
  const log = new Log({ now });
  state.addGuest('s', { name: 'siddh' });
  const card = build(state, log, { joinerId: 's', now });
  assert.ok(card.startsWith('┌'));
  assert.match(card, /you join as siddh/);
  assert.match(card, /── you're live ──/);
});

test('every card line stays within a sane terminal width', () => {
  const { state, log, now } = fixture();
  const card = build(state, log, { joinerId: 's', now });
  for (const line of card.split('\n')) {
    assert.ok(stringWidth(line) <= 80, `line too wide: ${line}`);
  }
});
