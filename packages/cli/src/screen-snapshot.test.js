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
  s.push('abcdefghijklmnop'); // 16 chars, no clear
  assert.ok(s.size <= 10, `size ${s.size} > cap`);
  assert.equal(s.get(), 'ghijklmnop'); // the last 10
});
