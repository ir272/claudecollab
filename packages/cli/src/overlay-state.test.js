// Integration test for the overlay-state channel — the browser multiplayer surface.
// Spins up a fake relay host-channel (a real ssh2 server that speaks the JSON-lines
// protocol), spawns the REAL host CLI pointed at it, and proves the deliverable:
//
//   • the host emits a well-formed {t:'state'} snapshot on every brain change,
//     with stable per-participant colors and pending knocks IN the state;
//   • an inbound {t:'ui'} admit from the host's browser (labeled id:'host') makes
//     the host admit that specific knock;
//   • an inbound {t:'pointer'} from a joined guest is rebroadcast via state.pointers;
//   • an inbound {t:'ui'} command runs AS its sender through the command parser, so
//     the role gate still applies (host's /role lands; a guest's /role is refused).
//
// The CLI runs with --no-hooks --cmd cat: no Claude, no hook socket — just the brain
// and the relay client, which is all the overlay state needs. Nothing here touches
// the ssh guest path (that keeps its own tests).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import ssh2 from 'ssh2';
import { encode, Decoder, TYPES } from '../../shared/protocol.js';
import { PALETTE } from './brain/state.js';

const { Server, utils } = ssh2;
const { generateKeyPairSync, parseKey } = utils;

const here = dirname(fileURLToPath(import.meta.url));
const cliEntry = join(here, '..', 'bin', 'claude-share.js');

// ssh2's generateKeyPairSync occasionally emits a key its own parser rejects — a
// known upstream flake. Validate and regenerate (mirrors the other integration tests).
function newKey() {
  for (let i = 0; i < 8; i++) {
    const priv = generateKeyPairSync('ed25519').private;
    if (!(parseKey(priv) instanceof Error)) return priv;
  }
  return generateKeyPairSync('ed25519').private;
}

// A minimal relay host-channel: accepts the host's publickey auth, hands out a room
// on `hello`/`reclaim`, records every protocol message the host sends, and can push
// protocol messages down to the host (the pieces the real relay does for browsers).
function startFakeRelay(code = 'brave-otter') {
  const received = [];
  const waiters = [];
  const push = (msg) => {
    received.push(msg);
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].pred(msg)) {
        clearTimeout(waiters[i].timer);
        waiters.splice(i, 1)[0].resolve(msg);
      }
    }
  };
  let hostStream = null;
  const dec = new Decoder();

  const server = new Server({ hostKeys: [newKey()] }, (conn) => {
    conn.on('authentication', (ctx) => (ctx.method === 'publickey' ? ctx.accept() : ctx.reject(['publickey'])));
    conn.on('ready', () => {
      conn.on('session', (accept) => {
        const session = accept();
        session.on('shell', (acceptShell) => {
          const stream = acceptShell();
          hostStream = stream;
          stream.on('data', (chunk) => {
            for (const msg of dec.push(chunk)) {
              push(msg);
              if (msg.t === TYPES.HELLO) stream.write(encode({ t: TYPES.ROOM, code }));
              if (msg.t === TYPES.RECLAIM) stream.write(encode({ t: TYPES.ROOM, code: msg.code }));
            }
          });
        });
      });
    });
    conn.on('error', () => {});
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', function () {
      resolve({
        port: this.address().port,
        code,
        received,
        // Resolve with the first (or next) recorded message matching pred.
        waitFor(pred, ms = 15000) {
          const found = received.find(pred);
          if (found) return Promise.resolve(found);
          return new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('fake relay: timed out waiting for a message')), ms);
            waiters.push({ pred, resolve, timer });
          });
        },
        send: (msg) => hostStream && hostStream.write(encode(msg)),
        latestState: () => [...received].reverse().find((m) => m.t === TYPES.STATE) ?? null,
        close: () => {
          try {
            server.close();
          } catch {}
        },
      });
    });
  });
}

const findParticipant = (state, id) => state.data.participants.find((p) => p.id === id);

