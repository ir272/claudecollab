// first-run.js — the one-screen setup shown on the first interactive `collab`. Pure
// I/O injection: tests feed byte sequences to an injected input stream and assert the
// rendered output + the resolved selection. No real TTY, no real HOME.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { runFirstRun } from './first-run.js';

// Collect everything written to the injected output.
function makeOutput() {
  let buf = '';
  return { write: (s) => (buf += s), get: () => buf };
}

test('renders the approved copy — required-core line, all three connectors, donate line', async () => {
  const input = new PassThrough();
  const output = makeOutput();
  const p = runFirstRun({ input, output });
  input.write('\r'); // enter immediately so the promise resolves
  await p;
  const screen = output.get();
  assert.ok(screen.includes('✦ collab — first run'), 'the title');
  assert.ok(
    screen.includes('✓ /collab will be added to Claude Code   (required — it IS the product)'),
    'the required-core line, verbatim',
  );
  assert.ok(screen.includes('Slack     DM the join link to a teammate'), 'the Slack connector row');
  assert.ok(screen.includes('Gmail     email it'), 'the Gmail connector row');
  assert.ok(screen.includes('Discord   DM it to a friend'), 'the Discord connector row');
  assert.ok(screen.includes('collaborations run through our free server (claudecollab.org).'), 'the relay line');
  assert.ok(screen.includes('please consider donating so we can keep this open ♥'), 'the donate line');
  assert.ok(screen.includes('↑↓ move · space toggle · enter start claude'), 'the key hints');
});

test('enter immediately keeps the default selection (Slack on)', async () => {
  const input = new PassThrough();
  const output = makeOutput();
  const p = runFirstRun({ input, output });
  input.write('\r');
  const res = await p;
  assert.deepEqual(res, { connectors: ['slack'] });
});

test('space, ↓, space, enter → Slack off, Gmail on', async () => {
  const input = new PassThrough();
  const output = makeOutput();
  const p = runFirstRun({ input, output });
  input.write(' '); // toggle Slack (cursor at 0) off
  input.write('\x1b[B'); // move down to Gmail
  input.write(' '); // toggle Gmail on
  input.write('\r'); // start
  const res = await p;
  assert.deepEqual(res, { connectors: ['gmail'] });
});

test('toggling everything off resolves to an empty connector list', async () => {
  const input = new PassThrough();
  const output = makeOutput();
  const p = runFirstRun({ input, output });
  input.write(' '); // Slack off (only default-on box)
  input.write('\r');
  const res = await p;
  assert.deepEqual(res, { connectors: [] });
});
