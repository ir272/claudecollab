// first-run.js — the one-screen setup shown on the first interactive `collab`. Pure
// I/O injection: tests feed byte sequences to an injected input stream and assert the
// rendered output + the resolved selection. No real TTY, no real HOME.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { runFirstRun } from './first-run.js';
import { stripControls } from './brain/log.js';

// Collect everything written to the injected output. The screen is styled (ANSI
// color/selection codes), so copy assertions match on the STRIPPED text — the
// approved words themselves, independent of paint.
function makeOutput() {
  let buf = '';
  return { write: (s) => (buf += s), get: () => stripControls(buf) };
}

test('renders the approved copy — wordmark, core line, Slack row, relay footer', async () => {
  const input = new PassThrough();
  const output = makeOutput();
  const p = runFirstRun({ input, output });
  input.write('\r'); // enter immediately so the promise resolves
  await p;
  const screen = output.get();
  assert.ok(screen.includes('█████'), 'the CLAUDE COLLAB wordmark blocks');
  assert.ok(screen.includes('✓ /collab will be added to Claude Code'), 'the core line');
  assert.ok(screen.includes('run /collab to turn it multiplayer!'), 'the /collab hint');
  assert.ok(screen.includes('Select Claude’s connectors:'.replace('’', "'")), 'the connector prompt');
  assert.ok(screen.includes('Slack     DM the join link to a teammate'), 'the Slack connector row');
  assert.ok(!screen.includes('Gmail') && !screen.includes('Discord'), 'Slack only for now');
  assert.ok(screen.includes('want your own server? `collab relay` (guide in the README). ♥'), 'the server line, verbatim');
  assert.ok(!screen.includes('collaborations run through'), 'the free-server line is gone');
  assert.ok(!screen.includes('please consider donating'), 'the donate line is gone');
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

test('space toggles Slack off, space again back on', async () => {
  const input = new PassThrough();
  const output = makeOutput();
  const p = runFirstRun({ input, output });
  input.write(' '); // toggle Slack (cursor at 0) off
  input.write(' '); // and back on
  input.write('\r'); // start
  const res = await p;
  assert.deepEqual(res, { connectors: ['slack'] });
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
