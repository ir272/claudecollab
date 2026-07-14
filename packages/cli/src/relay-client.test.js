// Integration test for the host-side relay client (Task 5). Spins up a real
// relay ssh server (Task 2) on an ephemeral localhost port, drives it with the
// connectRelay() client as the host, and connects a scripted ssh2 guest exactly
// as a stock `ssh` would. Asserts the Task 5 deliverable: the guest knocks, the
// host admits, and the guest then sees the bytes the host broadcasts — plus the
// key/leave/room plumbing the CLI wiring depends on.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import ssh2 from 'ssh2';
import { startRelay } from '../../relay/server.js';
import { Decoder, PROTOCOL_V } from '../../shared/protocol.js';
import { connectRelay, parseRelayUrl, openingMove } from './relay-client.js';

const { Client, Server, utils } = ssh2;
const { generateKeyPairSync, parseKey } = utils;

// A minimal ssh relay that captures the raw protocol frames the host sends —
// enough to assert the exact HELLO the CLI emits (v + optional cap), without the
// full relay parsing them away. Accepts any auth; delivers frames in order.
function captureRelay() {
  const frames = [];
  const waiters = [];
  const deliver = (msg) => {
    frames.push(msg);
    const w = waiters.shift();
    if (w) w(frames.shift());
  };
  const server = new Server({ hostKeys: [newKey()] }, (conn) => {
    conn.on('authentication', (ctx) => ctx.accept());
    conn.on('error', () => {});
    conn.on('ready', () => {
      conn.on('session', (accept) => {
        const session = accept();
        session.on('shell', (accept) => {
          const stream = accept();
          const dec = new Decoder();
          stream.on('data', (chunk) => {
            for (const msg of dec.push(chunk)) deliver(msg);
          });
        });
      });
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', function () {
      resolve({
        port: this.address().port,
        nextFrame: () => (frames.length ? Promise.resolve(frames.shift()) : new Promise((res) => waiters.push(res))),
        close: () => server.close(),
      });
    });
  });
}

// ssh2's generateKeyPairSync occasionally emits a key its own parser rejects
// ("Malformed OpenSSH private key") — a known upstream flake that surfaces under
// load. Validate with parseKey and regenerate so it can't destabilize these
// integration tests (mirrors test/e2e.test.js).
function newKey() {
  for (let i = 0; i < 8; i++) {
    const priv = generateKeyPairSync('ed25519').private;
    if (!(parseKey(priv) instanceof Error)) return priv;
  }
  return generateKeyPairSync('ed25519').private;
}

// Resolve the first time a registered callback fires.
const once = (register) => new Promise((res) => register(res));

// A scripted ssh guest: raw pty + shell, accumulates output, matches substrings —
// the same shape a real terminal presents to the relay.
function connectGuest(port, { code, privateKey } = {}) {
  return new Promise((resolve, reject) => {
    const client = new Client();
    let out = '';
    let closed = false;
    const textWaiters = [];
    const closeWaiters = [];
    const check = () => {
      for (let i = textWaiters.length - 1; i >= 0; i--) {
        if (out.includes(textWaiters[i].sub)) textWaiters.splice(i, 1)[0].resolve(out);
      }
    };
    const api = {
      client,
      waitFor: (sub) =>
        out.includes(sub) ? Promise.resolve(out) : new Promise((res) => textWaiters.push({ sub, resolve: res })),
      getOut: () => out,
      onClose: () => (closed ? Promise.resolve() : new Promise((res) => closeWaiters.push(res))),
    };
    client.on('error', reject);
    client.on('ready', () => {
      client.shell({ term: 'xterm', rows: 30, cols: 100, width: 0, height: 0 }, (err, stream) => {
        if (err) return reject(err);
        api.stream = stream;
        api.type = (s) => stream.write(s);
        stream.on('data', (d) => {
          out += d.toString('utf8');
          check();
        });
        stream.on('close', () => {
          closed = true;
          closeWaiters.splice(0).forEach((r) => r());
        });
        resolve(api);
      });
    });
    const opts = { host: '127.0.0.1', port, username: code };
    if (privateKey) opts.privateKey = privateKey;
    client.connect(opts);
  });
}

test('parseRelayUrl: scheme, host, port, and bare host:port forms', () => {
  assert.deepEqual(parseRelayUrl('ssh://localhost:2222'), { host: 'localhost', port: 2222 });
  assert.deepEqual(parseRelayUrl('ssh://relay.example.com'), { host: 'relay.example.com', port: 22 });
  assert.deepEqual(parseRelayUrl('127.0.0.1:2200'), { host: '127.0.0.1', port: 2200 });
  const d = parseRelayUrl();
  assert.equal(typeof d.host, 'string');
  assert.equal(typeof d.port, 'number');
});

