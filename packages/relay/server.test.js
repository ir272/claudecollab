// Integration test for the relay ssh server (Task 2). Spins up a real ssh2
// server on an ephemeral localhost port, then drives it with real ssh2 clients:
// one host (speaks the JSON-lines protocol) and guests (raw terminal bytes).
// Asserts the full spec §knock/§relay-ops path: reject-none auth → knock →
// admit → labeled key/resize forwarding → screen broadcast → targeted `to` →
// kick+ban → banned reconnect refused → keyless fallback → unknown room →
// per-room knock lockout.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import ssh2 from 'ssh2';
import { writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { startRelay } from './server.js';
import { encode, Decoder, TYPES } from '../shared/protocol.js';

const { Client, utils } = ssh2;
const { generateKeyPairSync } = utils;
const newKey = () => generateKeyPairSync('ed25519').private;

// A host client: opens a no-pty channel and talks protocol. `next(pred)` resolves
// with the first (queued or future) decoded message matching `pred`.
function connectHost(port) {
  return new Promise((resolve, reject) => {
    const client = new Client();
    const dec = new Decoder();
    const queue = [];
    const waiters = [];
    const deliver = (msg) => {
      const wi = waiters.findIndex((w) => w.pred(msg));
      if (wi !== -1) waiters.splice(wi, 1)[0].resolve(msg);
      else queue.push(msg);
    };
    const next = (pred) => {
      const qi = queue.findIndex(pred);
      if (qi !== -1) return Promise.resolve(queue.splice(qi, 1)[0]);
      return new Promise((res) => waiters.push({ pred, resolve: res }));
    };
    client.on('error', reject);
    client.on('ready', () => {
      client.shell(false, (err, stream) => {
        if (err) return reject(err);
        stream.on('data', (d) => {
          for (const m of dec.push(d)) deliver(m);
        });
        resolve({ client, stream, next, send: (o) => stream.write(encode(o)) });
      });
    });
    client.connect({ host: '127.0.0.1', port, username: 'host', privateKey: newKey() });
  });
}

// A guest client: allocates a pty + shell and accumulates raw output text.
function connectGuest(port, { code, privateKey, keyboard } = {}) {
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
    if (keyboard) client.on('keyboard-interactive', (n, i, l, p, finish) => finish([]));
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
    if (keyboard) opts.tryKeyboard = true;
    client.connect(opts);
  });
}

const b64 = (s) => Buffer.from(s).toString('base64');
const unb64 = (s) => Buffer.from(s, 'base64').toString('utf8');

test('relay: knock → admit → labeled forwarding → broadcast → kick ban', async (t) => {
  const keyPath = join(tmpdir(), `cs-relay-${randomUUID()}.key`);
  writeFileSync(keyPath, generateKeyPairSync('ed25519').private, { mode: 0o600 });
  t.after(() => {
    try {
      rmSync(keyPath);
    } catch {}
  });

  const relay = await startRelay({ port: 0, host: '127.0.0.1', hostKeyPath: keyPath });
  t.after(() => relay.close());
  const port = relay.port;

  // Host creates a room.
  const host = await connectHost(port);
  host.send({ t: TYPES.HELLO, want: 'room' });
  const room = await host.next((m) => m.t === TYPES.ROOM);
  assert.match(room.code, /^[a-z]+-[a-z]+$/, 'adjective-animal room code');
  const code = room.code;

  // Guest A knocks with a real key: new fingerprint ⇒ name prompt, seen=null.
  const keyA = newKey();
  const a = await connectGuest(port, { code, privateKey: keyA });
  await a.waitFor(`room ${code}`); // "connecting to …'s room <code>…"
  await a.waitFor('pick a name');
  a.type('sid\r');
  const knockA = await host.next((m) => m.t === TYPES.KNOCK);
  assert.equal(knockA.name, 'sid');
  assert.match(knockA.fp, /^SHA256:/, 'fingerprint captured from publickey');
  assert.equal(knockA.seen, null, 'first sighting of this key');
  await a.waitFor('knocking');

  // Admit A → joined + an initial resize reflecting the guest pty (100x30).
  host.send({ t: TYPES.ADMIT, id: knockA.id });
  await host.next((m) => m.t === TYPES.JOINED && m.id === knockA.id);
  const rz = await host.next((m) => m.t === TYPES.RESIZE && m.id === knockA.id);
  assert.deepEqual([rz.cols, rz.rows], [100, 30]);

  // Broadcast a frame → A sees it.
  host.send({ t: TYPES.SCREEN, data: b64('HELLO-SCREEN\r\n') });
  await a.waitFor('HELLO-SCREEN');

  // A's keystroke is forwarded labeled with A's id.
  a.type('K');
  const keyMsg = await host.next((m) => m.t === TYPES.KEY && m.id === knockA.id);
  assert.equal(unb64(keyMsg.data), 'K');

  // A resizes → forwarded resize.
  a.stream.setWindow(40, 120, 0, 0);
  const rz2 = await host.next((m) => m.t === TYPES.RESIZE && m.id === knockA.id && m.rows === 40);
  assert.equal(rz2.cols, 120);

  // Targeted `to` reaches only A.
  host.send({ t: TYPES.TO, id: knockA.id, data: b64('CARD-FOR-A') });
  await a.waitFor('CARD-FOR-A');

  // Guest B joins; a broadcast reaches both; a `to` reaches only B.
  const keyB = newKey();
  const b = await connectGuest(port, { code, privateKey: keyB });
  await b.waitFor('pick a name');
  b.type('bob\r');
  const knockB = await host.next((m) => m.t === TYPES.KNOCK);
  assert.equal(knockB.name, 'bob');
  host.send({ t: TYPES.ADMIT, id: knockB.id });
  await host.next((m) => m.t === TYPES.JOINED && m.id === knockB.id);
  await host.next((m) => m.t === TYPES.RESIZE && m.id === knockB.id);

  host.send({ t: TYPES.SCREEN, data: b64('BOTH\r\n') });
  await a.waitFor('BOTH');
  await b.waitFor('BOTH');

  host.send({ t: TYPES.TO, id: knockB.id, data: b64('ONLY-B') });
  await b.waitFor('ONLY-B');
  assert.ok(!a.getOut().includes('ONLY-B'), '`to` is not broadcast');

  // Kick + ban A.
  host.send({ t: TYPES.DROP, id: knockA.id, ban: true });
  await a.onClose();
  assert.ok(a.getOut().includes('removed'), 'A sees the kick copy');

  // A reconnects with the same key → banned fp, refused, and no fresh knock.
  let knockAfterBan = false;
  host.next((m) => m.t === TYPES.KNOCK).then(() => (knockAfterBan = true));
  const a2 = await connectGuest(port, { code, privateKey: keyA });
  await a2.onClose();
  assert.ok(a2.getOut().includes('removed'), 'banned reconnect refused');
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(knockAfterBan, false, 'banned fp cannot knock again');

  // /end tears the room down; B is disconnected.
  host.send({ t: TYPES.END });
  await b.onClose();
});

