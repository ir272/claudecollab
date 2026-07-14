// End-to-end smoke test — the whole system on localhost, real processes, in the
// design-v2 shape (the host terminal is the engine room; the browser is the one
// multiplayer surface for everyone, host included):
//
//   • the relay ssh server + browser door (packages/relay), in-process on ephemeral
//     ports;
//   • the real host CLI (packages/cli/bin/claude-share.js), spawned inside a PTY so
//     its status line paints and stdin passes STRAIGHT THROUGH — driving a fake-claude
//     stub (test/fixtures/fake-claude.cjs) that echoes prompts and fires the injected
//     lifecycle hooks, so state detection is real, not mocked;
//   • the host's own browser tab, simulated as a `ws` WebSocket to the web door with
//     the host token — every multiplayer move (admit, /role, /kick, /end) is made here;
//   • an ssh guest, exactly as a stock `ssh` client would connect.
//
// Scenario:
//   host boots → prints the room URL with a host token → the host tab opens on that
//   URL and is auto-admitted as host → guest A knocks (named key) → the host tab admits
//   it from the browser → the host tab promotes A to prompter → A composes a draft that
//   reaches Claude, hits a permission ask, and A queues a second prompt while busy → A's
//   a viewer's `y` is REJECTED → back to prompter → A's `y` is ACCEPTED
//   and the queue drains → the host tab kicks A → the host tab ends the session → assert
//   the mirror, the attributed queue in the overlay state, the gate decision, and
//   session.md.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { connect as netConnect } from 'node:net';
import ssh2 from 'ssh2';
import * as ptyNs from 'node-pty';
import { WebSocket } from 'ws';
import { startRelay } from '../packages/relay/server.js';

const ptySpawn = ptyNs.spawn ?? ptyNs.default?.spawn;
const { Client, utils } = ssh2;
const { generateKeyPairSync, parseKey } = utils;

// ssh2's generateKeyPairSync occasionally emits a key its own parser rejects
// ("Malformed OpenSSH private key"). Validate with parseKey and regenerate.
function newKey() {
  for (let i = 0; i < 8; i++) {
    const priv = generateKeyPairSync('ed25519').private;
    if (!(parseKey(priv) instanceof Error)) return priv;
  }
  return generateKeyPairSync('ed25519').private;
}

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const cliEntry = join(repoRoot, 'packages/cli/bin/claude-share.js');
const fakeClaude = join(here, 'fixtures', 'fake-claude.cjs');

const DEFAULT_TIMEOUT = 20000;
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// A text sink with substring waits — the accumulated buffer, so a match is found
// even if the write was chunked or a repaint has since overwritten the cells.
function makeSink() {
  let out = '';
  const waiters = [];
  const check = () => {
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (out.includes(waiters[i].sub)) {
        clearTimeout(waiters[i].timer);
        waiters.splice(i, 1)[0].resolve(out);
      }
    }
  };
  return {
    feed(s) {
      out += s;
      check();
    },
    get: () => out,
    has: (sub) => out.includes(sub),
    waitFor(sub, ms = DEFAULT_TIMEOUT) {
      if (out.includes(sub)) return Promise.resolve(out);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          const idx = waiters.findIndex((w) => w.sub === sub);
          if (idx !== -1) waiters.splice(idx, 1);
          reject(new Error(`timed out waiting for ${JSON.stringify(sub)}\n--- tail ---\n${out.slice(-1200)}`));
        }, ms);
        waiters.push({ sub, resolve, timer });
      });
    },
  };
}

// A scripted ssh guest: raw pty + shell, accumulating output — the shape a real
// terminal presents to the relay. `keyboard:true` drives the keyless flow.
function connectGuest(port, { code, privateKey, keyboard } = {}) {
  return new Promise((resolve, reject) => {
    const client = new Client();
    const sink = makeSink();
    let closed = false;
    const closeWaiters = [];
    const api = {
      client,
      waitFor: sink.waitFor,
      has: sink.has,
      getOut: sink.get,
      onClose: () => (closed ? Promise.resolve() : new Promise((res) => closeWaiters.push(res))),
    };
    if (keyboard) client.on('keyboard-interactive', (n, i, l, p, finish) => finish([]));
    client.on('error', reject);
    client.on('ready', () => {
      client.shell({ term: 'xterm', rows: 30, cols: 100, width: 0, height: 0 }, (err, stream) => {
        if (err) return reject(err);
        api.stream = stream;
        api.type = (s) => stream.write(s);
        stream.on('data', (d) => sink.feed(d.toString('utf8')));
        stream.on('close', () => {
          closed = true;
          closeWaiters.splice(0).forEach((r) => r());
        });
        resolve(api);
      });
    });
    const opts = { host: '127.0.0.1', port, username: code };
    if (privateKey) opts.privateKey = privateKey;
    if (keyboard) opts.tryKeyboard = true;
    client.connect(opts);
  });
}