test('openingMove: hello for a fresh connection, reclaim when a room is held', () => {
  assert.deepEqual(openingMove(null), { t: 'hello' });
  assert.deepEqual(openingMove(undefined), { t: 'hello' });
  assert.deepEqual(openingMove('brave-otter'), { t: 'reclaim', code: 'brave-otter' });
});

test('hello() announces the protocol version and, when configured, the requested cap', async (t) => {
  const relay = await captureRelay();
  t.after(() => relay.close());
  const url = `ssh://127.0.0.1:${relay.port}`;

  // No cap configured: HELLO carries v:1 and NO cap key.
  const plain = connectRelay({ url, privateKey: newKey() });
  t.after(() => plain.close());
  await plain.ready;
  plain.hello();
  const h1 = await relay.nextFrame();
  assert.equal(h1.t, 'hello');
  assert.equal(h1.want, 'room');
  assert.equal(h1.v, PROTOCOL_V);
  assert.equal(h1.v, 1);
  assert.ok(!('cap' in h1), 'no cap key when none is configured');

  // A configured cap rides the same HELLO.
  const capped = connectRelay({ url, privateKey: newKey(), cap: 4 });
  t.after(() => capped.close());
  await capped.ready;
  capped.hello();
  const h2 = await relay.nextFrame();
  assert.equal(h2.v, 1);
  assert.equal(h2.cap, 4);
});

test('relay-client: hello → room, knock → admit → guest sees broadcast bytes', async (t) => {
  const relay = await startRelay({ port: 0, host: '127.0.0.1', hostKey: newKey() });
  t.after(() => relay.close());

  const relayClient = connectRelay({ url: `ssh://127.0.0.1:${relay.port}`, privateKey: newKey() });
  t.after(() => relayClient.close());
  await relayClient.ready;

  // hello → a room code arrives.
  const roomP = once(relayClient.onRoom);
  relayClient.hello();
  const code = await roomP;
  assert.match(code, /^[a-z]+-[a-z]+$/, 'adjective-animal room code');

  // A real ssh guest knocks with a fresh key: name prompt, then knock reaches us.
  const knockP = once(relayClient.onKnock);
  const guest = await connectGuest(relay.port, { code, privateKey: newKey() });
  await guest.waitFor(`room ${code}`);
  await guest.waitFor('pick a name');
  guest.type('sid\r');
  const knock = await knockP;
  assert.equal(knock.name, 'sid');
  assert.match(knock.fp, /^SHA256:/, 'fingerprint surfaced to the host');
  assert.equal(knock.seen, null, 'first sighting');

  // Admit → join event + an initial resize reflecting the guest's terminal.
  const joinP = once(relayClient.onJoin);
  const resizeP = once(relayClient.onResize);
  relayClient.admit(knock.id);
  assert.equal(await joinP, knock.id, 'join fires with the admitted id');
  const rz = await resizeP;
  assert.deepEqual([rz.id, rz.cols, rz.rows], [knock.id, 100, 30]);

  // The deliverable: the guest watches the host's broadcast live.
  relayClient.sendScreen('HELLO-SCREEN\r\n');
  await guest.waitFor('HELLO-SCREEN');

  // A targeted message reaches only that guest.
  relayClient.sendTo(knock.id, 'CARD-FOR-SID');
  await guest.waitFor('CARD-FOR-SID');

  // Guest keystrokes surface to the host, labeled by id (CLI ignores them in v1).
  const keyP = once(relayClient.onKey);
  guest.type('K');
  const k = await keyP;
  assert.equal(k.id, knock.id);
  assert.equal(k.data.toString('utf8'), 'K');

  // The guest leaving surfaces a leave event with the same id.
  const leaveP = once(relayClient.onLeave);
  guest.client.end();
  assert.equal(await leaveP, knock.id, 'leave fires when the guest disconnects');

  // /end closes the room cleanly.
  relayClient.end();
});

