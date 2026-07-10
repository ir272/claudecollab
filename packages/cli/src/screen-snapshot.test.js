import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ScreenSnapshot } from './screen-snapshot.js';

test('is empty until fed', () => {
  const s = new ScreenSnapshot();
  assert.equal(s.get(), '');
  assert.equal(s.size, 0);
  s.push('');
  s.push(null);
  assert.equal(s.get(), '');
});

test('accumulates plain output (a line app like cat) so a joiner sees it', () => {
  const s = new ScreenSnapshot();
  s.push('hello ');
  s.push('world');
  assert.equal(s.get(), 'hello world');
  assert.equal(s.size, 'hello world'.length);
});

test('accepts Buffers as well as strings', () => {
  const s = new ScreenSnapshot();
  s.push(Buffer.from('abc', 'utf8'));
  assert.equal(s.get(), 'abc');
});

test('resets on a full-screen clear, keeping the clear and what follows', () => {
  const s = new ScreenSnapshot();
  s.push('old junk that was cleared');
  s.push('\x1b[2Jfresh screen');
  assert.equal(s.get(), '\x1b[2Jfresh screen');
});

test('resets on alt-screen enter so an alt-screen TUI snapshot starts clean', () => {
  const s = new ScreenSnapshot();
  s.push('shell prompt before claude booted');
  s.push('\x1b[?1049h\x1b[HCLAUDE UI');
  assert.equal(s.get(), '\x1b[?1049h\x1b[HCLAUDE UI');
});

test('keeps only the most recent screen across multiple clears', () => {
  const s = new ScreenSnapshot();
  s.push('\x1b[2Jscreen one');
  s.push('more of screen one');
  s.push('\x1b[2Jscreen two');
  assert.equal(s.get(), '\x1b[2Jscreen two');
});

test('a clear split across two chunks still resets once reassembled', () => {
  const s = new ScreenSnapshot();
  s.push('junk');
  // Feed the clear whole in the next chunk (buffer is searched after appending).
  s.push('\x1b[2Jfresh');
  assert.equal(s.get(), '\x1b[2Jfresh');
});

test('bounds memory to the cap, keeping the tail', () => {
  const s = new ScreenSnapshot({ cap: 10 });
  s.push('abcdefghijklmnop'); // 16 chars, no clear, no escapes
  assert.ok(s.size <= 10, `size ${s.size} > cap`);
  assert.equal(s.get(), 'ghijklmnop'); // the last 10 (plain text: any cut point is safe)
});

// ── finding 2: a mid-session joiner must get ONE clean copy — the snapshot the
// host replays must never START or END in the middle of an escape sequence, or
// xterm renders the fragment as literal text (the live bug: ";246mPressW"). ────

test('a cap trim never starts the snapshot mid-escape-sequence (finding 2)', () => {
  const s = new ScreenSnapshot({ cap: 10 });
  // The naive tail slice (length-cap = 12) lands INSIDE "\x1b[38;5;246m", so the
  // replay would begin "246mPressW" — a raw SGR fragment rendered as text.
  s.push('xxxxx\x1b[38;5;246mPressW');
  const out = s.get();
  assert.ok(s.size <= 10, `size ${s.size} > cap`);
  assert.equal(out, 'PressW', 'the trim jumped past the split SGR to a clean boundary');
  assert.doesNotMatch(out, /^[\d;]*m/, 'never begins in the middle of an SGR sequence');
});

test('trims to a frame boundary (SU_END), dropping whole older frames (finding 2)', () => {
  const SU_END = '\x1b[?2026l';
  const s = new ScreenSnapshot({ cap: 30 });
  s.push('\x1b[?2026hFRAME-ONE-PADDING' + SU_END); // older frame, evicted by the cap
  s.push('\x1b[?2026hFRAME-TWO' + SU_END); // newest frame, kept whole
  const out = s.get();
  assert.ok(!out.includes('FRAME-ONE'), 'the older frame was dropped at a frame boundary');
  assert.ok(out.startsWith('\x1b[?2026h'), 'the snapshot starts at a frame start, not mid-sequence');
  assert.ok(out.endsWith(SU_END), 'and ends at a frame boundary');
});

test('get() never ends mid-escape-sequence (drops a dangling partial) (finding 2)', () => {
  const s = new ScreenSnapshot();
  s.push('clean text\x1b[38;5'); // a partial SGR at the tail (no final byte yet)
  assert.equal(s.get(), 'clean text', 'the dangling partial escape is not replayed');
  // Once the rest of the sequence arrives, the whole sequence is replayed.
  s.push(';246mMORE');
  assert.equal(s.get(), 'clean text\x1b[38;5;246mMORE');
});

test('get() keeps a complete trailing sequence with text after it', () => {
  const s = new ScreenSnapshot();
  s.push('a\x1b[0mb'); // ESC[0m is complete; "b" follows — nothing to drop
  assert.equal(s.get(), 'a\x1b[0mb');
});