// The host's browser tab, over the web door. It carries the host token, so the brain
// auto-admits it as host. Screen bytes arrive as binary frames (ignored here); the
// overlay {t:'state'} and the {t:'joined'} cue arrive as text frames. It mails back
// the exact {t:'ui'} admit/deny/command messages the real browser client sends.
function connectHostTab(webPort, { code, token, seat = 'hostseat' }) {
  const states = [];
  const waiters = [];
  const joinWaiters = [];
  const errWaiters = [];
  let selfId = null;
  let joined = false;
  let errored = null;

  const ws = new WebSocket(`ws://127.0.0.1:${webPort}/ws?room=${code}&host=${token}&seat=${seat}`);

  const pushState = (data) => {
    states.push(data);
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].pred(data)) {
        clearTimeout(waiters[i].timer);
        waiters.splice(i, 1)[0].resolve(data);
      }
    }
  };

  ws.on('message', (buf, isBinary) => {
    if (isBinary) return; // screen bytes → the xterm mirror in a real browser
    let msg;
    try {
      msg = JSON.parse(buf.toString('utf8'));
    } catch {
      return;
    }
    if (msg.t === 'joined') {
      selfId = msg.id;
      joined = true;
      joinWaiters.splice(0).forEach((r) => r());
    } else if (msg.t === 'state') {
      pushState(msg.data);
    } else if (msg.t === 'error') {
      errored = msg;
      errWaiters.splice(0).forEach((r) => r(msg));
    }
  });

  const send = (obj) => ws.send(JSON.stringify(obj));
  const api = {
    ws,
    get selfId() {
      return selfId;
    },
    onJoined: (ms = DEFAULT_TIMEOUT) =>
      joined
        ? Promise.resolve()
        : new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('host tab: never joined')), ms);
            joinWaiters.push(() => {
              clearTimeout(timer);
              resolve();
            });
          }),
    onError: (ms = DEFAULT_TIMEOUT) =>
      errored
        ? Promise.resolve(errored)
        : new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('host tab: expected a refusal, got none')), ms);
            errWaiters.push((m) => {
              clearTimeout(timer);
              resolve(m);
            });
          }),
    admit: (id) => send({ t: 'ui', action: { kind: 'admit', id } }),
    command: (text) => send({ t: 'ui', action: { kind: 'command', text } }),
    resize: (cols, rows) => send({ t: 'resize', cols, rows }),
    latestState: () => states[states.length - 1] ?? null,
    waitForState(pred, ms = DEFAULT_TIMEOUT) {
      const found = [...states].reverse().find(pred);
      if (found) return Promise.resolve(found);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('host tab: timed out waiting for a state frame')), ms);
        waiters.push({ pred, resolve, timer });
      });
    },
    close: () => {
      try {
        ws.close();
      } catch {}
    },
  };

  return new Promise((resolve, reject) => {
    ws.on('open', () => resolve(api));
    ws.on('error', reject);
  });
}

