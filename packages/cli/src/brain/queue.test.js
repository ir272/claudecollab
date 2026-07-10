import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Queue } from './queue.js';

test('enqueue attributes each item and preserves order', () => {
  const q = new Queue();
  const a = q.enqueue('first', 'ian');
  const b = q.enqueue('second', 'siddh');
  assert.notEqual(a.id, b.id);
  assert.equal(q.length, 2);
  assert.deepEqual(
    q.items.map((i) => [i.text, i.author]),
    [['first', 'ian'], ['second', 'siddh']],
  );
});

test('items returns copies, not live references', () => {
  const q = new Queue();
  q.enqueue('x', 'ian');
  q.items[0].text = 'mutated';
  assert.equal(q.items[0].text, 'x', 'internal state is not mutated through the snapshot');
});

// ── drain: fail-closed, one per idle (spec §queue) ──────────────────────────────

test('drain releases the front item only when Claude is known-idle', () => {
  const q = new Queue();
  q.enqueue('one', 'ian');
  q.enqueue('two', 'siddh');
  assert.equal(q.drain('busy'), null, 'busy → nothing drains');
  assert.equal(q.drain('ask'), null, 'ask pending → nothing drains');
  assert.equal(q.drain(undefined), null, 'ambiguous → nothing drains (fail closed)');
  assert.equal(q.length, 2, 'no item lost while blocked');

  const first = q.drain('idle');
  assert.equal(first.text, 'one');
  assert.equal(q.length, 1, 'exactly one item per idle');
  const second = q.drain('idle');
  assert.equal(second.text, 'two');
  assert.equal(q.drain('idle'), null, 'empty queue drains to null');
});

// ── edit: author only (spec) ────────────────────────────────────────────────────

test('an author can edit their own queued item; nobody else can', () => {
  const q = new Queue();
  const it = q.enqueue('draftt', 'ian');
  assert.equal(q.edit(it.id, 'fixed', 'ian', 'prompter'), true);
  assert.equal(q.items[0].text, 'fixed');
  assert.equal(q.edit(it.id, 'hijack', 'siddh', 'host'), false, 'even the host cannot edit someone else’s item');
  assert.equal(q.items[0].text, 'fixed');
  assert.equal(q.edit('missing', 'x', 'ian', 'host'), false);
});

// ── delete: author OR the host (spec) ───────────────────────────────────────────

test('an author deletes their own item', () => {
  const q = new Queue();
  const it = q.enqueue('mine', 'siddh');
  assert.equal(q.remove(it.id, 'siddh', 'prompter'), true);
  assert.equal(q.length, 0);
});

test('a prompter cannot delete someone else’s item; the host can', () => {
  const q = new Queue();
  const it = q.enqueue('ians', 'ian');
  assert.equal(q.remove(it.id, 'siddh', 'prompter'), false, 'prompter has no delete-any power');
  assert.equal(q.length, 1);
  assert.equal(q.remove(it.id, 'siddh', 'host'), true, 'the host deletes any');

  const it2 = q.enqueue('again', 'ian');
  assert.equal(q.remove(it2.id, 'host', 'host'), true, 'host deletes any');
  assert.equal(q.length, 0);
});

test('removeByAuthor purges everything a departing/kicked user queued', () => {
  const q = new Queue();
  q.enqueue('a', 'ian');
  q.enqueue('b', 'james');
  q.enqueue('c', 'ian');
  const removed = q.removeByAuthor('ian');
  assert.equal(removed, 2);
  assert.deepEqual(q.items.map((i) => i.author), ['james']);
});

test('peek shows the front item without draining it', () => {
  const q = new Queue();
  assert.equal(q.peek(), null);
  q.enqueue('front', 'ian');
  assert.equal(q.peek().text, 'front');
  assert.equal(q.length, 1);
});
