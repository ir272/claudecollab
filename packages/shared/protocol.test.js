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
    { t: 'reclaim', code: 'brave-otter' },
    { t: 'room', code: 'brave-otter' },
    { t: 'gone', code: 'brave-otter' },
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
    // overlay-state additions
    {
      t: 'state',
      data: {
        room: 'brave-otter',
        participants: [{ id: 'host', name: 'ian', role: 'host', color: '#e5484d' }],
        drafts: { boxes: [] },
        queue: [{ n: 1, author: 'g1', text: 'hi' }],
        claudeState: 'idle',
        paused: false,
        pointers: { g1: { x: 0.5, y: 0.25, name: 'siddh', color: '#e5484d' } },
        knocks: [{ id: 'k1', name: 'mallory', fp: 'SHA256:x', seen: null }],
      },
    },
    { t: 'pointer', x: 0.5, y: 0.5 }, // guest→relay form (no id yet)
    { t: 'pointer', id: 'g1', x: 0.1, y: 0.9 }, // relay→host form (labeled by sender)
    { t: 'ui', action: { kind: 'command', text: '/role @siddh prompter' } },
    { t: 'ui', id: 'g1', action: { kind: 'admit', id: 'k1' } },
    { t: 'ui', id: 'g1', action: { kind: 'deny', id: 'k1' } },
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

test('Decoder drops an unparseable line instead of throwing (never fatal)', () => {
  const dec = new Decoder();
  // A bad line followed by a valid one in the SAME chunk: the bad line is
  // dropped, the valid line still comes through (spec: drop anything malformed).
  assert.doesNotThrow(() => dec.push('not json\n'));
  const dec2 = new Decoder();
  assert.deepEqual(dec2.push('not json\n{"t":"end"}\n'), [{ t: 'end' }]);
});

test('Decoder recovers after a malformed line split across pushes', () => {
  const dec = new Decoder();
  assert.deepEqual(dec.push('{bad'), []); // partial, no newline yet
  assert.deepEqual(dec.push(' json\n'), []); // completes an unparseable line → dropped
  assert.deepEqual(dec.push('{"t":"end"}\n'), [{ t: 'end' }]); // decoder recovers
});

test('Decoder caps an unterminated flood instead of buffering unbounded', () => {
  const dec = new Decoder();
  // A huge chunk with no newline must not be retained forever.
  dec.push('x'.repeat(11 * 1024 * 1024));
  // A following complete, valid line still parses cleanly.
  assert.deepEqual(dec.push('{"t":"end"}\n'), [{ t: 'end' }]);
});

