import { test } from 'node:test';
import assert from 'node:assert/strict';
import { History } from './history.js';

test('start opens an attributed, running turn', () => {
  const h = new History({ now: () => 100 });
  const id = h.start('ian', 'add rate limiting');
  assert.ok(id);
  assert.equal(h.open, true);
  const [t] = h.snapshot();
  assert.deepEqual(
    { author: t.author, prompt: t.prompt, response: t.response, running: t.running, at: t.at },
    { author: 'ian', prompt: 'add rate limiting', response: '', running: true, at: 100 },
  );
});

test('finish attaches the response and closes the turn', () => {
  const h = new History();
  h.start('ian', 'do the thing');
  assert.equal(h.finish('here is what I did'), true);
  assert.equal(h.open, false);
  const [t] = h.snapshot();
  assert.equal(t.response, 'here is what I did');
  assert.equal(t.running, false);
});

test('finish with nothing open is a no-op (direct-typed prompt)', () => {
  const h = new History();
  assert.equal(h.finish('orphan response'), false);
  assert.equal(h.snapshot().length, 0);
});

test('turns are attributed per author and preserve order', () => {
  const h = new History();
  h.start('ian', 'one');
  h.finish('r1');
  h.start('sam', 'two');
  h.finish('r2');
  assert.deepEqual(
    h.snapshot().map((t) => [t.author, t.prompt, t.response]),
    [
      ['ian', 'one', 'r1'],
      ['sam', 'two', 'r2'],
    ],
  );
});

test('snapshot returns copies, not live references', () => {
  const h = new History();
  h.start('ian', 'x');
  const snap = h.snapshot();
  snap[0].prompt = 'mutated';
  assert.equal(h.snapshot()[0].prompt, 'x');
});

test('history keeps only a bounded tail', () => {
  const h = new History();
  for (let i = 0; i < 200; i++) {
    h.start('ian', `p${i}`);
    h.finish(`r${i}`);
  }
  const snap = h.snapshot();
  assert.ok(snap.length <= 60, `kept ${snap.length}`);
  assert.equal(snap[snap.length - 1].prompt, 'p199', 'newest is retained');
});
