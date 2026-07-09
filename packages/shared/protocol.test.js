import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encode, decode, validate, Decoder, TYPES } from './protocol.js';

test('encode produces newline-terminated JSON in a Buffer', () => {
  const buf = encode({ t: 'end' });
  assert.ok(Buffer.isBuffer(buf));
  assert.equal(buf[buf.length - 1], 0x0a); // trailing \n
  assert.deepEqual(JSON.parse(buf.toString().trim()), { t: 'end' });
});

test('encode/decode round-trip for every message type', () => {
  const msgs = [
    { t: 'hello', want: 'room' },
    { t: 'room', code: 'brave-otter' },
    { t: 'knock', id: 'g1', name: 'siddh', fp: 'a1b2c3', seen: false },
    { t: 'knock', id: 'g2', name: 'james', fp: 'd4e5f6', seen: 'james' },
    { t: 'admit', id: 'g1' },
    { t: 'deny', id: 'g1' },
    { t: 'joined', id: 'g1' },
    { t: 'left', id: 'g1' },
    { t: 'key', id: 'g1', data: 'aGVsbG8=' },
    { t: 'resize', id: 'g1', cols: 120, rows: 40 },
    { t: 'screen', data: 'c2NyZWVu' },
    { t: 'to', id: 'g1', data: 'Y2FyZA==' },
    { t: 'drop', id: 'g1', ban: true },
    { t: 'end' },
  ];
  for (const m of msgs) {
    assert.deepEqual(decode(encode(m)), [m], JSON.stringify(m));
  }
});

test('decode returns every complete message in a single chunk', () => {
  const a = { t: 'joined', id: 'g1' };
  const b = { t: 'left', id: 'g1' };
  assert.deepEqual(decode(Buffer.concat([encode(a), encode(b)])), [a, b]);
});

test('Decoder buffers a partial trailing message across pushes', () => {
  const a = { t: 'screen', data: 'aGk=' };
  const b = { t: 'end' };
  const full = Buffer.concat([encode(a), encode(b)]);
  const cut = encode(a).length + 3; // all of a, plus 3 bytes into b
  const dec = new Decoder();
  assert.deepEqual(dec.push(full.subarray(0, cut)), [a]);
  assert.deepEqual(dec.push(full.subarray(cut)), [b]);
});

test('Decoder buffers a split that lands inside the first message', () => {
  const a = { t: 'admit', id: 'g1' };
  const b = { t: 'left', id: 'g1' };
  const full = Buffer.concat([encode(a), encode(b)]);
  const dec = new Decoder();
  assert.deepEqual(dec.push(full.subarray(0, 4)), []); // no newline yet
  assert.deepEqual(dec.push(full.subarray(4)), [a, b]);
});

test('Decoder accepts string chunks and skips blank lines', () => {
  const dec = new Decoder();
  assert.deepEqual(dec.push('\n\n'), []);
  assert.deepEqual(dec.push('{"t":"end"}\n'), [{ t: 'end' }]);
});

test('validate accepts well-formed messages', () => {
  const good = [
    { t: 'hello', want: 'room' },
    { t: 'room', code: 'brave-otter' },
    { t: 'knock', id: 'g1', name: 'siddh', fp: 'a1', seen: false },
    { t: 'knock', id: 'g1', name: 'siddh', fp: 'a1', seen: 'siddh' },
    { t: 'knock', id: 'g1', name: 'siddh', fp: 'a1', seen: null },
    { t: 'admit', id: 'g1' },
    { t: 'deny', id: 'g1' },
    { t: 'joined', id: 'g1' },
    { t: 'left', id: 'g1' },
    { t: 'key', id: 'g1', data: 'aGk=' },
    { t: 'resize', id: 'g1', cols: 80, rows: 24 },
    { t: 'screen', data: 'aGk=' },
    { t: 'to', id: 'g1', data: 'aGk=' },
    { t: 'drop', id: 'g1', ban: true },
    { t: 'drop', id: 'g1', ban: false },
    { t: 'end' },
  ];
  for (const m of good) assert.equal(validate(m), true, JSON.stringify(m));
});

test('validate rejects malformed messages', () => {
  const bad = [
    null,
    undefined,
    42,
    'end',
    [],
    {},
    { t: 'nope' },
    { t: 'hello', want: 'shell' },
    { t: 'room' },
    { t: 'room', code: 5 },
    { t: 'admit' },
    { t: 'admit', id: 7 },
    { t: 'key', id: 'g1' },
    { t: 'resize', id: 'g1', cols: '80', rows: 24 },
    { t: 'drop', id: 'g1' },
    { t: 'drop', id: 'g1', ban: 'yes' },
    { t: 'knock', id: 'g1', name: 'x', fp: 'a1' }, // missing seen
  ];
  for (const m of bad) assert.equal(validate(m), false, JSON.stringify(m));
});

test('TYPES exposes a constant for every message type', () => {
  const keys = ['HELLO', 'ROOM', 'KNOCK', 'ADMIT', 'DENY', 'JOINED', 'LEFT', 'KEY', 'RESIZE', 'SCREEN', 'TO', 'DROP', 'END'];
  for (const k of keys) assert.equal(typeof TYPES[k], 'string', k);
});