test('e2e: host terminal + browser host tab + ssh guest — URL, auto-admit, admit, draft, queue, gate, kick, /end', { timeout: 180000 }, async (t) => {
  // ── the relay (ssh front door + browser web door), both ephemeral ───────────
  const relay = await startRelay({ port: 0, webPort: 0, host: '127.0.0.1', hostKey: newKey(), hostName: 'ian' });
  t.after(() => relay.close());
  const { port, webPort } = relay;
  assert.ok(webPort, 'the relay opened a browser web door');

  // ── isolate the CLI's filesystem side effects into temp dirs ────────────────
  const workDir = mkdtempSync(join(tmpdir(), 'cs-e2e-work-')); // cwd → session.md lands here
  const homeDir = mkdtempSync(join(tmpdir(), 'cs-e2e-home-')); // HOME → host_key lands here
  const binDir = mkdtempSync(join(tmpdir(), 'cs-e2e-bin-')); // a `claude` shim on PATH
  t.after(() => {
    for (const d of [workDir, homeDir, binDir]) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {}
    }
  });

  // `claude` on PATH → our fake, run by the real node. The CLI only injects hooks
  // when its command is literally "claude", so we shim the name rather than pass a path.
  const shim = join(binDir, 'claude');
  writeFileSync(shim, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(fakeClaude)} "$@"\n`, { mode: 0o755 });

  // ── boot the real host CLI inside a wide PTY ────────────────────────────────
  // Wide so the full room URL paints in the status line before any guest clamps it.
  const host = makeSink();
  let exited = false;
  const exitWaiters = [];
  const cli = ptySpawn(
    process.execPath,
    [cliEntry, '--live', '--relay', `ssh://127.0.0.1:${port}`, '--web-port', String(webPort), '--guests', 'viewer'],
    {
      name: 'xterm-256color',
      cols: 200,
      rows: 50,
      cwd: workDir,
      env: { ...process.env, PATH: `${binDir}:${process.env.PATH}`, HOME: homeDir, USERPROFILE: homeDir, CLAUDE_SHARE_NO_CLIPBOARD: '1' },
    },
  );
  cli.onData((d) => host.feed(d));
  cli.onExit(({ exitCode }) => {
    exited = true;
    exitWaiters.splice(0).forEach((r) => r(exitCode ?? 0));
  });
  const waitExit = (ms = DEFAULT_TIMEOUT) =>
    exited
      ? Promise.resolve()
      : new Promise((res, rej) => {
          const timer = setTimeout(() => rej(new Error('CLI did not exit in time')), ms);
          exitWaiters.push((c) => {
            clearTimeout(timer);
            res(c);
          });
        });
  t.after(() => {
    try {
      if (!exited) cli.kill();
    } catch {}
  });

  // ── the room URL (printed in the status line once connected) ────────────────
  // Cold start is the slow step (spawn node, load node-pty, ssh to the relay, get a
  // room), so give this one wait ample headroom; every later step is sub-second.
  await host.waitFor('room ready', 60000);
  // This CLI runs with CLAUDE_SHARE_NO_CLIPBOARD=1, so nothing was copied — the toast
  // must NOT claim it was (finding 5: only claim the copy when it happened).
  assert.ok(!host.get().includes('copied to clipboard'), 'no false clipboard claim when copy is disabled');
  const m = host.get().match(/http:\/\/127\.0\.0\.1:(\d+)\/([a-z]+-[a-z]+)\?host=([0-9a-f]+)/);
  assert.ok(m, 'the status line carries the host-tab URL with a host token');
  assert.equal(Number(m[1]), webPort, 'the URL points at the web door port');
  const code = m[2];
  const token = m[3];

  // ── the host's own browser tab: auto-admitted as host on the host token ─────
  const hostTab = await connectHostTab(webPort, { code, token });
  t.after(() => hostTab.close());
  await hostTab.onJoined();
  hostTab.resize(120, 40); // the host tab's own xterm size (not a roster participant)
  const s0 = await hostTab.waitForState((s) => s.room === code);
  // The host terminal + the host tab are ONE roster entry (finding 4): the tab does
  // NOT add a second participant. Before any guest, the roster is just the host.
  const hostP = s0.participants.find((p) => p.role === 'host');
  assert.ok(hostP, 'the host is present in the overlay roster');
  // Exactly ONE host entry (the terminal identity); the tab collapses into it and is
  // never a second "host (you)" beside it (finding 4).
  assert.equal(s0.participants.filter((p) => p.role === 'host').length, 1, 'exactly one host entry');
  assert.equal(s0.participants.length, 1, 'the host tab does not add a second participant (findings 3, 4)');

  // ── leaked-link defense: a second browser opening the SAME host link with a
  // different seat secret is refused the host seat (it holds the token but not the
  // bound seat). The real host bound the seat first; the impostor never joins. ──
  const impostor = await connectHostTab(webPort, { code, token, seat: 'stolen-link-seat' });
  t.after(() => impostor.close());
  const refused = await impostor.onError(15000);
  assert.equal(refused.reason, 'denied', 'a mismatched-seat host-link opener is refused host access');
  const sGuard = await hostTab.waitForState((s) => s.room === code);
  assert.equal(sGuard.participants.filter((p) => p.role === 'host').length, 1, 'no second host slipped in via a stolen link');

  // ── guest A: named key, knocks → the host tab admits from the browser ───────
  const a = await connectGuest(port, { code, privateKey: newKey() });
  t.after(() => {
    try {
      a.client.end();
    } catch {}
  });
  await a.waitFor(`room ${code}`); // "connecting to ian's room <code>…"
  await a.waitFor('pick a name');
  a.type('a\r');
  const sKnock = await hostTab.waitForState((s) => s.knocks.some((k) => k.name === 'a'));
  const knock = sKnock.knocks.find((k) => k.name === 'a');
  hostTab.admit(knock.id); // the host admits from the browser, not the terminal
  await a.waitFor('session so far'); // the join context card lands in A's scrollback
  await a.waitFor("── you're live ──");
  const sA = await hostTab.waitForState((s) => s.participants.some((p) => p.name === 'a'));
  // Roster + count reflect DISTINCT humans: the host (tab collapsed in) + guest A = 2,
  // never a phantom (findings 3, 4).
  assert.equal(sA.participants.length, 2, 'roster is host + guest A — the tab is not double-counted');
  const aId = sA.participants.find((p) => p.name === 'a').id;

  // ── the host tab promotes A to prompter (default guest role here is viewer) ─
  hostTab.command('/role @a prompter');
  await hostTab.waitForState((s) => s.participants.find((p) => p.id === aId)?.role === 'prompter');

  // ── A composes a draft that reaches Claude and hits a permission ask ─────────
  // Drafts are created explicitly (Ctrl+N / the + draft chip) — typing alone never
  // starts one.
  a.type('\x0e');
  a.type('make the hero full-bleed [ask]\r');
  await host.waitFor('[claude] prompt: make the hero full-bleed'); // reached the (fake) claude
  await a.waitFor('[claude] prompt: make the hero full-bleed'); // and was mirrored to the guest
  await a.waitFor('[claude] permission needed');
  // The ask arms the gate — the overlay claude-state flips to 'ask' (Notification hook).
  await hostTab.waitForState((s) => s.claudeState === 'ask');

  // ── A sends a second draft while Claude is busy → it QUEUES, attributed ──────
  a.type('\x0e');
  a.type('use tailwind for all of it\r');
  await hostTab.waitForState((s) => s.queue.some((q) => q.text === 'use tailwind for all of it' && q.author === aId));

  // A's window draft now PERSISTS after each send (composing stays on), so to talk to
  // Claude directly A must step OUT of it first — Esc over ssh, a terminal click in the
  // browser. Without this, the `y` below composes into the draft instead of answering.
  a.type('\x1b');

  // ── the gate: a VIEWER's `y` is REJECTED (never reaches Claude) ──────────────
  hostTab.command('/role @a viewer');
  await hostTab.waitForState((s) => s.participants.find((p) => p.id === aId)?.role === 'viewer');
  a.type('y');
  await delay(700); // long enough that a wrongly-forwarded y would have answered the ask
  assert.ok(!host.has('permission granted'), "viewer's y did not answer the permission ask");
  assert.ok(!a.has('permission granted'), 'guest saw no approval from the rejected y');

  // ── back to prompter — prompters answer asks now (the driver tier is gone) ────
  hostTab.command('/role @a prompter');
  await hostTab.waitForState((s) => s.participants.find((p) => p.id === aId)?.role === 'prompter');
  a.type('y');
  await host.waitFor('[claude] permission granted'); // prompter's y reached Claude
  await a.waitFor('[claude] permission granted');
  // …and going idle drains the queue in order (fail-closed drain fired on 'idle').
  await host.waitFor('[claude] prompt: use tailwind for all of it');
  await a.waitFor('[claude] prompt: use tailwind for all of it');

  // ── finding 1: the host token must NEVER reach a guest's mirror ──────────────
  // A has received the status-line band mirrored many times by now (via SCREEN). The
  // host's OWN stdout carries the host-tab URL (with the token); the mirror must carry
  // only the token-free invite URL.
  assert.ok(host.get().includes(`?host=${token}`), 'the host terminal DOES show its own host URL');
  assert.ok(!a.getOut().includes(token), 'the host token never leaks into the ssh guest mirror');
  assert.ok(!a.getOut().includes('?host='), 'no host-token query reaches the guest mirror at all');

  // ── the host tab kicks A ─────────────────────────────────────────────────────
  hostTab.command('/kick @a');
  await a.waitFor('removed'); // A sees the kick copy
  await a.onClose(); // and is disconnected

  // ── the host tab ends the session → session.md is written ────────────────────
  hostTab.command('/end');
  await waitExit();

  // ── the attributed session record ────────────────────────────────────────────
  const md = readFileSync(join(workDir, 'session.md'), 'utf8');
  assert.match(md, /# claude-share session/);
  assert.match(md, /\*\*a\*\*: make the hero full-bleed/); // prompt 1, attributed to A
  assert.match(md, /\*\*a\*\*: use tailwind for all of it/); // prompt 2, attributed to A
  assert.match(md, /set a to prompter/); // role change recorded
  assert.match(md, /set a to viewer/); // role change recorded
  assert.match(md, /a was kicked/); // moderation recorded
  assert.match(md, /src\/app\.js/); // PostToolUse file surfaced in "Files touched"
});