test('relay: keyless guest gets session-only identity (empty fp)', async (t) => {
  const relay = await startRelay({ port: 0, host: '127.0.0.1', hostKey: newKey() });
  t.after(() => relay.close());
  const port = relay.port;

  const host = await connectHost(port);
  host.send({ t: TYPES.HELLO, want: 'room' });
  const { code } = await host.next((m) => m.t === TYPES.ROOM);

  // No privateKey → 'none' rejected, publickey unavailable, keyboard-interactive used.
  const g = await connectGuest(port, { code, keyboard: true });
  await g.waitFor('pick a name');
  g.type('anon\r');
  const knock = await host.next((m) => m.t === TYPES.KNOCK);
  assert.equal(knock.name, 'anon');
  assert.equal(knock.fp, '', 'keyless ⇒ no fingerprint');
  assert.equal(knock.seen, null);

  host.send({ t: TYPES.ADMIT, id: knock.id });
  await host.next((m) => m.t === TYPES.JOINED && m.id === knock.id);
  host.send({ t: TYPES.SCREEN, data: b64('LIVE-NOW\r\n') });
  await g.waitFor('LIVE-NOW');

  host.send({ t: TYPES.END });
  await g.onClose();
});

test('relay: unknown room code is refused politely', async (t) => {
  const relay = await startRelay({ port: 0, host: '127.0.0.1', hostKey: newKey() });
  t.after(() => relay.close());

  const g = await connectGuest(relay.port, { code: 'no-such-room', keyboard: true });
  await g.onClose();
  assert.match(g.getOut(), /no room|ended|wrong/i, 'polite no-room copy');
});

test('relay: a returning key is remembered (seen carries the prior name)', async (t) => {
  const relay = await startRelay({ port: 0, host: '127.0.0.1', hostKey: newKey() });
  t.after(() => relay.close());
  const port = relay.port;

  const host = await connectHost(port);
  host.send({ t: TYPES.HELLO, want: 'room' });
  const { code } = await host.next((m) => m.t === TYPES.ROOM);

  const key = newKey();
  const g1 = await connectGuest(port, { code, privateKey: key });
  await g1.waitFor('pick a name');
  g1.type('dana\r');
  const k1 = await host.next((m) => m.t === TYPES.KNOCK);
  assert.equal(k1.seen, null);
  host.send({ t: TYPES.DENY, id: k1.id });
  await g1.onClose();

  // Same key returns: no name prompt, and seen = prior name.
  const g2 = await connectGuest(port, { code, privateKey: key });
  const k2 = await host.next((m) => m.t === TYPES.KNOCK);
  assert.equal(k2.name, 'dana');
  assert.equal(k2.seen, 'dana', 'returning key remembered');
  assert.ok(!g2.getOut().includes('pick a name'), 'no re-prompt for a known key');

  host.send({ t: TYPES.END });
});

test('relay: per-room knock lockout after too many attempts from one ip', async (t) => {
  const relay = await startRelay({
    port: 0,
    host: '127.0.0.1',
    hostKey: newKey(),
    registry: { knockLimit: 2 },
  });
  t.after(() => relay.close());
  const port = relay.port;

  const host = await connectHost(port);
  host.send({ t: TYPES.HELLO, want: 'room' });
  const { code } = await host.next((m) => m.t === TYPES.ROOM);

  const key = newKey();
  // First two knocks are allowed (denied by host each time).
  for (let i = 0; i < 2; i++) {
    const g = await connectGuest(port, { code, privateKey: key });
    if (i === 0) {
      await g.waitFor('pick a name');
      g.type('erin\r');
    }
    const k = await host.next((m) => m.t === TYPES.KNOCK);
    host.send({ t: TYPES.DENY, id: k.id });
    await g.onClose();
  }

  // Third attempt from the same ip is locked out before reaching the host.
  let knocked = false;
  host.next((m) => m.t === TYPES.KNOCK).then(() => (knocked = true));
  const g3 = await connectGuest(port, { code, privateKey: key });
  await g3.onClose();
  assert.match(g3.getOut(), /too many|try again/i, 'lockout copy');
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(knocked, false, 'locked-out attempt never reaches the host');

  host.send({ t: TYPES.END });
});
