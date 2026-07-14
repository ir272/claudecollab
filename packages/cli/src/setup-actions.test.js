// setup-actions.js — the first-run side effects (plugin install, shim install,
// connector guidance), the marker, the trigger predicate, and undo. execFile and the
// shim fns are injected so tests never shell out or touch the real HOME.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { PassThrough } from 'node:stream';
import { stripControls } from './brain/log.js';
import {
  installPlugin,
  installShimAction,
  connectorInstructions,
  undoSetup,
  shouldRunSetup,
  markerPath,
  setupDone,
  writeMarker,
  runSetup,
} from './setup-actions.js';
import { shimDir } from './shim.js';

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cs-setup-'));
}

test('installPlugin runs the marketplace add + install and reports success', async () => {
  const calls = [];
  const execFile = async (cmd, args) => {
    calls.push([cmd, ...args]);
  };
  const line = await installPlugin({ execFile });
  assert.deepEqual(calls, [
    ['claude', 'plugin', 'marketplace', 'add', 'ir272/claudecollab'],
    ['claude', 'plugin', 'install', 'collab@claudecollab'],
  ]);
  assert.match(line, /\/collab/);
  assert.ok(!line.startsWith("couldn't"), 'a success line, not the failure copy');
});

test('installPlugin failure returns the exact retry copy', async () => {
  const execFile = async () => {
    throw new Error('not found');
  };
  const line = await installPlugin({ execFile });
  assert.equal(
    line,
    "couldn't install the /collab plugin (offline or repo not public yet) — rerun anytime: collab setup",
  );
});

test('installShimAction installs the shim and reports the exact success line', () => {
  const home = tmpHome();
  try {
    const line = installShimAction({ home, rcFiles: [path.join(home, '.zshrc')] });
    assert.equal(line, '✓ `claude` is now shareable (new terminals; or run: rehash)');
    assert.ok(fs.existsSync(path.join(shimDir(home), 'claude')), 'the shim script was written');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('installShimAction failure reports a retry line mentioning collab setup --undo', () => {
  const installShimFn = () => {
    throw new Error('read-only home');
  };
  const line = installShimAction({ installShimFn });
  assert.ok(line.includes('collab setup --undo'), 'the failure line points at the undo command');
});

test('connectorInstructions prints one honest instruction per checked connector, none for empty', () => {
  assert.deepEqual(connectorInstructions([]), []);
  const lines = connectorInstructions(['slack', 'gmail']);
  assert.equal(lines.length, 2);
  assert.ok(lines[0].includes('Slack') && lines[0].includes('claude.ai/customize/connectors'));
  assert.ok(lines[1].includes('Gmail') && lines[1].includes('claude.ai/customize/connectors'));
});

test('undoSetup calls removeShim and best-effort uninstalls the plugin, reporting both', async () => {
  const removed = [];
  const execCalls = [];
  const out = [];
  await undoSetup({
    home: '/tmp/whatever',
    removeShimFn: (opts) => removed.push(opts),
    execFile: async (cmd, args) => execCalls.push([cmd, ...args]),
    out: (s) => out.push(s),
  });
  assert.equal(removed.length, 1, 'removeShim was called');
  assert.deepEqual(execCalls, [['claude', 'plugin', 'uninstall', 'collab@claudecollab']]);
  assert.ok(out.some((l) => l.includes('shim')), 'reports the shim removal');
  assert.ok(out.some((l) => l.includes('/collab')), 'reports the plugin uninstall');
});

test('undoSetup tolerates a plugin uninstall failure and still reports', async () => {
  const out = [];
  await undoSetup({
    removeShimFn: () => {},
    execFile: async () => {
      throw new Error('nope');
    },
    out: (s) => out.push(s),
  });
  assert.ok(out.some((l) => l.includes('/collab')), 'still reports the plugin outcome on failure');
});

test('shouldRunSetup: interactive + no marker + no skip + no --yes → true; each guard flips it off', () => {
  const home = tmpHome();
  try {
    const base = { stdinTTY: true, stdoutTTY: true, home, skipEnv: undefined, yes: false };
    assert.equal(shouldRunSetup(base), true, 'fresh interactive run shows the screen');
    assert.equal(shouldRunSetup({ ...base, skipEnv: '1' }), false, 'CLAUDE_SHARE_SKIP_SETUP=1 skips it');
    assert.equal(shouldRunSetup({ ...base, yes: true }), false, '--yes skips it');
    assert.equal(shouldRunSetup({ ...base, stdinTTY: false }), false, 'non-TTY stdin skips it');
    assert.equal(shouldRunSetup({ ...base, stdoutTTY: false }), false, 'non-TTY stdout skips it');
    writeMarker(home);
    assert.equal(shouldRunSetup(base), false, 'the setup-done marker skips it');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('marker helpers write and detect the setup-done marker under the given home', () => {
  const home = tmpHome();
  try {
    assert.equal(setupDone(home), false);
    writeMarker(home);
    assert.equal(setupDone(home), true);
    assert.equal(markerPath(home), path.join(home, '.claude-share', 'setup-done'));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('runSetup drives the screen, runs actions, and writes the marker even when an action fails', async () => {
  const home = tmpHome();
  try {
    const input = new PassThrough();
    let out = '';
    const output = { write: (s) => (out += s) };
    const p = runSetup({
      input,
      output,
      home,
      rcFiles: [path.join(home, '.zshrc')],
      execFile: async () => {
        throw new Error('plugin add failed'); // the repo-private case
      },
    });
    input.write('\r'); // accept defaults, start
    const res = await p;
    assert.deepEqual(res, { connectors: ['slack'] });
    const clean = stripControls(out); // the screen is ANSI-styled; assert on the words
    assert.ok(clean.includes('✦ collab — first run'), 'the screen was rendered');
    assert.ok(out.includes("couldn't install the /collab plugin"), 'the plugin failure line was printed');
    assert.ok(out.includes('`claude` is now shareable'), 'the shim success line was printed');
    assert.equal(setupDone(home), true, 'the marker is written even though the plugin action failed');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