test('overlay-state: host emits state; ui admit / pointer / ui command (gated) round-trip', { timeout: 60000 }, async (t) => {
  const relay = await startFakeRelay();
  t.after(() => relay.close());

  const homeDir = mkdtempSync(join(tmpdir(), 'cs-overlay-home-'));
  t.after(() => {
    try {
      rmSync(homeDir, { recursive: true, force: true });
    } catch {}
  });

  const cli = spawn(
    process.execPath,
    [cliEntry, '--relay', `ssh://127.0.0.1:${relay.port}`, '--no-hooks', '--cmd', 'cat', '--guests', 'prompter'],
    { env: { ...process.env, HOME: homeDir, USERPROFILE: homeDir, CLAUDE_SHARE_NO_CLIPBOARD: '1' } },
  );
  let stderr = '';
  cli.stderr.on('data', (d) => (stderr += d.toString()));
  t.after(() => {
    try {
      cli.kill();
    } catch {}
  });

  // ── the first state snapshot, once the room is granted ──────────────────────
  const s0 = await relay.waitFor((m) => m.t === TYPES.STATE && m.data.room === relay.code, 30000);
  assert.equal(s0.data.paused, false);
  assert.equal(s0.data.claudeState, 'idle', 'no hooks → known-idle');
  assert.deepEqual(s0.data.drafts.boxes, []);
  assert.deepEqual(s0.data.queue, []);
  assert.deepEqual(s0.data.pointers, {});
  assert.deepEqual(s0.data.knocks, []);
  const host = findParticipant(s0, 'host');
  assert.ok(host, 'the host is a participant');
  assert.equal(host.role, 'host');
  assert.ok(PALETTE.includes(host.color), 'the host carries a stable palette color');

  // ── a knock appears IN the state (the host admits from the browser) ─────────
  relay.send({ t: TYPES.KNOCK, id: 'k1', name: 'sid', fp: 'SHA256:sid', seen: null });
  const sKnock = await relay.waitFor((m) => m.t === TYPES.STATE && m.data.knocks.some((k) => k.id === 'k1'));
  const knock = sKnock.data.knocks.find((k) => k.id === 'k1');
  assert.deepEqual(knock, { id: 'k1', name: 'sid', fp: 'SHA256:sid', seen: null });

  // ── a {t:'ui'} admit from the host's browser admits that knock ──────────────
  relay.send({ t: TYPES.UI, id: 'host', action: { kind: 'admit', id: 'k1' } });
  const admit = await relay.waitFor((m) => m.t === TYPES.ADMIT && m.id === 'k1');
  assert.equal(admit.id, 'k1', 'the host forwarded an admit for the chosen knock');

  // ── the guest joins; a {t:'pointer'} is rebroadcast via state.pointers ──────
  relay.send({ t: TYPES.JOINED, id: 'k1' });
  const sJoin = await relay.waitFor((m) => m.t === TYPES.STATE && findParticipant(m, 'k1'));
  const sid = findParticipant(sJoin, 'k1');
  assert.equal(sid.name, 'sid');
  assert.equal(sid.role, 'prompter', 'the room default');
  assert.ok(PALETTE.includes(sid.color));
  assert.notEqual(sid.color, host.color, 'a distinct color from the host');

  relay.send({ t: TYPES.RESIZE, id: 'k1', cols: 100, rows: 30 });
  relay.send({ t: TYPES.POINTER, id: 'k1', x: 0.5, y: 0.25 });
  const sPtr = await relay.waitFor((m) => m.t === TYPES.STATE && m.data.pointers.k1);
  assert.deepEqual(sPtr.data.pointers.k1, { x: 0.5, y: 0.25, name: 'sid', color: sid.color });

  // ── a {t:'ui'} command runs AS its sender: the host's /role lands ───────────
  relay.send({ t: TYPES.UI, id: 'host', action: { kind: 'command', text: '/role @sid viewer' } });
  await relay.waitFor((m) => m.t === TYPES.STATE && findParticipant(m, 'k1')?.role === 'viewer');

  // ── …and the role gate still applies: the guest's own /role is refused ──────
  // A guest cannot run /role (host-only). The host answers the sender with a
  // notice, and the role must stay viewer.
  relay.send({ t: TYPES.UI, id: 'k1', action: { kind: 'command', text: '/role @sid prompter' } });
  await relay.waitFor((m) => m.t === TYPES.TO && m.id === 'k1');
  assert.equal(findParticipant(relay.latestState(), 'k1').role, 'viewer', 'the gated /role did not take effect');

  assert.equal(stderr.trim(), '', `CLI emitted no errors:\n${stderr}`);
});
