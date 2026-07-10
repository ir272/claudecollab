import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ScreenSnapshot } from './screen-snapshot.js';

// Every non-empty replay ends by re-asserting the effective cursor visibility
// (DECTCEM is sticky; the establishing ?25h/?25l may have been trimmed out of the
// retained window — see the joiner-cursor finding). SHOW is the default.
const SHOW = '\x1b[?25h';
const HIDE = '\x1b[?25l';

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
  assert.equal(s.get(), 'hello world' + SHOW);
  assert.equal(s.size, 'hello world'.length);
});

test('accepts Buffers as well as strings', () => {
  const s = new ScreenSnapshot();
  s.push(Buffer.from('abc', 'utf8'));
  assert.equal(s.get(), 'abc' + SHOW);
});

test('resets on a full-screen clear, keeping the clear and what follows', () => {
  const s = new ScreenSnapshot();
  s.push('old junk that was cleared');
  s.push('\x1b[2Jfresh screen');
  assert.equal(s.get(), '\x1b[2Jfresh screen' + SHOW);
});

test('resets on alt-screen enter so an alt-screen TUI snapshot starts clean', () => {
  const s = new ScreenSnapshot();
  s.push('shell prompt before claude booted');
  s.push('\x1b[?1049h\x1b[HCLAUDE UI');
  assert.equal(s.get(), '\x1b[?1049h\x1b[HCLAUDE UI' + SHOW);
});

test('keeps only the most recent screen across multiple clears', () => {
  const s = new ScreenSnapshot();
  s.push('\x1b[2Jscreen one');
  s.push('more of screen one');
  s.push('\x1b[2Jscreen two');
  assert.equal(s.get(), '\x1b[2Jscreen two' + SHOW);
});

test('a clear split across two chunks still resets once reassembled', () => {
  const s = new ScreenSnapshot();
  s.push('junk');
  // Feed the clear whole in the next chunk (buffer is searched after appending).
  s.push('\x1b[2Jfresh');
  assert.equal(s.get(), '\x1b[2Jfresh' + SHOW);
});

test('bounds memory to the cap, keeping the tail', () => {
  const s = new ScreenSnapshot({ cap: 10 });
  s.push('abcdefghijklmnop'); // 16 chars, no clear, no escapes
  assert.ok(s.size <= 10, `size ${s.size} > cap`);
  assert.equal(s.get(), 'ghijklmnop' + SHOW); // the last 10 (plain text: any cut point is safe)
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
  assert.equal(out, 'PressW' + SHOW, 'the trim jumped past the split SGR to a clean boundary');
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
  assert.ok(out.endsWith(SU_END + SHOW), 'ends at a frame boundary, cursor state re-asserted');
});

test('get() never ends mid-escape-sequence (drops a dangling partial) (finding 2)', () => {
  const s = new ScreenSnapshot();
  s.push('clean text\x1b[38;5'); // a partial SGR at the tail (no final byte yet)
  assert.equal(s.get(), 'clean text' + SHOW, 'the dangling partial escape is not replayed');
  // Once the rest of the sequence arrives, the whole sequence is replayed.
  s.push(';246mMORE');
  assert.equal(s.get(), 'clean text\x1b[38;5;246mMORE' + SHOW);
});

test('get() keeps a complete trailing sequence with text after it', () => {
  const s = new ScreenSnapshot();
  s.push('a\x1b[0mb'); // ESC[0m is complete; "b" follows — nothing to drop
  assert.equal(s.get(), 'a\x1b[0mb' + SHOW);
});

// ── joiner-cursor finding: DECTCEM is sticky, so the ?25h that showed the cursor
// often predates the retained window (clear-reset or cap trim dropped it). The
// snapshot tracks effective visibility across ALL pushed bytes and re-asserts it
// at the tail, so a joiner's cursor always matches the host's. ─────────────────

test('cursor shown survives a clear-reset that dropped the ?25h (joiner cursor)', () => {
  const s = new ScreenSnapshot();
  s.push('boot' + SHOW); // cursor shown long ago
  s.push('\x1b[2Jrepaint with no cursor sequences'); // reset drops the ?25h bytes
  const out = s.get();
  assert.ok(!out.slice(0, -SHOW.length).includes(SHOW), 'the establishing ?25h is not in the window');
  assert.ok(out.endsWith(SHOW), 'yet the replay ends by re-showing the cursor');
});

test('cursor hidden is re-asserted too (a joiner mid-frame stays in sync)', () => {
  const s = new ScreenSnapshot();
  s.push(HIDE + 'spinner paint, frame not closed yet');
  assert.ok(s.get().endsWith(HIDE));
});

test('the LAST cursor sequence wins', () => {
  const s = new ScreenSnapshot();
  s.push(HIDE + 'paint' + SHOW + 'input line');
  assert.ok(s.get().endsWith(SHOW));
});

test('a cursor sequence split across chunks still counts', () => {
  const s = new ScreenSnapshot();
  s.push(SHOW + 'x\x1b[?25'); // hide arrives split across two pushes
  s.push('l more paint');
  assert.ok(s.get().endsWith(HIDE));
});