test('validate accepts well-formed messages', () => {
  const good = [
    { t: 'hello', want: 'room' },
    { t: 'hello', want: 'room', secret: 'hunter2' }, // room-creation credential (relay w/ ROOM_SECRET)
    { t: 'reclaim', code: 'brave-otter' },
    { t: 'room', code: 'brave-otter' },
    { t: 'room', code: 'brave-otter', webUrl: 'https://claude-share.fly.dev' }, // deployed relay advertises its public origin
    { t: 'gone', code: 'brave-otter' },
    { t: 'refused', reason: 'secret' }, // hello rejected (bad/missing room secret)
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
    // overlay state: data need only be a plain object (shallow, like the rest)
    { t: 'state', data: {} },
    { t: 'state', data: { room: 'r', participants: [], drafts: { boxes: [] }, queue: [], claudeState: 'busy', paused: true, pointers: {}, knocks: [] } },
    // pointer: id is optional (relay stamps it on the guest→host hop)
    { t: 'pointer', x: 0, y: 0 },
    { t: 'pointer', x: 0.5, y: 0.5, id: 'g1' },
    { t: 'pointer', x: 1, y: 1, id: 'g1' },
    // ui: an admit/deny carries a target id; a command carries text
    { t: 'ui', action: { kind: 'admit', id: 'k1' } },
    { t: 'ui', action: { kind: 'deny', id: 'k1' } },
    { t: 'ui', action: { kind: 'command', text: '/pause' } },
    { t: 'ui', id: 'g1', action: { kind: 'command', text: '/role @x prompter' } },
    // roster actions target a participant id (not a @-mention) so duplicate names can't mis-target
    { t: 'ui', id: 'host', action: { kind: 'role', id: 'g2', role: 'prompter' } },
    { t: 'ui', id: 'host', action: { kind: 'kick', id: 'g2' } },
    // wheel over the mirror → Claude's transcript scroll (negative = up)
    { t: 'ui', id: 'g1', action: { kind: 'scroll', lines: -3 } },
    { t: 'ui', action: { kind: 'scroll', lines: 8 } },
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
    { t: 'hello', want: 'room', secret: 42 }, // a secret must be a string
    { t: 'refused' }, // missing reason
    { t: 'refused', reason: 7 },
    { t: 'room' },
    { t: 'room', code: 5 },
    { t: 'reclaim' },
    { t: 'reclaim', code: 5 },
    { t: 'gone' },
    { t: 'gone', code: 5 },
    { t: 'admit' },
    { t: 'admit', id: 7 },
    { t: 'key', id: 'g1' },
    { t: 'resize', id: 'g1', cols: '80', rows: 24 },
    { t: 'drop', id: 'g1' },
    { t: 'drop', id: 'g1', ban: 'yes' },
    { t: 'knock', id: 'g1', name: 'x', fp: 'a1' }, // missing seen
    { t: 'state' }, // missing data
    { t: 'state', data: null }, // null is not an object
    { t: 'state', data: [] }, // an array is not a state payload
    { t: 'state', data: 'nope' },
    { t: 'pointer' }, // missing coordinates
    { t: 'pointer', x: 0.5 }, // missing y
    { t: 'pointer', x: '0.5', y: 0.5 }, // x not a number
    { t: 'pointer', x: 0.5, y: 0.5, id: 7 }, // id, if present, must be a string
    { t: 'ui' }, // missing action
    { t: 'ui', action: null },
    { t: 'ui', action: {} }, // no kind
    { t: 'ui', action: { kind: 'nope' } }, // unknown kind
    { t: 'ui', action: { kind: 'admit' } }, // admit needs a target id
    { t: 'ui', action: { kind: 'deny', id: 7 } }, // target id must be a string
    { t: 'ui', action: { kind: 'command' } }, // command needs text
    { t: 'ui', action: { kind: 'command', text: 5 } }, // text must be a string
    { t: 'ui', id: 7, action: { kind: 'command', text: '/pause' } }, // sender id must be a string
    { t: 'ui', action: { kind: 'kick' } }, // kick needs a target id
    { t: 'ui', action: { kind: 'kick', id: 7 } }, // target id must be a string
    { t: 'ui', action: { kind: 'role', id: 'g2' } }, // role is missing
    { t: 'ui', action: { kind: 'role', role: 'prompter' } }, // target id is missing
    { t: 'ui', action: { kind: 'scroll' } }, // scroll needs a line count
    { t: 'ui', action: { kind: 'scroll', lines: 'up' } }, // lines must be a number
    { t: 'ui', action: { kind: 'role', id: 'g2', role: 7 } }, // role must be a string
  ];
  for (const m of bad) assert.equal(validate(m), false, JSON.stringify(m));
});

test('TYPES exposes a constant for every message type', () => {
  const keys = ['HELLO', 'RECLAIM', 'ROOM', 'GONE', 'KNOCK', 'ADMIT', 'DENY', 'JOINED', 'LEFT', 'KEY', 'RESIZE', 'SCREEN', 'TO', 'DROP', 'END', 'STATE', 'POINTER', 'UI'];
  for (const k of keys) assert.equal(typeof TYPES[k], 'string', k);
});
