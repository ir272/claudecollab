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
import { connectRelay, parseRelayUrl } from './relay-client.js';

const { Client, utils } = ssh2;
const { generateKeyPairSync } = utils;
const newKey = () => generateKeyPairSync('ed25519').private;

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
