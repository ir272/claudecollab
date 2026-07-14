// The `claude` shim — the mechanism that makes `claude` itself go multiplayer.
//
// A tiny `claude` script in <home>/.claude-share/bin execs `collab "$@"`; a
// marker-delimited line in the user's rc prepends that dir to PATH, so a fresh
// terminal's `claude` IS collab wrapping the real claude. The recursion guard lives
// in claude-share.js: when collab spawns its child `claude`, it strips THIS dir from
// the child's PATH (stripShimDir), so the wrapped command resolves to the real
// binary, never back to the shim. Spike-proven (2026-07-14): no recursion at depth 3.
//
// Everything here is pure/injectable — install/undo take an explicit `home` and
// `rcFiles`, so tests run entirely under a tmp HOME and never touch the real one.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const MARK_START = '# >>> claude-share shim >>>';
const MARK_END = '# <<< claude-share shim <<<';
// The one PATH line the block manages. $HOME (not the expanded path) so the rc line
// stays portable across machines/home dirs.
const PATH_LINE = 'export PATH="$HOME/.claude-share/bin:$PATH"';
// Default rc candidates (macOS/Linux stance — no Windows rc handling by design).
const RC_CANDIDATES = ['.zshrc', '.bashrc'];

/** The dir the shim script lives in: `<home>/.claude-share/bin`. */
export function shimDir(home = os.homedir()) {
  return path.join(home, '.claude-share', 'bin');
}

/** The full managed block, markers + the PATH line, each on its own line. */
function block() {
  return `${MARK_START}\n${PATH_LINE}\n${MARK_END}\n`;
}

// Which rc files to write to. An explicit list wins (tests, power users). Otherwise
// every existing default candidate; if NONE exists, create a .zshrc.
function resolveRcFiles(home, rcFiles) {
  if (Array.isArray(rcFiles)) return rcFiles;
  const existing = RC_CANDIDATES.map((n) => path.join(home, n)).filter((p) => fs.existsSync(p));
  return existing.length ? existing : [path.join(home, '.zshrc')];
}

/**
 * Install the shim: write the exec script (0755) and append the managed PATH block
 * to each rc (idempotent — a present marker skips it). Returns which rc files carry
 * the block.
 * @returns {{ installed: true, rcFiles: string[] }}
 */
export function installShim({ home = os.homedir(), rcFiles } = {}) {
  const dir = shimDir(home);
  fs.mkdirSync(dir, { recursive: true });
  const script = path.join(dir, 'claude');
  fs.writeFileSync(script, '#!/bin/sh\nexec collab "$@"\n', { mode: 0o755 });
  fs.chmodSync(script, 0o755); // writeFileSync doesn't re-chmod an existing file

  const targets = resolveRcFiles(home, rcFiles);
  for (const rc of targets) {
    let content = '';
    try {
      content = fs.readFileSync(rc, 'utf8');
    } catch {
      /* rc doesn't exist yet — we create it below */
    }
    if (content.includes(MARK_START)) continue; // idempotent: block already present
    // Keep the block on its own line: separate from prior content that lacks a
    // trailing newline. A normal rc (ends in \n) needs no separator, so removeShim
    // restores it byte-for-byte.
    const sep = content.length && !content.endsWith('\n') ? '\n' : '';
    fs.appendFileSync(rc, sep + block());
  }
  return { installed: true, rcFiles: targets };
}

// Strip the managed block from rc text. Matches the whole block through its trailing
// newline, so an rc that ended in \n before install is restored byte-identical.
function stripBlock(content) {
  const re = new RegExp(`${escapeRe(MARK_START)}\\n[\\s\\S]*?${escapeRe(MARK_END)}\\n?`);
  return content.replace(re, '');
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Remove the shim: delete the exec script and strip the managed block from each rc.
 * Idempotent — missing script/block is a no-op.
 * @returns {{ removed: true }}
 */
export function removeShim({ home = os.homedir(), rcFiles } = {}) {
  try {
    fs.unlinkSync(path.join(shimDir(home), 'claude'));
  } catch {
    /* already gone */
  }
  const targets = resolveRcFiles(home, rcFiles);
  for (const rc of targets) {
    let content;
    try {
      content = fs.readFileSync(rc, 'utf8');
    } catch {
      continue; // no such rc — nothing to strip
    }
    const stripped = stripBlock(content);
    if (stripped !== content) fs.writeFileSync(rc, stripped);
  }
  return { removed: true };
}

/**
 * The recursion guard: return `pathStr` with the shim dir entry removed. Matches the
 * expanded dir AND the unexpanded $HOME/~ forms an rc might have introduced. A PATH
 * without the shim dir is returned unchanged.
 * @param {string} pathStr  a PATH-style, delimiter-joined string
 * @param {string} home
 */
export function stripShimDir(pathStr, home = os.homedir()) {
  if (!pathStr) return pathStr;
  const dir = shimDir(home);
  const variants = new Set([dir, '$HOME/.claude-share/bin', '${HOME}/.claude-share/bin', '~/.claude-share/bin']);
  return pathStr
    .split(path.delimiter)
    .filter((entry) => !variants.has(entry))
    .join(path.delimiter);
}
