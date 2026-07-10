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
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
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
function connectHostTab(webPort, { code, token }) {
  const states = [];
  const waiters = [];
  const joinWaiters = [];
  let selfId = null;
  let joined = false;

  const ws = new WebSocket(`ws://127.0.0.1:${webPort}/ws?room=${code}&host=${token}`);

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
