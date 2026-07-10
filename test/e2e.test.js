// End-to-end smoke test (Task 8) — the whole system on localhost, real processes:
//
//   • the relay ssh server (packages/relay), in-process on an ephemeral port;
//   • the real host CLI (packages/cli/bin/claude-share.js), spawned inside a PTY
//     so its band actually paints and raw-mode stdin works — driving a fake-claude
//     stub (test/fixtures/fake-claude.cjs) that echoes prompts and fires the
//     injected lifecycle hooks, so state detection is real, not mocked;
//   • two scripted ssh guests, exactly as a stock `ssh` client would connect.
//
// The fake-claude is resolved as `claude` on the CLI child's PATH (the CLI only
// injects hooks when its command is literally "claude"), so the full hook path is
// exercised end to end. Scenario (spec §testing approach, plan Task 8):
//
//   host boots → guest A knocks (named key), admitted, promoted to prompter →
//   A composes a draft + Enter → the prompt reaches Claude → guest B knocks
//   keyless (viewer, via --guests viewer) → A sends a second draft while Claude is
//   mid-ask, so it QUEUES, attributed → a permission ask arms the gate → A's `y`
//   as a prompter is REJECTED → host promotes A to driver → A's `y` is ACCEPTED
//   and the queue drains → host kicks B → /end writes session.md → assert the
//   shared transcript, the attributed queue, the gate decisions, and session.md.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import ssh2 from 'ssh2';
import * as ptyNs from 'node-pty';
import { startRelay } from '../packages/relay/server.js';

const ptySpawn = ptyNs.spawn ?? ptyNs.default?.spawn;
const { Client, utils } = ssh2;
const { generateKeyPairSync, parseKey } = utils;

// ssh2's generateKeyPairSync occasionally emits a key its own parser rejects
// ("Malformed OpenSSH private key"). Validate with parseKey and regenerate so a
// known upstream flake can't destabilize this end-to-end test.
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

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

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

