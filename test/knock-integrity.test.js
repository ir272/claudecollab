// Finding 3 — knock/admit integrity, proved against the real host CLI + relay + web
// door with real `ws` guests:
//
//   • reconnect-during-knock yields ONE pending knock: a second WS from the SAME token
//     (fingerprint) re-knocks with a new connection id; the host dedups it to a single
//     card (the newest) and denies the stale connection — no double card, no phantom.
//   • no admit → no screen: a knocking guest the host never admits receives NO 'joined'
//     signal and ZERO screen bytes, even while the host actively paints. Admission is
//     ONLY by an explicit ui action (or the host token).

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
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

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
    feed: (s) => {
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

function connectHostTab(webPort, { code, token }) {
  const states = [];
  const waiters = [];
  let joined = false;
  const joinWaiters = [];
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
      joined = true;
      joinWaiters.splice(0).forEach((r) => r());
    } else if (msg.t === 'state') pushState(msg.data);
  });
  const send = (obj) => ws.send(JSON.stringify(obj));
  const api = {
    ws,
    onJoined: () => (joined ? Promise.resolve() : new Promise((res) => joinWaiters.push(res))),
    admit: (id) => send({ t: 'ui', action: { kind: 'admit', id } }),
    command: (text) => send({ t: 'ui', action: { kind: 'command', text } }),
    resize: (cols, rows) => send({ t: 'resize', cols, rows }),
    latest: () => states[states.length - 1] ?? null,
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

// A web guest that tracks: 'joined', binary-frame count, and close.
function connectWebGuest(webPort, { code, name, token }) {
  const ws = new WebSocket(`ws://127.0.0.1:${webPort}/ws?room=${code}&name=${encodeURIComponent(name)}&token=${token}`);
  let joined = false;
  let closed = false;
  let binCount = 0;
  const joinWaiters = [];
  const closeWaiters = [];
  ws.on('message', (buf, isBinary) => {
    if (isBinary) {
      binCount++;
      return;
    }
    let msg;
    try {
      msg = JSON.parse(buf.toString('utf8'));
    } catch {
      return;
    }
    if (msg.t === 'joined') {
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
    get joined() {
      return joined;
    },
    get binCount() {
      return binCount;
    },
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

function bootHost(t) {
  return (async () => {
    const relay = await startRelay({ port: 0, webPort: 0, host: '127.0.0.1', hostKey: newKey(), hostName: 'ian' });
    t.after(() => relay.close());
    const { port, webPort } = relay;
    const workDir = mkdtempSync(join(tmpdir(), 'cs-knk-work-'));
    const homeDir = mkdtempSync(join(tmpdir(), 'cs-knk-home-'));
    const binDir = mkdtempSync(join(tmpdir(), 'cs-knk-bin-'));
    t.after(() => {
      for (const d of [workDir, homeDir, binDir]) {
        try {
          rmSync(d, { recursive: true, force: true });
        } catch {}
      }
    });
    writeFileSync(join(binDir, 'claude'), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(fakeClaude)} "$@"\n`, { mode: 0o755 });
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
    assert.ok(m, 'host-tab room URL printed');
    return { host, webPort, code: m[2], token: m[3] };
  })();
}

test('a WS reconnect during the join flow yields ONE pending knock, not two (finding 3)', { timeout: 180000 }, async (t) => {
  const { webPort, code, token } = await bootHost(t);
  const hostTab = await connectHostTab(webPort, { code, token });
  t.after(() => hostTab.close());
  await hostTab.onJoined();
  await hostTab.waitForState((s) => s.room === code);

  // First knock from token tok-sid.
  const g1 = await connectWebGuest(webPort, { code, name: 'sid', token: 'tok-sid' });
  t.after(() => g1.close());
  const s1 = await hostTab.waitForState((s) => s.knocks.some((k) => k.fp === 'web:tok-sid'));
  const k1 = s1.knocks.find((k) => k.fp === 'web:tok-sid');

  // The SAME token re-knocks on a NEW connection (a reconnect mid-join) WITHOUT closing
  // the first — the classic double-card race.
  const g2 = await connectWebGuest(webPort, { code, name: 'sid', token: 'tok-sid' });
  t.after(() => g2.close());
  const s2 = await hostTab.waitForState((s) => s.knocks.some((k) => k.fp === 'web:tok-sid' && k.id !== k1.id));

  // Exactly ONE pending knock for that fingerprint — the newest — and the stale
  // connection is denied (closed).
  const forFp = s2.knocks.filter((k) => k.fp === 'web:tok-sid');
  assert.equal(forFp.length, 1, 'exactly one pending knock for the reconnecting fingerprint');
  assert.notEqual(forFp[0].id, k1.id, 'the newest knock replaced the stale one');
  await g1.onClose(); // the superseded connection was denied and dropped

  // Neither guest was admitted (no explicit ui admit happened).
  assert.equal(g2.joined, false, 'the re-knock is still pending, never auto-admitted');
  assert.equal(g2.binCount, 0, 'a pending guest receives no screen bytes');
});

test('a knock the host never admits gets NO screen bytes, even while the host paints (finding 3)', { timeout: 180000 }, async (t) => {
  const { host, webPort, code, token } = await bootHost(t);
  const hostTab = await connectHostTab(webPort, { code, token });
  t.after(() => hostTab.close());
  await hostTab.onJoined();
  await hostTab.waitForState((s) => s.room === code);

  // A guest knocks; the host tab NEVER admits it.
  const g = await connectWebGuest(webPort, { code, name: 'mallory', token: 'tok-m' });
  t.after(() => g.close());
  await hostTab.waitForState((s) => s.knocks.some((k) => k.name === 'mallory'));

  // The host actively paints (a prompt reaches Claude and is mirrored to LIVE guests).
  hostTab.command('SECRET_SCREEN_CONTENT');
  await host.waitFor('[claude] prompt: SECRET_SCREEN_CONTENT');
  await delay(700); // give any wrongly-delivered frame time to arrive

  assert.equal(g.joined, false, 'the un-admitted guest never received a joined signal');
  assert.equal(g.binCount, 0, 'the un-admitted guest never received a single screen byte');
});

test('an admitted guest reloads straight back in; a kicked one stays out', { timeout: 180000 }, async (t) => {
  const { webPort, code, token } = await bootHost(t);
  const hostTab = await connectHostTab(webPort, { code, token });
  t.after(() => hostTab.close());
  await hostTab.onJoined();
  await hostTab.waitForState((s) => s.room === code);

  const waitJoined = async (g, what, ms = 10000) => {
    const t0 = Date.now();
    while (!g.joined) {
      if (Date.now() - t0 > ms) throw new Error(`${what}: never joined`);
      await delay(100);
    }
  };

  // First visit: the normal knock → explicit admit.
  const g1 = await connectWebGuest(webPort, { code, name: 'rex', token: 'tok-rex' });
  t.after(() => g1.close());
  const s1 = await hostTab.waitForState((s) => s.knocks.some((k) => k.fp === 'web:tok-rex'));
  hostTab.admit(s1.knocks.find((k) => k.fp === 'web:tok-rex').id);
  await waitJoined(g1, 'first visit');

  // Reload: the same browser token reconnects — NO second admit, straight in.
  g1.close();
  await g1.onClose();
  const g2 = await connectWebGuest(webPort, { code, name: 'rex', token: 'tok-rex' });
  t.after(() => g2.close());
  await waitJoined(g2, 'reload (auto-readmit)');
  const sNow = hostTab.latest();
  assert.ok(!sNow.knocks?.some((k) => k.fp === 'web:tok-rex'), 'the reload never parked as a pending knock');

  // Kick: the live web guest gets a machine-readable reason (the removed panel),
  // then the connection closes.
  const reasons = [];
  g2.ws.on('message', (buf, isBinary) => {
    if (isBinary) return;
    try {
      const m = JSON.parse(buf.toString('utf8'));
      if (m.t === 'error') reasons.push(m.reason);
    } catch {}
  });
  hostTab.command('/kick @rex');
  await g2.onClose();
  assert.deepEqual(reasons, ['kicked'], 'the kicked web guest was told WHY before the close');

  // The kicked token cannot ride auto-readmit back in (the kick banned the fp).
  const g3 = await connectWebGuest(webPort, { code, name: 'rex', token: 'tok-rex' });
  t.after(() => g3.close());
  await g3.onClose();
  assert.equal(g3.joined, false, 'a kicked fingerprint never auto-readmits');
});
