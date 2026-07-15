// shim.js — install/undo of the `claude` shim + marker-delimited rc edits, and the
// pure PATH helper that keeps the wrapped `claude` from resolving back to the shim.
// Every filesystem side effect runs under a fresh tmp HOME — never the real one.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { shimDir, installShim, removeShim, stripShimDir } from './shim.js';

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cs-shim-'));
}

test('installShim writes a 0755 shim script with the exact recursion-safe contents', () => {
  const home = tmpHome();
  try {
    const res = installShim({ home, rcFiles: [path.join(home, '.zshrc')] });
    assert.equal(res.installed, true);
    const script = path.join(shimDir(home), 'claude');
    const body = fs.readFileSync(script, 'utf8');
    assert.ok(body.startsWith('#!/bin/sh'), 'a sh script');
    assert.ok(body.includes('exec collab "$@"'), 'prefers a global collab');
    assert.ok(body.includes('exec npx -y @claudecollab/cli "$@"'), 'falls back to npx for npx-only installs');
    assert.equal(fs.statSync(script).mode & 0o777, 0o755, 'the shim script is executable (0755)');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('installShim appends exactly one marker block; a second install stays one', () => {
  const home = tmpHome();
  const rc = path.join(home, '.zshrc');
  try {
    fs.writeFileSync(rc, 'export FOO=bar\n');
    installShim({ home, rcFiles: [rc] });
    installShim({ home, rcFiles: [rc] }); // idempotent
    const content = fs.readFileSync(rc, 'utf8');
    const starts = content.split('# >>> claude-share shim >>>').length - 1;
    assert.equal(starts, 1, 'exactly one marker block after a double install');
    assert.match(content, /# >>> claude-share shim >>>\nexport PATH="\$HOME\/\.claude-share\/bin:\$PATH"\n# <<< claude-share shim <<<\n/);
    assert.ok(content.startsWith('export FOO=bar\n'), 'the pre-existing rc content is preserved');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('removeShim deletes the script and strips the block, leaving the rc byte-identical', () => {
  const home = tmpHome();
  const rc = path.join(home, '.zshrc');
  try {
    const original = 'export FOO=bar\nalias ll="ls -la"\n';
    fs.writeFileSync(rc, original);
    installShim({ home, rcFiles: [rc] });
    assert.ok(fs.existsSync(path.join(shimDir(home), 'claude')), 'shim installed');
    removeShim({ home, rcFiles: [rc] });
    assert.ok(!fs.existsSync(path.join(shimDir(home), 'claude')), 'shim script removed');
    assert.equal(fs.readFileSync(rc, 'utf8'), original, 'the rest of the rc is byte-identical');
    // Idempotent — a second remove is a no-op.
    removeShim({ home, rcFiles: [rc] });
    assert.equal(fs.readFileSync(rc, 'utf8'), original, 'a second remove leaves the rc untouched');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('installShim creates .zshrc when neither default rc exists', () => {
  const home = tmpHome();
  try {
    const res = installShim({ home });
    assert.ok(fs.existsSync(path.join(home, '.zshrc')), 'a .zshrc is created when none exists');
    assert.deepEqual(res.rcFiles, [path.join(home, '.zshrc')]);
    assert.match(fs.readFileSync(path.join(home, '.zshrc'), 'utf8'), /# >>> claude-share shim >>>/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('stripShimDir removes the shim dir entry (expanded and $HOME forms) and leaves other PATHs unchanged', () => {
  const home = '/home/tester';
  const shim = path.join(home, '.claude-share', 'bin');
  assert.equal(stripShimDir(`/a:${shim}:/b`, home), '/a:/b', 'expanded shim dir is removed');
  assert.equal(stripShimDir(`/a:$HOME/.claude-share/bin:/b`, home), '/a:/b', 'the $HOME-literal form is removed');
  assert.equal(stripShimDir('/a:/b:/c', home), '/a:/b:/c', 'a PATH without the shim dir is returned unchanged');
});
