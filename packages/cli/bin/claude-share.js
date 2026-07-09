#!/usr/bin/env node
// claude-share — wrap Claude Code in a PTY and paint a live multiplayer band
// under its full-screen TUI. Runs Claude locally (frame-synced band redraws,
// full I/O passthrough) and, unless `--no-relay`, connects to a relay so real
// ssh guests can watch live. Task 5 is viewer-grade: guests knock, the host
// admits with y/n, guests mirror the host's screen. Draft-lines, the queue, and
// the per-role input gate land in Tasks 6–7.

import process from 'node:process';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import ssh2 from 'ssh2';
import { startPty } from '../src/pty.js';
import { paint } from '../src/renderer.js';
import { installHooks, listenHooks } from '../src/hooks.js';
import { connectRelay, parseRelayUrl } from '../src/relay-client.js';

function parseArgs(argv) {
  const opts = {
    relay: true,
    relayUrl: 'ssh://127.0.0.1:2222', // dev default; override with --relay <url>
    bandRows: 2,
    cmd: 'claude',
    hooks: true,
    childArgs: [],
  };
  const passthrough = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--no-relay') opts.relay = false;
    else if (a === '--relay') opts.relayUrl = argv[++i] ?? opts.relayUrl;
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

// The host's stable ssh identity. Its fingerprint gates room reclaim on the relay
// (spec §failure-behavior), so it must survive restarts — we persist one under
// ~/.claude-share and reuse it. Generated on first run; readable only by the user.
function loadHostKey() {
  const dir = path.join(os.homedir(), '.claude-share');
  const keyPath = path.join(dir, 'host_key');
  try {
    return fs.readFileSync(keyPath);
  } catch {
    /* not created yet */
  }
  const priv = ssh2.utils.generateKeyPairSync('ed25519').private;
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(keyPath, priv, { mode: 0o600 });
  } catch {
    /* home not writable — fall back to an in-memory key for this run */
  }
  return priv;
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

  // Relay/multiplayer state (Task 5). The relay hands us a room code, forwards
  // guest knocks, and mirrors our screen to admitted guests. Everything else
  // (drafts, roles, the real per-role gate) is Task 7; here every guest is a
  // viewer whose keystrokes we drop.
  const relayState = {
    room: null, // room code once the relay grants it
    pendingKnocks: [], // FIFO of {id,name,fp,seen} awaiting the host's y/n
    guests: new Map(), // id -> {name, role} for admitted guests
    namesById: new Map(), // id -> claimed name (from the knock, for join/leave copy)
    toast: null, // transient one-line event message shown in the band
    toastTimer: null,
  };

  let exited = false;

  // Short, readable fingerprint tail for the knock line (spec frame: "key a1b2c3…").
  const shortFp = (fp) => (fp ? fp.replace(/^SHA256:/, '').slice(0, 6) + '…' : 'no key');

  // The band's dynamic line, in priority order: a pending knock wins (spec: knocks
  // render in the band, never over Claude's output), then a transient event toast,
  // then Claude's hook-derived state, then a relay/solo fallback.
  const bandStatus = () => {
    const k = relayState.pendingKnocks[0];
    if (k) {
      const seenNote = k.seen == null ? ' · ⚠ first time seeing this key' : ` · seen before as ${k.seen}`;
      return `🚪 "${k.name}" knocking — key ${shortFp(k.fp)}${seenNote} — admit? (y/n)`;
    }
    if (relayState.toast) return relayState.toast;
    if (hooks) return CLAUDE_STATUS[claude.state] ?? claude.state;
    if (relayState.room) return `room live · ${relayState.guests.size} watching`;
    return relay ? 'connecting to relay…' : 'no relay — solo session · band is a placeholder';
  };

  const bandState = () => ({
    cols: stdout.columns || 80,
    rows: stdout.rows || 24,
    bandRows,
    room: relayState.room,
    participants: [{ name: hostName(), role: 'host' }, ...relayState.guests.values()],
    mode: hooks ? claude.mode : 'default',
    status: bandStatus(),
  });

  const repaintBand = () => {
    if (stdout.isTTY) stdout.write(paint(bandState()));
  };

  const showToast = (msg, ms = 4000) => {
    relayState.toast = msg;
    clearTimeout(relayState.toastTimer);
    relayState.toastTimer = setTimeout(() => {
      relayState.toast = null;
      repaintBand();
    }, ms);
    relayState.toastTimer.unref?.();
    repaintBand();
  };

  // ── relay client (Task 5) ────────────────────────────────────────────────────
  // Connect to the relay as the host, request a room, and mirror our screen to
  // admitted guests. A pending knock is answered by the host's next lone y/n
  // (see the stdin handler). If the relay is unreachable we warn and keep running
  // solo — a down relay must never take Claude down with it.
  let relay = null;

  const answerKnock = (admitYes) => {
    const knock = relayState.pendingKnocks.shift();
    if (!knock || !relay) return;
    if (admitYes) relay.admit(knock.id);
    else {
      relay.deny(knock.id);
      showToast(`declined ${knock.name}`);
    }
    repaintBand();
  };

  if (opts.relay) {
    try {
      relay = connectRelay({ url: opts.relayUrl, privateKey: loadHostKey() });
      relay.onRoom((code) => {
        relayState.room = code;
        const { host: relayHost } = parseRelayUrl(opts.relayUrl);
        showToast(`room ready · invite: ssh ${code}@${relayHost}`, 8000);
      });
      relay.onKnock((knock) => {
        relayState.namesById.set(knock.id, knock.name);
        relayState.pendingKnocks.push(knock);
        repaintBand();
      });
      relay.onJoin((id) => {
        const name = relayState.namesById.get(id) ?? 'guest';
        relayState.guests.set(id, { name, role: 'viewer' });
        showToast(`${name} joined as viewer 👁`);
      });
      relay.onLeave((id) => {
        const name = relayState.guests.get(id)?.name ?? relayState.namesById.get(id) ?? 'a guest';
        relayState.guests.delete(id);
        relayState.pendingKnocks = relayState.pendingKnocks.filter((k) => k.id !== id);
        relayState.namesById.delete(id);
        showToast(`${name} left`);
      });
      // Viewer-grade (Task 5): guests are viewers, so their keystrokes are dropped
      // here. Task 7's role gate routes these by role. Registered so the plumbing
      // is exercised and the deviation is explicit in code.
      relay.onKey(() => {});
      relay.onClose(() => {
        if (!exited) showToast('relay disconnected — running solo', 8000);
      });
      relay.onError(() => {}); // transport errors surface via onClose; never crash
      relay.ready.then(() => relay.hello()).catch((err) => {
        process.stderr.write(`claude-share: relay unavailable (${err.message}); running solo\n`);
        relay = null;
      });
    } catch (err) {
      process.stderr.write(`claude-share: relay setup failed (${err.message}); running solo\n`);
      relay = null;
    }
  }

  // Redraw the band when Claude's state or mode changes (state itself is updated
  // by the handlers registered above, which run first).
  if (hooks) {
    for (const evt of ['busy', 'idle', 'ask', 'mode']) hooks.on(evt, repaintBand);
  }

  const cleanup = (code) => {
    if (exited) return;
    exited = true;
    try {
      if (stdin.isTTY) stdin.setRawMode(false);
    } catch {}
    stdin.pause();
    // Tell the relay the session is over (disconnects guests, drops the room) and
    // close our control channel. `end` then `close` mirrors /end → teardown.
    try {
      relay?.end();
      relay?.close();
    } catch {}
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
  // The same frame is mirrored to admitted guests (viewer-grade multiplayer). The
  // host-local band (repaintBand → stdout) is deliberately NOT broadcast in v1;
  // guest-side band compositing + the shared-view size clamp land in Task 7.
  pty.onFrame((chunk) => {
    stdout.write(chunk);
    if (relay) relay.sendScreen(chunk);
    repaintBand();
  });
  pty.onExit(({ exitCode }) => cleanup(exitCode ?? 0));

  // Host keystrokes → child, raw. In raw mode Ctrl+C arrives as a 0x03 byte and
  // is forwarded to Claude (spec input table: host Ctrl+C is normal).
  if (stdin.isTTY) stdin.setRawMode(true);
  stdin.resume();
  stdin.on('data', (d) => {
    // While a guest is knocking, the host's lone y/n answers the knock and is NOT
    // forwarded to Claude (Task 5 admit path). A single y/n keystroke only — a
    // paste or a longer token passes straight through. Task 7 replaces this stopgap
    // with the full per-role input gate.
    if (relay && relayState.pendingKnocks.length) {
      const s = d.toString('utf8');
      if (s === 'y' || s === 'Y') return answerKnock(true);
      if (s === 'n' || s === 'N') return answerKnock(false);
    }
    pty.write(d);
  });

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