test('relay-client: a dropped host reconnects and reclaims its room', async (t) => {
  // The exact dance bin/claude-share.js runs on relay onClose: a fresh connection on
  // the SAME key sends openingMove(heldRoom) === reclaim, the room comes back, and a
  // guest who never left keeps receiving the reattached host's broadcasts.
  const relay = await startRelay({ port: 0, host: '127.0.0.1', hostKey: newKey() });
  t.after(() => relay.close());
  const url = `ssh://127.0.0.1:${relay.port}`;
  const hostKey = newKey(); // stable identity — its fingerprint gates reclaim

  const c1 = connectRelay({ url, privateKey: hostKey });
  t.after(() => c1.close());
  await c1.ready;
  const roomP = once(c1.onRoom);
  const first = openingMove(null); // no room yet → hello
  assert.equal(first.t, 'hello');
  c1.hello();
  const code = await roomP;

  // A guest joins and sees a broadcast.
  const knockP = once(c1.onKnock);
  const guest = await connectGuest(relay.port, { code, privateKey: newKey() });
  t.after(() => {
    try {
      guest.client.end();
    } catch {}
  });
  await guest.waitFor('pick a name');
  guest.type('sid\r');
  const knock = await knockP;
  const joinP = once(c1.onJoin);
  c1.admit(knock.id);
  await joinP;
  c1.sendScreen('BEFORE-DROP\r\n');
  await guest.waitFor('BEFORE-DROP');

  // Host's wifi drops: tear the connection down. The guest stays connected.
  c1.close();

  // Reconnect on the same key and RECLAIM the held room (openingMove says so).
  const move = openingMove(code);
  assert.deepEqual(move, { t: 'reclaim', code });
  const c2 = connectRelay({ url, privateKey: hostKey });
  t.after(() => c2.close());
  await c2.ready;
  const roomP2 = once(c2.onRoom);
  const resizeP2 = once(c2.onResize);
  c2.reclaim(move.code);
  assert.equal(await roomP2, code, 'the same room is handed back on reclaim');
  const rz = await resizeP2;
  assert.equal(rz.id, knock.id, 'the still-present guest is re-synced to the reattached host');

  // The reattached host reaches the guest that never left…
  c2.sendScreen('BACK-ONLINE\r\n');
  await guest.waitFor('BACK-ONLINE');

  // …and the guest's keystrokes now flow to the new connection.
  const keyP = once(c2.onKey);
  guest.type('Z');
  const k = await keyP;
  assert.equal(k.data.toString('utf8'), 'Z');

  c2.end();
});

test('relay-client: deny closes the knocking guest', async (t) => {
  const relay = await startRelay({ port: 0, host: '127.0.0.1', hostKey: newKey() });
  t.after(() => relay.close());

  const relayClient = connectRelay({ url: `ssh://127.0.0.1:${relay.port}`, privateKey: newKey() });
  t.after(() => relayClient.close());
  await relayClient.ready;

  const roomP = once(relayClient.onRoom);
  relayClient.hello();
  const code = await roomP;

  const knockP = once(relayClient.onKnock);
  const guest = await connectGuest(relay.port, { code, privateKey: newKey() });
  await guest.waitFor('pick a name');
  guest.type('mallory\r');
  const knock = await knockP;

  relayClient.deny(knock.id);
  await guest.onClose();
  assert.match(guest.getOut(), /didn't let you in|no hard feelings/i, 'guest sees the polite denial');
});

test('relay-client: the room secret rides hello; a missing one surfaces as refused', async (t) => {
  const relay = await startRelay({ port: 0, host: '127.0.0.1', hostKey: newKey(), roomSecret: 'hunter2' });
  t.after(() => relay.close());
  const url = `ssh://127.0.0.1:${relay.port}`;

  // Without the secret the relay answers REFUSED — the client surfaces it as an
  // event (terminal verdict), never as a room.
  const bare = connectRelay({ url, privateKey: newKey() });
  t.after(() => bare.close());
  await bare.ready;
  const refusedP = once(bare.onRefused);
  bare.hello();
  assert.equal(await refusedP, 'secret', 'refusal reason surfaces to the caller');

  // With opts.secret, hello() carries it automatically and the room is granted.
  const cred = connectRelay({ url, privateKey: newKey(), secret: 'hunter2' });
  t.after(() => cred.close());
  await cred.ready;
  const roomP = once(cred.onRoom);
  cred.hello();
  assert.match(await roomP, /^[a-z]+-[a-z]+$/, 'the credentialed client gets a room');
});

test('relay-client: verifyHostKey sees the relay fingerprint; false aborts the connection', async (t) => {
  const relayKey = newKey();
  const relay = await startRelay({ port: 0, host: '127.0.0.1', hostKey: relayKey });
  t.after(() => relay.close());
  const url = `ssh://127.0.0.1:${relay.port}`;

  // The fingerprint the relay will present: SHA256 over its public key blob —
  // the same derivation serve.js prints at boot for pinning.
  const { createHash } = await import('node:crypto');
  const pubBlob = parseKey(relayKey).getPublicSSH();
  const expected = 'SHA256:' + createHash('sha256').update(pubBlob).digest('base64').replace(/=+$/, '');

  // A verifier that likes what it sees: connection proceeds, fp matches.
  let sawFp = null;
  const ok = connectRelay({
    url,
    privateKey: newKey(),
    verifyHostKey: (fp) => {
      sawFp = fp;
      return fp === expected;
    },
  });
  t.after(() => ok.close());
  await ok.ready;
  assert.equal(sawFp, expected, 'the verifier is shown the relay key fingerprint');

  // A verifier that refuses (pinned a different relay): the handshake aborts
  // before any protocol bytes flow — ready rejects, no room is ever granted.
  const veto = connectRelay({ url, privateKey: newKey(), verifyHostKey: () => false });
  t.after(() => veto.close());
  await assert.rejects(veto.ready, 'a refused host key must fail the connection');
});