test('e2e: the wrapped Claude gets the live room file (invite only, no host token), gone after exit', { timeout: 120000 }, async (t) => {
  // ── the relay + isolated CLI fs side effects (same boot shape as above) ──────
  const relay = await startRelay({ port: 0, webPort: 0, host: '127.0.0.1', hostKey: newKey(), hostName: 'ian' });
  t.after(() => relay.close());
  const { port, webPort } = relay;

  const workDir = mkdtempSync(join(tmpdir(), 'cs-rf-work-'));
  const homeDir = mkdtempSync(join(tmpdir(), 'cs-rf-home-'));
  const binDir = mkdtempSync(join(tmpdir(), 'cs-rf-bin-'));
  t.after(() => {
    for (const d of [workDir, homeDir, binDir]) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {}
    }
  });
  const shim = join(binDir, 'claude');
  writeFileSync(shim, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(fakeClaude)} "$@"\n`, { mode: 0o755 });

  const host = makeSink();
  let exited = false;
  const exitWaiters = [];
  const cli = ptySpawn(
    process.execPath,
    [cliEntry, '--live', '--relay', `ssh://127.0.0.1:${port}`, '--web-port', String(webPort), '--guests', 'viewer'],
    {
      name: 'xterm-256color',
      cols: 200,
      rows: 50,
      cwd: workDir,
      env: { ...process.env, PATH: `${binDir}:${process.env.PATH}`, HOME: homeDir, USERPROFILE: homeDir, CLAUDE_SHARE_NO_CLIPBOARD: '1' },
    },
  );
  cli.onData((d) => host.feed(d));
  cli.onExit(({ exitCode }) => {
    exited = true;
    exitWaiters.splice(0).forEach((r) => r(exitCode ?? 0));
  });
  const waitExit = (ms = DEFAULT_TIMEOUT) =>
    exited
      ? Promise.resolve()
      : new Promise((res, rej) => {
          const timer = setTimeout(() => rej(new Error('CLI did not exit in time')), ms);
          exitWaiters.push((c) => {
            clearTimeout(timer);
            res(c);
          });
        });
  t.after(() => {
    try {
      if (!exited) cli.kill();
    } catch {}
  });

  // ── the room grant → the room file is written by the wrapper ─────────────────
  await host.waitFor('room ready', 60000);
  const m = host.get().match(/http:\/\/127\.0\.0\.1:(\d+)\/([a-z]+-[a-z]+)\?host=([0-9a-f]+)/);
  assert.ok(m, 'the status line carries the host-tab URL with a host token');
  const code = m[2];
  const token = m[3];

  // The wrapper names the file by ITS pid (os.tmpdir()/claude-share-room-<pid>.json);
  // the child reads it via CLAUDE_SHARE_ROOM_FILE. Poll until it appears (the write is
  // synchronous inside onRoom, but give the paint→sink hop a moment either way).
  const roomFile = join(tmpdir(), `claude-share-room-${cli.pid}.json`);
  for (let i = 0; i < 100 && !existsSync(roomFile); i++) await delay(50);
  assert.ok(existsSync(roomFile), 'the room file exists while the room is live');

  const raw = readFileSync(roomFile, 'utf8');
  const info = JSON.parse(raw);
  assert.equal(info.room, code, 'the room file carries the room code');
  assert.ok(info.inviteUrl && info.inviteUrl.includes(code), 'the room file carries the invite URL');
  // HARD RULE: the token-bearing host URL must NEVER reach the child-readable file.
  assert.ok(!raw.includes('host='), 'no host= query reaches the room file');
  assert.ok(!raw.includes(token), 'the host token never reaches the room file');
  assert.ok(!('hostUrl' in info) && !('token' in info), 'only whitelisted fields are present');

  // ── end the host (SIGTERM) → the file is removed ─────────────────────────────
  cli.kill('SIGTERM');
  await waitExit();
  assert.ok(!existsSync(roomFile), 'the room file is gone once the session ends');
});

