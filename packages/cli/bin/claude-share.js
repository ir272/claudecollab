#!/usr/bin/env node
// claude-share — wrap Claude Code in a PTY and paint a live multiplayer band
// under its full-screen TUI. Task 3 scope: `claude-share --no-relay` runs Claude
// locally with a placeholder band; frame-synced redraws; full I/O passthrough.
// Relay/knock/drafts/roles land in later tasks.

import process from 'node:process';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { startPty } from '../src/pty.js';
import { paint } from '../src/renderer.js';
import { installHooks, listenHooks } from '../src/hooks.js';

function parseArgs(argv) {
  const opts = { relay: true, bandRows: 2, cmd: 'claude', hooks: true, childArgs: [] };
  const passthrough = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--no-relay') opts.relay = false;
    else if (a === '--no-hooks') opts.hooks = false;
    else if (a === '--band-rows') opts.bandRows = Math.max(1, Number(argv[++i]) || opts.bandRows);
    else if (a === '--cmd') opts.cmd = argv[++i];
    else if (a === '--') {
      passthrough.push(...argv.slice(i + 1));
      break;
    } else passthrough.push(a); // unknown flags pass through to the child
  }
  opts.childArgs = passthrough;
  return opts;
}

function hostName() {
  try {
    return os.userInfo().username || process.env.USER || 'host';
  } catch {
    return process.env.USER || 'host';
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const { stdin, stdout } = process;
  const bandRows = opts.bandRows;

  // Hook-based state detection (Task 4). We inject a --settings file whose hooks
  // post to a private unix socket, and listen on that socket for busy/idle/ask/tool.
  // Only for the real `claude` binary — a stub cmd (e.g. --cmd bash) would choke on
  // `--settings`, and its hooks would never fire anyway.
  const childArgs = [...opts.childArgs];
  let hooks = null;
  let settingsFile = null;
  let socketPath = null;
  const claude = { state: 'idle', mode: 'default' };
  if (opts.hooks && opts.cmd === 'claude') {
    try {
      socketPath = path.join(os.tmpdir(), `claude-share-${process.pid}.sock`);
      settingsFile = installHooks(socketPath);
      hooks = listenHooks(socketPath);
      await hooks.ready;
      hooks.on('busy', () => (claude.state = 'busy'));
      hooks.on('idle', () => (claude.state = 'idle'));
      hooks.on('ask', () => (claude.state = 'ask'));
      hooks.on('mode', (m) => (claude.mode = m));
      childArgs.unshift('--settings', settingsFile);
    } catch (err) {
      process.stderr.write(`claude-share: hook setup failed (${err.message}); state detection off\n`);
      hooks = null;
    }
  }

  let pty;
  try {
    pty = await startPty({ cmd: opts.cmd, args: childArgs, bandRows });
  } catch (err) {
    process.stderr.write(
      `claude-share: could not start "${opts.cmd}": ${err.message}\n` +
        'If this is a native-module error, run `npm install` in packages/cli (needs node-pty).\n',
    );
    process.exit(1);
  }

  const CLAUDE_STATUS = { busy: '✻ brewing…', idle: '● idle', ask: '⚠ permission ask pending' };
  const bandState = () => ({
    cols: stdout.columns || 80,
    rows: stdout.rows || 24,
    bandRows,
    room: null, // relay assigns this in a later task
    participants: [{ name: hostName(), role: 'host' }],
    mode: hooks ? claude.mode : 'default',
    status: hooks
      ? (CLAUDE_STATUS[claude.state] ?? claude.state)
      : opts.relay
        ? 'connecting to relay…'
        : 'no relay — solo session · band is a placeholder (Task 3)',
  });

  const repaintBand = () => {
    if (stdout.isTTY) stdout.write(paint(bandState()));
  };

  // Redraw the band when Claude's state or mode changes (state itself is updated
  // by the handlers registered above, which run first).
  if (hooks) {
    for (const evt of ['busy', 'idle', 'ask', 'mode']) hooks.on(evt, repaintBand);
  }

  let exited = false;
  const cleanup = (code) => {
    if (exited) return;
    exited = true;
    try {
      if (stdin.isTTY) stdin.setRawMode(false);
    } catch {}
    stdin.pause();
    // Best-effort synchronous teardown of the hook socket + settings file before
    // we exit (hooks.close() is async and wouldn't finish before process.exit).
    try {
      hooks?.close();
    } catch {}
    for (const f of [settingsFile, socketPath]) {
      if (f) {
        try {
          fs.unlinkSync(f);
        } catch {}
      }
    }
    // Leave the alternate screen the child entered, then drop below the band.
    stdout.write('\x1b[?1049l\r\n[claude-share exited]\r\n');
    process.exit(code ?? 0);
  };

  // Passthrough + frame-synced band redraw: write the whole frame, then repaint.
  pty.onFrame((chunk) => {
    stdout.write(chunk);
    repaintBand();
  });
  pty.onExit(({ exitCode }) => cleanup(exitCode ?? 0));

  // Host keystrokes → child, raw. In raw mode Ctrl+C arrives as a 0x03 byte and
  // is forwarded to Claude (spec input table: host Ctrl+C is normal).
  if (stdin.isTTY) stdin.setRawMode(true);
  stdin.resume();
  stdin.on('data', (d) => pty.write(d));

  process.on('SIGWINCH', () => {
    pty.resize();
    repaintBand();
  });
  process.on('exit', () => {
    try {
      if (stdin.isTTY) stdin.setRawMode(false);
    } catch {}
  });

  repaintBand(); // draw the band immediately, before the first frame
}

main().catch((err) => {
  process.stderr.write(`claude-share: ${err?.stack || err}\n`);
  process.exit(1);
});