test('e2e: host + 2 guests through a local relay — join, draft, queue, gate, kick, /end', { timeout: 90000 }, async (t) => {
  // ── the relay (the "brainless" front door) ─────────────────────────────────
  const relay = await startRelay({ port: 0, host: '127.0.0.1', hostKey: newKey(), hostName: 'ian' });
  t.after(() => relay.close());
  const port = relay.port;

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

  // ── boot the real host CLI inside a PTY ─────────────────────────────────────
  const host = makeSink();
  let exited = false;
  const exitWaiters = [];
  const cli = ptySpawn(
    process.execPath,
    [cliEntry, '--relay', `ssh://127.0.0.1:${port}`, '--guests', 'viewer', '--band-rows', '8'],
    {
      name: 'xterm-256color',
      cols: 100,
      rows: 30,
      cwd: workDir,
      env: { ...process.env, PATH: `${binDir}:${process.env.PATH}`, HOME: homeDir, USERPROFILE: homeDir },
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

  // ── room code (from the invite toast the CLI paints once connected) ─────────
  await host.waitFor('room ready · invite: ssh ');
  const m = host.get().match(/ssh ([a-z]+-[a-z]+)@127\.0\.0\.1/);
  assert.ok(m, 'invite line carries an adjective-animal room code');
  const code = m[1];

  // ── guest A: named key, knock → admit ───────────────────────────────────────
  const a = await connectGuest(port, { code, privateKey: newKey() });
  t.after(() => {
    try {
      a.client.end();
    } catch {}
  });
  await a.waitFor(`room ${code}`); // "connecting to ian's room <code>…"
  await a.waitFor('pick a name');
  a.type('a\r');
  await host.waitFor('"a" knocking'); // knock renders in the band
  cli.write('y'); // host admits
  await host.waitFor('a joined');
  await a.waitFor('session so far'); // the join context card lands in A's scrollback
  await a.waitFor("── you're live ──");

  // Promote A to prompter so A can compose (spec default here is viewer via --guests).
  cli.write('/role @a prompter\r');
  await host.waitFor('set a to prompter');

  // ── guest B: keyless (viewer default) ───────────────────────────────────────
  const b = await connectGuest(port, { code, keyboard: true });
  t.after(() => {
    try {
      b.client.end();
    } catch {}
  });
  await b.waitFor('pick a name');
  b.type('b\r');
  await host.waitFor('"b" knocking');
  cli.write('y');
  await host.waitFor('b joined');

  // ── A composes a draft and sends it; the prompt reaches Claude ───────────────
  a.type('make the hero full-bleed [ask]\r');
  await host.waitFor('[claude] prompt: make the hero full-bleed'); // reached the (fake) claude
  await a.waitFor('[claude] prompt: make the hero full-bleed'); // and was mirrored to the guest
  await host.waitFor('[claude] permission needed'); // claude hit a tool that needs permission

  // The permission ask arms the gate — proven by the band status flipping (the
  // 'ask' state is set by the Notification hook, which also arms y/n).
  await host.waitFor('⚠ permission ask pending');

  // ── A sends a second draft while Claude is busy → it QUEUES, attributed ──────
  a.type('use tailwind for all of it\r');
  await host.waitFor('queue (1)');
  await host.waitFor('a → use tailwind for all of it'); // attributed to A in the host band
  // The band is part of the ONE live screen: the attributed queue is mirrored to
  // the guest too. Nothing has SENT this text to (fake) Claude yet — it's still
  // queued — so the only way the guest can have it is the mirrored band.
  await a.waitFor('a → use tailwind for all of it');

  // ── the gate: a prompter's `y` is REJECTED (never reaches Claude) ────────────
  a.type('y');
  await delay(600); // long enough that a wrongly-forwarded y would have answered the ask
  assert.ok(!host.has('permission granted'), "prompter's y did not answer the permission ask");
  assert.ok(!a.has('permission granted'), 'guest saw no approval from the rejected y');

  // ── host promotes A to driver; now A's `y` is ACCEPTED ───────────────────────
  cli.write('/role @a driver\r');
  await host.waitFor('set a to driver');
  a.type('y');
  await host.waitFor('[claude] permission granted'); // driver's y reached Claude
  await a.waitFor('[claude] permission granted');
  // …and going idle drains the queue in order (fail-closed drain fired on 'idle').
  await host.waitFor('[claude] prompt: use tailwind for all of it');
  await a.waitFor('[claude] prompt: use tailwind for all of it');

  // ── /recap posts the summary to the SHARED screen (guests + host read it) ─────
  // A's earlier rejected prompter-`y` is still sitting in A's draft (spec: a blocked
  // y/n is "just typing"); clear the line (ctrl+u) so /recap composes cleanly.
  a.type('\x15');
  a.type('/recap\r'); // A is a driver now; /recap is prompter+
  await host.waitFor('session recap'); // the full prose reaches the host
  await a.waitFor('session recap'); // …and is mirrored to the guest, not host-only

  // ── guest A self-detaches (Ctrl+C): the host frees the seat, no ghost lingers ─
  a.type('\x03');
  await host.waitFor('a left'); // the same cleanup path as a natural leave fires
  await a.onClose(); // and A's connection is dropped

  // ── host kicks B ─────────────────────────────────────────────────────────────
  cli.write('/kick @b\r');
  await host.waitFor('b was kicked');
  await b.waitFor('removed'); // B sees the kick copy
  await b.onClose(); // and is disconnected

  // ── /end: two confirmations, save session.md ────────────────────────────────
  cli.write('/end\r');
  await host.waitFor('end session? everyone will be disconnected');
  cli.write('y');
  await host.waitFor('save a session summary to session.md?');
  cli.write('y');
  await waitExit();

  // ── the attributed session record ────────────────────────────────────────────
  const md = readFileSync(join(workDir, 'session.md'), 'utf8');
  assert.match(md, /# claude-share session/);
  assert.match(md, /\*\*a\*\*: make the hero full-bleed/); // prompt 1, attributed to A
  assert.match(md, /\*\*a\*\*: use tailwind for all of it/); // prompt 2, attributed to A
  assert.match(md, /set a to prompter/); // role change recorded
  assert.match(md, /set a to driver/); // role change recorded
  assert.match(md, /a left/); // self-detach freed A's seat (no ghost participant)
  assert.match(md, /b joined/); // B's join recorded
  assert.match(md, /b was kicked/); // moderation recorded
  assert.match(md, /src\/app\.js/); // PostToolUse file surfaced in "Files touched"
});
