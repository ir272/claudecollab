import { test } from 'node:test';
import assert from 'node:assert/strict';
import { partitionInput, createPartitioner } from './term-chatter.js';

test('plain typing is human', () => {
  const r = partitionInput('hello world');
  assert.equal(r.human, 'hello world');
  assert.equal(r.chatter, '');
  assert.equal(r.carry, '');
});

test('DA1 reply is chatter (the ghostty dogfood bug)', () => {
  const r = partitionInput('\x1b[?62;22;52c');
  assert.equal(r.chatter, '\x1b[?62;22;52c');
  assert.equal(r.human, '');
});

test('XTVERSION DCS reply is chatter', () => {
  const r = partitionInput('\x1bP>|ghostty 1.3.1\x1b\\');
  assert.equal(r.chatter, '\x1bP>|ghostty 1.3.1\x1b\\');
  assert.equal(r.human, '');
});

test('SGR mouse report burst is chatter', () => {
  const burst = '\x1b[<35;34;4M\x1b[<35;32;4M\x1b[<35;30;4m';
  const r = partitionInput(burst);
  assert.equal(r.chatter, burst);
  assert.equal(r.human, '');
});

test('focus events and cursor position reports are chatter', () => {
  const r = partitionInput('\x1b[I\x1b[24;80R\x1b[O');
  assert.equal(r.chatter, '\x1b[I\x1b[24;80R\x1b[O');
  assert.equal(r.human, '');
});

test('arrow keys and alt-word stay human (composer keymap owns them)', () => {
  const keys = '\x1b[A\x1b[D\x1bb\x1bf';
  const r = partitionInput(keys);
  assert.equal(r.human, keys);
  assert.equal(r.chatter, '');
});

test('bracketed paste guards stay human', () => {
  const paste = '\x1b[200~pasted text\x1b[201~';
  const r = partitionInput(paste);
  assert.equal(r.human, paste);
  assert.equal(r.chatter, '');
});

test('DECRQM reply is chatter (the second dogfood bug: [?2026;2$y in the draft)', () => {
  const r = partitionInput('\x1b[?2026;2$y');
  assert.equal(r.chatter, '\x1b[?2026;2$y');
  assert.equal(r.human, '');
});

test('kitty keyboard query reply and DSR-DEC reply are chatter', () => {
  const r = partitionInput('\x1b[?1u\x1b[?62;4n');
  assert.equal(r.chatter, '\x1b[?1u\x1b[?62;4n');
  assert.equal(r.human, '');
});

test('kitty-protocol KEY event (no ?) stays human', () => {
  const r = partitionInput('\x1b[97;5u');
  assert.equal(r.human, '\x1b[97;5u');
  assert.equal(r.chatter, '');
});

test('in-band size report (mode 2048) is chatter', () => {
  const r = partitionInput('\x1b[48;32;120;640;1280t');
  assert.equal(r.chatter, '\x1b[48;32;120;640;1280t');
  assert.equal(r.human, '');
});

test('mixed chunk: typing interleaved with mouse reports', () => {
  const r = partitionInput('fix\x1b[<35;10;4M the bug\x1b[?62c!');
  assert.equal(r.human, 'fix the bug!');
  assert.equal(r.chatter, '\x1b[<35;10;4M\x1b[?62c');
});

test('incomplete sequence at tail is carried, then resolved', () => {
  const feed = createPartitioner();
  let r = feed('yes\x1b[<35;1');
  assert.equal(r.human, 'yes');
  assert.equal(r.chatter, '');
  r = feed('0;4Mno');
  assert.equal(r.chatter, '\x1b[<35;10;4M');
  assert.equal(r.human, 'no');
});

test('lone ESC (the Escape key = interrupt) is delivered immediately as human', () => {
  const r = partitionInput('\x1b');
  assert.equal(r.human, '\x1b');
  assert.equal(r.carry, '');
});
