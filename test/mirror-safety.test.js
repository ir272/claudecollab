// Findings 1 & 2 — the mirror the host broadcasts must be SAFE and CLEAN, proved end
// to end against the real host CLI, the real relay + web door, and a real `ws` guest:
//
//   • finding 1 (security): the host token appears ONLY on the host's own terminal
//     (in its host-tab URL). It must NEVER reach a guest's mirror — the mirrored status
//     line carries the token-free invite URL instead.
//   • finding 2 (garble): a guest admitted MID-SESSION, after distinctive content was
//     painted, receives exactly ONE clean copy of that content (from the snapshot),
//     ordered BEFORE any live frame painted after they joined.
//
// The guest here is a browser (web door): screen bytes arrive as BINARY frames, so we
// concatenate them and assert over the byte stream the guest's xterm would render.

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

// The host's browser tab (host token → auto-admitted host). Sends the same {t:'ui'}
// messages the real client sends.
function connectHostTab(webPort, { code, token }) {
  const states = [];
  const waiters = [];
  let selfId = null;
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
    onJoined: () =>
      joined ? Promise.resolve() : new Promise((res) => joinWaiters.push(res)),
    admit: (id) => send({ t: 'ui', action: { kind: 'admit', id } }),
    command: (text) => send({ t: 'ui', action: { kind: 'command', text } }),
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

// A web guest that CAPTURES the binary screen stream (what its xterm would render).
function connectWebGuest(webPort, { code, name, token }) {
  const ws = new WebSocket(`ws://127.0.0.1:${webPort}/ws?room=${code}&name=${encodeURIComponent(name)}&token=${token}`);
  let bin = '';
  let selfId = null;
  let joined = false;
  const joinWaiters = [];
  const binWaiters = [];
  const checkBin = () => {
    for (let i = binWaiters.length - 1; i >= 0; i--) {
      if (bin.includes(binWaiters[i].sub)) {
        clearTimeout(binWaiters[i].timer);
        binWaiters.splice(i, 1)[0].resolve(bin);
      }
    }
  };
  ws.on('message', (buf, isBinary) => {
    if (isBinary) {
      bin += Buffer.from(buf).toString('utf8');
      checkBin();
      return;
    }
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
  ws.on('error', () => {});
  const api = {
    ws,
    get selfId() {
      return selfId;
    },
    get binary() {
      return bin;
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
    waitForBinary(sub, ms = DEFAULT_TIMEOUT) {
      if (bin.includes(sub)) return Promise.resolve(bin);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`guest ${name}: timed out waiting for ${JSON.stringify(sub)}\n--- got ---\n${bin.slice(-800)}`)),
          ms,
        );
        binWaiters.push({ sub, resolve, timer });
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

function bootHost(t) {
  return (async () => {
    const relay = await startRelay({ port: 0, webPort: 0, host: '127.0.0.1', hostKey: newKey(), hostName: 'ian' });
    t.after(() => relay.close());
    const { port, webPort } = relay;

    const workDir = mkdtempSync(join(tmpdir(), 'cs-mir-work-'));
    const homeDir = mkdtempSync(join(tmpdir(), 'cs-mir-home-'));
    const binDir = mkdtempSync(join(tmpdir(), 'cs-mir-bin-'));
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
    assert.ok(m, 'the status line carries the host-tab room URL with a token');
    return { host, webPort, code: m[2], token: m[3] };
  })();
}

test('mirror never leaks the host token, and a mid-session joiner gets one clean copy (findings 1, 2)', { timeout: 180000 }, async (t) => {
  const { host, webPort, code, token } = await bootHost(t);

  const hostTab = await connectHostTab(webPort, { code, token });
  t.after(() => hostTab.close());
  await hostTab.onJoined();
  hostTab.resize(120, 40);
  await hostTab.waitForState((s) => s.room === code);

  // ── paint DISTINCTIVE screen content BEFORE the guest joins (into the snapshot) ─
  // We assert on Claude's rendered SCREEN output ("[claude] prompt: …"), not the bare
  // prompt text — the latter also appears in the join card's "recent prompts" summary
  // and (for a line app like fake-claude) in the terminal's own echo, neither of which
  // is the mirrored screen. The screen form is unambiguous.
  const PRE = '[claude] prompt: PAINTED_BEFORE_JOIN_ZZZ';
  const POST = '[claude] prompt: PAINTED_AFTER_JOIN_QQQ';
  hostTab.command('PAINTED_BEFORE_JOIN_ZZZ');
  await host.waitFor(PRE);
  await host.waitFor('[claude] done'); // Claude is idle again — the frame is in the snapshot

  // ── a guest joins mid-session and is admitted from the host tab ──────────────
  const g = await connectWebGuest(webPort, { code, name: 'sid', token: 'tok-sid' });
  t.after(() => g.close());
  const k = (await hostTab.waitForState((s) => s.knocks.some((x) => x.name === 'sid'))).knocks.find((x) => x.name === 'sid');
  hostTab.admit(k.id);
  await g.onJoined();

  // The joiner receives the pre-join screen via the snapshot.
  await g.waitForBinary(PRE);

  // ── paint MORE content AFTER the guest joined (arrives as a live frame) ──────
  hostTab.command('PAINTED_AFTER_JOIN_QQQ');
  await g.waitForBinary(POST);
  // Give any stray duplicate a chance to arrive before we count.
  await new Promise((r) => setTimeout(r, 300));

  const bytes = g.binary;

  // finding 2 — the pre-join screen appears EXACTLY ONCE (from the snapshot), applied
  // BEFORE any live frame painted after the join. No interleaving, no duplicated repaint.
  const preCount = bytes.split(PRE).length - 1;
  assert.equal(preCount, 1, `the pre-join screen is delivered exactly once (got ${preCount})`);
  assert.ok(bytes.indexOf(PRE) < bytes.indexOf(POST), 'the snapshot is applied before the post-join live frame');
  // No raw split-SGR fragment leads a line (the ";246mPressW" class of bug).
  assert.doesNotMatch(bytes, /(?:^|\n)[0-9;]+m[A-Za-z]/, 'no raw SGR fragment rendered as text');

  // finding 1 — the host token is on the host's OWN terminal, never in the mirror.
  assert.ok(host.get().includes(`?host=${token}`), 'the host terminal shows its own host URL (with token)');
  assert.ok(!bytes.includes(token), 'the host token NEVER appears in the guest mirror');
  assert.ok(!bytes.includes('?host='), 'no host-token query reaches the guest mirror at all');
  // …but the mirrored band IS delivered — it just carries the token-free invite URL.
  assert.ok(bytes.includes(code), 'the mirrored status line still shows the room (token-free)');
});
