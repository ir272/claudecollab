// Finding 4 — the host tab's roster actions must target a participant by ID, not by
// claimed display name. Names are guest-claimed and non-unique, and resolveMention
// returns the FIRST case-insensitive match, so a name-based /role or /kick could hit
// the wrong person. This drives the REAL host CLI (the brain) with two web guests that
// claim the SAME name and proves that an id-carrying {t:'ui'} role/kick action always
// hits the intended one:
//
//   two guests both named "sam" join → the host tab promotes the SECOND to driver by id
//   (the first stays prompter — a first-match name resolver could never do this) → the
//   host tab kicks the SECOND by id (the first survives) → assert via the overlay state.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import ssh2 from 'ssh2';
import * as ptyNs from 'node-pty';
import { WebSocket } from 'ws';
import { startRelay } from '../packages/relay/server.js';

const ptySpawn = ptyNs.spawn ?? ptyNs.default?.spawn;
const { utils } = ssh2;
const { generateKeyPairSync, parseKey } = utils;

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
    waitFor(sub, ms = DEFAULT_TIMEOUT) {
      if (out.includes(sub)) return Promise.resolve(out);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timed out waiting for ${JSON.stringify(sub)}`)), ms);
        waiters.push({ sub, resolve, timer });
      });
    },
  };
}

// The host's browser tab (host token → auto-admitted host). Sends the exact {t:'ui'}
// messages the real client sends, including the id-carrying roster actions.
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
    if (isBinary) return;
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
    } else if (msg.t === 'state') pushState(msg.data);
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
    roleById: (id, role) => send({ t: 'ui', action: { kind: 'role', id, role } }),
    kickById: (id) => send({ t: 'ui', action: { kind: 'kick', id } }),
    resize: (cols, rows) => send({ t: 'resize', cols, rows }),
    waitForState(pred, ms = DEFAULT_TIMEOUT) {
      const found = [...states].reverse().find(pred);
      if (found) return Promise.resolve(found);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('host tab: timed out waiting for a state frame')), ms);
        waiters.push({ pred, resolve, timer });
      });
    },
    close() {
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

// A web guest: knocks by name+token, goes live on 'joined', tracks close (kick).
function connectWebGuest(webPort, { code, name, token }) {
  const ws = new WebSocket(`ws://127.0.0.1:${webPort}/ws?room=${code}&name=${encodeURIComponent(name)}&token=${token}`);
  let selfId = null;
  let joined = false;
  let closed = false;
  const joinWaiters = [];
  const closeWaiters = [];
  ws.on('message', (buf, isBinary) => {
    if (isBinary) return;
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
    }
  });
  ws.on('close', () => {
    closed = true;
    closeWaiters.splice(0).forEach((r) => r());
  });
  ws.on('error', () => {});
  const api = {
    ws,
    get selfId() {
      return selfId;
    },
    onJoined: (ms = DEFAULT_TIMEOUT) =>
      joined
        ? Promise.resolve()
        : new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error(`guest ${name}: never joined`)), ms);
            joinWaiters.push(() => {
              clearTimeout(timer);
              resolve();
            });
          }),
    onClose: (ms = DEFAULT_TIMEOUT) =>
      closed
        ? Promise.resolve()
        : new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error(`guest ${name}: never closed`)), ms);
            closeWaiters.push(() => {
              clearTimeout(timer);
              resolve();
            });
          }),
    close() {
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

test('roster role/kick target a duplicate-named guest by id, not by @-mention (finding 4)', { timeout: 180000 }, async (t) => {
  const relay = await startRelay({ port: 0, webPort: 0, host: '127.0.0.1', hostKey: newKey(), hostName: 'ian' });
  t.after(() => relay.close());
  const { port, webPort } = relay;

  const workDir = mkdtempSync(join(tmpdir(), 'cs-rid-work-'));
  const homeDir = mkdtempSync(join(tmpdir(), 'cs-rid-home-'));
  const binDir = mkdtempSync(join(tmpdir(), 'cs-rid-bin-'));
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
  const cli = ptySpawn(
    process.execPath,
    [cliEntry, '--relay', `ssh://127.0.0.1:${port}`, '--web-port', String(webPort), '--guests', 'prompter'],
    {
      name: 'xterm-256color',
      cols: 200,
      rows: 50,
      cwd: workDir,
      env: { ...process.env, PATH: `${binDir}:${process.env.PATH}`, HOME: homeDir, USERPROFILE: homeDir, CLAUDE_SHARE_NO_CLIPBOARD: '1' },
    },
  );
  cli.onData((d) => host.feed(d));
  cli.onExit(() => (exited = true));
  t.after(() => {
    try {
      if (!exited) cli.kill();
    } catch {}
  });

  await host.waitFor('room ready', 60000);
  const m = host.get().match(/http:\/\/127\.0\.0\.1:(\d+)\/([a-z]+-[a-z]+)\?host=([0-9a-f]+)/);
  assert.ok(m, 'the status line carries the host-tab room URL');
  const code = m[2];
  const token = m[3];

  const hostTab = await connectHostTab(webPort, { code, token });
  t.after(() => hostTab.close());
  await hostTab.onJoined();
  hostTab.resize(120, 40);
  await hostTab.waitForState((s) => s.room === code);

  // ── guest sam1 knocks → host admits ─────────────────────────────────────────
  const sam1 = await connectWebGuest(webPort, { code, name: 'sam', token: 'tok-1' });
  t.after(() => sam1.close());
  const k1 = (await hostTab.waitForState((s) => s.knocks.length >= 1)).knocks[0];
  hostTab.admit(k1.id);
  await sam1.onJoined();
  const sam1Id = sam1.selfId;

  // ── guest sam2 knocks (SAME name) → host admits the new knock ────────────────
  const sam2 = await connectWebGuest(webPort, { code, name: 'sam', token: 'tok-2' });
  t.after(() => sam2.close());
  const k2 = (await hostTab.waitForState((s) => s.knocks.some((k) => k.id !== k1.id))).knocks.find((k) => k.id !== k1.id);
  hostTab.admit(k2.id);
  await sam2.onJoined();
  const sam2Id = sam2.selfId;

  assert.notEqual(sam1Id, sam2Id, 'two guests, same name, distinct ids');
  await hostTab.waitForState((s) => s.participants.some((p) => p.id === sam1Id) && s.participants.some((p) => p.id === sam2Id));

  // ── promote the SECOND sam to driver BY ID — the first must stay prompter ─────
  // (a first-match @-mention resolver could only ever promote sam1; getting sam2 the
  // driver role while sam1 stays prompter proves the action targeted the id.)
  hostTab.roleById(sam2Id, 'driver');
  const roled = await hostTab.waitForState((s) => s.participants.find((p) => p.id === sam2Id)?.role === 'driver');
  assert.equal(roled.participants.find((p) => p.id === sam1Id).role, 'prompter', 'the OTHER sam is untouched');

  // ── kick the SECOND sam BY ID — the first survives ───────────────────────────
  hostTab.kickById(sam2Id);
  await sam2.onClose(); // the right socket dropped
  const after = await hostTab.waitForState((s) => !s.participants.some((p) => p.id === sam2Id));
  assert.ok(after.participants.some((p) => p.id === sam1Id), 'the first sam is still in the room');
  assert.equal(sam1.ws.readyState, WebSocket.OPEN, 'the first sam was never disconnected');
});
