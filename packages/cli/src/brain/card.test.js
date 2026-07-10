import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build, recapCard } from './card.js';
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

// ── /recap card (spec §join-context-card: /recap posts the summary to the SHARED
//    screen — full prose for everyone, not a truncated host-only toast) ──────────

test('the recap card frames the FULL prose in a titled box attributed to the runner', () => {
  const summary =
    'The team refactored the navbar into a shared component, then moved the whole ' +
    'layout to tailwind. A failing auth test was fixed along the way, and the hero ' +
    'section is now full-bleed.';
  const card = recapCard('ian', summary, { cols: 80 });
  const lines = card.split('\n');
  assert.ok(lines[0].startsWith('┌') && lines[0].includes('recap'), 'opens a titled recap box');
  assert.match(card, /by ian/, 'attributes the recap to its runner');
  assert.match(card, /└/, 'closes the box');
  // The FULL summary survives — every word is present across the wrapped body,
  // not chopped to a 60-char toast.
  const flat = card.replace(/\s+/g, ' ');
  for (const word of ['navbar', 'tailwind', 'auth', 'full-bleed']) {
    assert.ok(flat.includes(word), `recap keeps "${word}"`);
  }
});

test('the recap card wraps to the given width so it never overflows the shared screen', () => {
  const summary = 'word '.repeat(120).trim(); // far wider than one line
  const card = recapCard('siddh', summary, { cols: 80 });
  const lines = card.split('\n');
  assert.ok(lines.length > 3, 'a long summary wraps onto multiple body rows');
  for (const line of lines) {
    assert.ok(stringWidth(line) <= 80, `recap line too wide: ${line}`);
  }
});

test('the recap card degrades gracefully on empty prose', () => {
  const card = recapCard('ian', '   ', { cols: 80 });
  assert.ok(card.startsWith('┌'));
  assert.match(card, /empty/i);
});