test('e2e: lazy start — no --live dials no relay, creates no room, paints no band; --live restores it', { timeout: 120000 }, async (t) => {
  // The status-line color: NOTHING but the band ever emits it, so its presence in the
  // host's stdout is a precise "the band painted" signal (renderer.js ORANGE).
  const ORANGE = '\x1b[38;5;214m';

  const relay = await startRelay({ port: 0, webPort: 0, host: '127.0.0.1', hostKey: newKey(), hostName: 'ian' });
  t.after(() => relay.close());
  const { port, webPort } = relay;

  // Isolate the CLI's filesystem side effects (same shape as the other e2e tests).
  const workDir = mkdtempSync(join(tmpdir(), 'cs-lazy-work-'));
  const homeDir = mkdtempSync(join(tmpdir(), 'cs-lazy-home-'));
  const binDir = mkdtempSync(join(tmpdir(), 'cs-lazy-bin-'));
  t.after(() => {
    for (const d of [workDir, homeDir, binDir]) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {}
    }
  });
  const shim = join(binDir, 'claude');
  writeFileSync(shim, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(fakeClaude)} "$@"\n`, { mode: 0o755 });
  const childEnv = { ...process.env, PATH: `${binDir}:${process.env.PATH}`, HOME: homeDir, USERPROFILE: homeDir, CLAUDE_SHARE_NO_CLIPBOARD: '1' };

  const bootHost = (extraArgs) => {
    const sink = makeSink();
    const cli = ptySpawn(
      process.execPath,
      [cliEntry, ...extraArgs, '--relay', `ssh://127.0.0.1:${port}`, '--web-port', String(webPort), '--guests', 'viewer'],
      { name: 'xterm-256color', cols: 200, rows: 50, cwd: workDir, env: childEnv },
    );
    cli.onData((d) => sink.feed(d));
    t.after(() => {
      try {
        cli.kill();
      } catch {}
    });
    return { cli, sink };
  };

  // ── lazy host: NO --live → pixel-identical to plain claude ──────────────────
  const lazy = bootHost([]); // default = lazy
  await lazy.sink.waitFor('fake-claude ready', 60000); // the wrapped child booted and painted
  await delay(1500); // ample time to have dialed the relay + created a room, had it been eager
  assert.equal(relay.roomCount(), 0, 'a lazy host dials no relay and creates no room');
  assert.ok(!lazy.sink.get().includes(ORANGE), 'pre-live paints ZERO band rows (no status line)');
  assert.ok(!lazy.sink.get().includes('room ready'), 'pre-live never announces a room');

  // ── --live host on the SAME relay → the old room-at-startup behavior ────────
  const live = bootHost(['--live']);
  await live.sink.waitFor('room ready', 60000); // dialed, got a room, painted the ready toast
  assert.ok(relay.roomCount() >= 1, '--live creates a room at startup');
  assert.ok(live.sink.get().includes(ORANGE), '--live paints the status band');
  // The lazy host STILL has no room and no band — going live is per-process.
  assert.ok(!lazy.sink.get().includes(ORANGE), 'the lazy host stays band-free while another host goes live');
});

