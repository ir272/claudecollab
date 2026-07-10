import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeName } from './names.js';

test('sanitizeName keeps plain printable ASCII, trims and caps at 24', () => {
  assert.equal(sanitizeName('sid'), 'sid');
  assert.equal(sanitizeName('  spaced out  '), 'spaced out');
  assert.equal(sanitizeName('x'.repeat(40)), 'x'.repeat(24));
  assert.equal(sanitizeName('a1-b_2!@#'), 'a1-b_2!@#'); // punctuation in 0x20–0x7e stays
});

test('sanitizeName strips ESC/OSC/BEL/control bytes (terminal-escape injection)', () => {
  // The bytes a malicious ?name= could carry into the host terminal.
  assert.equal(sanitizeName('a\x1b[31mX'), 'a[31mX', 'ESC dropped; the CSI becomes inert text');
  assert.equal(sanitizeName('boo\x07'), 'boo', 'BEL dropped');
  assert.equal(sanitizeName('one\r\ntwo'), 'onetwo', 'CR/LF dropped — no injected newline');
  assert.equal(sanitizeName('\x1b]0;pwned\x07title'), ']0;pwnedtitle', 'OSC intro/terminator dropped');
  assert.equal(sanitizeName('\x00\x1f\x7f'), 'guest', 'only control bytes → fallback');
});

test('sanitizeName drops non-ASCII (parity with the ssh per-byte filter)', () => {
  assert.equal(sanitizeName('héllo'), 'hllo');
  assert.equal(sanitizeName('✦ sid ✦'), 'sid');
  assert.equal(sanitizeName('🙂'), 'guest', 'astral chars gone → fallback');
});

test('sanitizeName falls back when nothing printable remains', () => {
  assert.equal(sanitizeName(''), 'guest');
  assert.equal(sanitizeName(null), 'guest');
  assert.equal(sanitizeName(undefined, 'host'), 'host', 'the caller picks the fallback');
  assert.equal(sanitizeName('   ', 'host'), 'host');
});