// One control-socket request → its single reply line, parsed. Exactly what the
// wrapped Claude's `collab go` does (a net client speaking JSON-lines).
function ctlAsk(sockPath, req, ms = 20000) {
  return new Promise((resolve, reject) => {
    const conn = netConnect(sockPath, () => conn.write(JSON.stringify(req) + '\n'));
    let buf = '';
    const timer = setTimeout(() => {
      conn.destroy();
      reject(new Error('ctl: no reply'));
    }, ms);
    conn.on('data', (d) => {
      buf += d.toString('utf8');
      const nl = buf.indexOf('\n');
      if (nl !== -1) {
        clearTimeout(timer);
        conn.end();
        try {
          resolve(JSON.parse(buf.slice(0, nl)));
        } catch (err) {
          reject(err);
        }
      }
    });
    conn.on('error', reject);
  });
}

test('e2e: control socket — go creates the room (invite only, no token), status reports live, off closes it', { timeout: 120000 }, async (t) => {
  const ORANGE = '\x1b[38;5;214m'; // the band's status-line color — nothing else emits it

  let relay = await startRelay({ port: 0, webPort: 0, host: '127.0.0.1', hostKey: newKey(), hostName: 'ian' });
  t.after(() => relay.close()); // closure reads the variable — always closes the CURRENT instance
  const { port, webPort } = relay;

  const workDir = mkdtempSync(join(tmpdir(), 'cs-ctl-work-'));
  const homeDir = mkdtempSync(join(tmpdir(), 'cs-ctl-home-'));
  const binDir = mkdtempSync(join(tmpdir(), 'cs-ctl-bin-'));
  t.after(() => {
    for (const d of [workDir, homeDir, binDir]) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {}
    }
  });
  const shim = join(binDir, 'claude');
  writeFileSync(shim, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(fakeClaude)} "$@"\n`, { mode: 0o755 });

  // A LAZY host (no --live): the socket, not startup, is what takes it live.
  const host = makeSink();
  const cli = ptySpawn(
    process.execPath,
    [cliEntry, '--relay', `ssh://127.0.0.1:${port}`, '--web-port', String(webPort), '--guests', 'viewer'],
    {
      name: 'xterm-256color',
      cols: 200,
      rows: 50,
      cwd: workDir,
      env: { ...process.env, PATH: `${binDir}:${process.env.PATH}`, HOME: homeDir, USERPROFILE: homeDir, CLAUDE_SHARE_NO_CLIPBOARD: '1' },
    },
  );
  cli.onData((d) => host.feed(d));
  t.after(() => {
    try {
      cli.kill();
    } catch {}
  });

  await host.waitFor('fake-claude ready', 60000);
  assert.equal(relay.roomCount(), 0, 'lazy: nothing dialed yet');

  const sock = join(tmpdir(), `claude-share-ctl-${cli.pid}.sock`);
  for (let i = 0; i < 100 && !existsSync(sock); i++) await delay(50);
  assert.ok(existsSync(sock), 'the control socket exists (CLAUDE_SHARE_CTL)');
  assert.equal(statSync(sock).mode & 0o777, 0o600, 'the control socket is same-user only (0600)');

  // status BEFORE go → not live.
  const before = await ctlAsk(sock, { v: 1, t: 'status' });
  assert.deepEqual(before, { ok: true, live: false }, 'status pre-go: not live, no room/url fields');

  // a wrong protocol version is refused.
  const badV = await ctlAsk(sock, { v: 2, t: 'status' });
  assert.deepEqual(badV, { ok: false, error: 'version' }, 'the socket version-gates every request');

  // go → the room is created; the reply carries room + inviteUrl and NEVER the token.
  const go = await ctlAsk(sock, { v: 1, t: 'go' });
  assert.equal(go.ok, true, `go succeeded (${JSON.stringify(go)})`);
  assert.ok(go.room, 'go reply carries the room code');
  assert.ok(go.inviteUrl && go.inviteUrl.includes(go.room), 'go reply carries the invite URL');
  assert.ok(!go.inviteUrl.includes('host='), 'the invite URL has no host token');

  // the band appeared once live, and it shows the host URL (with the token) on the
  // host TERMINAL only — grab that token to prove it never crossed the socket.
  await host.waitFor(ORANGE, 15000);
  await host.waitFor('?host=', 15000);
  const token = host.get().match(/\?host=([0-9a-f]+)/)[1];
  assert.ok(!JSON.stringify(go).includes(token), 'the host token never crosses the control socket');

  // the room file was written with the same invite-only shape.
  const roomFile = join(tmpdir(), `claude-share-room-${cli.pid}.json`);
  for (let i = 0; i < 100 && !existsSync(roomFile); i++) await delay(50);
  assert.ok(existsSync(roomFile), 'the room file exists while live');
  const rf = readFileSync(roomFile, 'utf8');
  assert.ok(!rf.includes('host=') && !rf.includes(token), 'the room file never carries the token');

  // go again → idempotent (same room, no second dial).
  const goAgain = await ctlAsk(sock, { v: 1, t: 'go' });
  assert.equal(goAgain.room, go.room, 'go is idempotent while live');
  assert.equal(relay.roomCount(), 1, 'no second room was created');

  // status while live.
  const live = await ctlAsk(sock, { v: 1, t: 'status' });
  assert.equal(live.ok, true);
  assert.equal(live.live, true, 'status: live');
  assert.equal(live.room, go.room, 'status carries the room');
  assert.ok(!live.inviteUrl.includes('host='), 'status invite URL has no token');

  // off → the room closes, the file is removed, and the relay drops the room.
  const off = await ctlAsk(sock, { v: 1, t: 'off' });
  assert.deepEqual(off, { ok: true }, 'off acknowledges');
  for (let i = 0; i < 100 && existsSync(roomFile); i++) await delay(50);
  assert.ok(!existsSync(roomFile), 'the room file is gone after off');
  for (let i = 0; i < 100 && relay.roomCount() !== 0; i++) await delay(50);
  assert.equal(relay.roomCount(), 0, 'off closes the room on the relay');

  // a guest connecting to the now-dead code is told there is no such room.
  const late = await connectGuest(port, { code: go.room, privateKey: newKey() });
  t.after(() => {
    try {
      late.client.end();
    } catch {}
  });
  await late.waitFor('no room', 15000);

  // status after off → not live again.
  const after = await ctlAsk(sock, { v: 1, t: 'status' });
  assert.deepEqual(after, { ok: true, live: false }, 'status post-off: back to not live');

  // ── regression: go works AGAIN after off (fresh dial, fresh room, no ghosts) ──
  const go2 = await ctlAsk(sock, { v: 1, t: 'go' });
  assert.equal(go2.ok, true, `re-go after off succeeded (${JSON.stringify(go2)})`);
  assert.ok(go2.room, 're-go grants a room');
  assert.equal(relay.roomCount(), 1, 'exactly one room after the off→go cycle');

  // ── regression: off during a reconnect window must NOT resurrect the room ──────
  // Kill the relay while live → the host loops reconnect attempts → off lands in
  // that window → restart the relay → nothing may dial back in (the old bug: the
  // still-armed reconnect timer re-HELLOed a brand-new INVISIBLE room, band hidden).
  relay.close();
  await host.waitFor('reconnecting to reclaim', 20000);
  const offMidReconnect = await ctlAsk(sock, { v: 1, t: 'off' });
  assert.deepEqual(offMidReconnect, { ok: true }, 'off acknowledges mid-reconnect');
  relay = await startRelay({ port, webPort: 0, host: '127.0.0.1', hostKey: newKey() });
  await delay(3500); // longer than the 1500ms reconnect backoff — any live timer would have fired
  assert.equal(relay.roomCount(), 0, 'no invisible room was resurrected after off');
  const silent = await ctlAsk(sock, { v: 1, t: 'status' });
  assert.deepEqual(silent, { ok: true, live: false }, 'status confirms: still not live');
  const roomFileGone = !existsSync(join(tmpdir(), `claude-share-room-${cli.pid}.json`));
  assert.ok(roomFileGone, 'the room file stayed gone');
});
