// Integration test for the relay web door (packages/relay/web.js). Spins up a real
// relay with a browser door on an ephemeral port, drives the host side with a real
// ssh2 client (a fake brain) and the browser side with real `ws` clients, and proves
// the deliverable end to end:
//
//   • HTTP: GET / serves the client (or the fallback); GET /assets/* serves the
//     vendored xterm files with correct content-types and is path-traversal safe;
//   • WS knock → host admit → 'joined' → screen bytes (binary) + state JSON (text);
//   • browser input (key/resize/pointer/ui) reaches the host LABELED with the relay-
//     stamped id (a browser-supplied id is ignored);
//   • the host tab (&host=<token>) knocks with fp 'webhost:<token>' so the brain can
//     auto-admit it — the relay makes no trust call of its own;
//   • ban enforcement: a kicked+banned token is refused on reconnect and never knocks.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import ssh2 from 'ssh2';
import { WebSocket } from 'ws';
import { startRelay, MAX_PENDING } from './server.js';
import { clientIp } from './web.js';
import { encode, Decoder, TYPES } from '../shared/protocol.js';

const { Client, utils } = ssh2;
const { generateKeyPairSync, parseKey } = utils;

// ssh2's generateKeyPairSync occasionally emits a key its own parser rejects — a
// known upstream flake. Validate and regenerate (mirrors the other relay tests).
function newKey() {
  for (let i = 0; i < 8; i++) {
    const priv = generateKeyPairSync('ed25519').private;
    if (!(parseKey(priv) instanceof Error)) return priv;
  }
  return generateKeyPairSync('ed25519').private;
}

// A fake host: ssh2 client on username 'host', no-pty shell, speaks JSON-lines.
function connectHost(port, privateKey = newKey()) {
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
    client.connect({ host: '127.0.0.1', port, username: 'host', privateKey });
  });
}

// A browser: a real ws client that separates binary frames (screen bytes) from
// text frames (JSON protocol), with promise-based waiters over both.
function connectWeb(webPort, query) {
  const ws = new WebSocket(`ws://127.0.0.1:${webPort}/ws?${query}`);
  const texts = [];
  const bins = [];
  const textWaiters = [];
  const binWaiters = [];
  let closed = false;
  const closeWaiters = [];
  const drain = (waiters, item) => {
    for (let i = waiters.length - 1; i >= 0; i--) if (waiters[i].pred(item)) waiters.splice(i, 1)[0].resolve(item);
  };
  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      const buf = Buffer.from(data);
      bins.push(buf);
      drain(binWaiters, buf);
    } else {
      let m;
      try {
        m = JSON.parse(data.toString('utf8'));
      } catch {
        return;
      }
      texts.push(m);
      drain(textWaiters, m);
    }
  });
  ws.on('close', () => {
    closed = true;
    closeWaiters.splice(0).forEach((r) => r());
  });
  ws.on('error', () => {}); // a refused/closed socket surfaces via onClose
  return {
    ws,
    ready: () => new Promise((res, rej) => (ws.readyState === ws.OPEN ? res() : (ws.on('open', res), ws.on('error', rej)))),
    send: (o) => ws.send(JSON.stringify(o)),
    nextText: (pred) => {
      const f = texts.find(pred);
      return f ? Promise.resolve(f) : new Promise((res) => textWaiters.push({ pred, resolve: res }));
    },
    nextBinary: (pred = () => true) => {
      const f = bins.find(pred);
      return f ? Promise.resolve(f) : new Promise((res) => binWaiters.push({ pred, resolve: res }));
    },
    onClose: () => (closed ? Promise.resolve() : new Promise((res) => closeWaiters.push(res))),
  };
}

const b64 = (s) => Buffer.from(s).toString('base64');
const unb64 = (s) => Buffer.from(s, 'base64').toString('utf8');

test('clientIp honors Fly-Client-IP only when trusted', () => {
  const req = { headers: { 'fly-client-ip': '203.0.113.9' }, socket: { remoteAddress: '172.16.0.1' } };
  assert.equal(clientIp(req, true), '203.0.113.9');
  assert.equal(clientIp(req, false), '172.16.0.1');
  assert.equal(clientIp({ headers: {}, socket: { remoteAddress: '172.16.0.1' } }, true), '172.16.0.1');
});

test('web door: HTTP serves the client + xterm assets, path-traversal safe', async (t) => {
  const relay = await startRelay({ port: 0, webPort: 0, host: '127.0.0.1', hostKey: newKey() });
  t.after(() => relay.close());
  const base = `http://127.0.0.1:${relay.webPort}`;

  // GET / → an HTML document (T3's client, or web.js's fallback).
  const index = await fetch(`${base}/`);
  assert.equal(index.status, 200);
  assert.match(index.headers.get('content-type'), /text\/html/);
  assert.match(await index.text(), /<(!doctype|html|body|h1)/i);

  // GET /<roomCode> → the same SPA entry (client reads the code from the path).
  const room = await fetch(`${base}/brave-otter`);
  assert.equal(room.status, 200);
  assert.match(room.headers.get('content-type'), /text\/html/);

  // GET /assets/* → the vendored xterm bundle + css with correct content-types.
  const js = await fetch(`${base}/assets/lib/xterm.js`);
  assert.equal(js.status, 200);
  assert.match(js.headers.get('content-type'), /javascript/);
  assert.ok((await js.text()).length > 1000, 'the real xterm bundle is served');

  const css = await fetch(`${base}/assets/css/xterm.css`);
  assert.equal(css.status, 200);
  assert.match(css.headers.get('content-type'), /text\/css/);

  // Path traversal is refused (resolved path pinned inside the package dir).
  const escape = await fetch(`${base}/assets/../../../../etc/passwd`);
  assert.ok([403, 404].includes(escape.status), `traversal blocked (got ${escape.status})`);
  const nope = await fetch(`${base}/assets/nope/missing.js`);
  assert.equal(nope.status, 404);
});

test('web door: knock → admit → joined → screen + state → labeled input', async (t) => {
  const relay = await startRelay({ port: 0, webPort: 0, host: '127.0.0.1', hostKey: newKey() });
  t.after(() => relay.close());

  const host = await connectHost(relay.port);
  t.after(() => host.client.end());
  host.send({ t: TYPES.HELLO, want: 'room' });
  const { code } = await host.next((m) => m.t === TYPES.ROOM);

  // A browser knocks with a name + token; the relay derives fp = 'web:' + token.
  const sid = connectWeb(relay.webPort, `room=${code}&name=sid&token=tok-sid`);
  t.after(() => sid.ws.close());
  await sid.ready();
  const knock = await host.next((m) => m.t === TYPES.KNOCK);
  assert.equal(knock.name, 'sid');
  assert.equal(knock.fp, 'web:tok-sid', 'browser token becomes the web fingerprint');
  assert.equal(knock.seen, null, 'first sighting of this token');

  // Host admits → the browser gets an explicit 'joined' text frame.
  host.send({ t: TYPES.ADMIT, id: knock.id });
  const joined = await sid.nextText((m) => m.t === 'joined');
  assert.equal(joined.id, knock.id);
  // The relay hands the host the browser's initial (floor) size on admit.
  const rz0 = await host.next((m) => m.t === TYPES.RESIZE && m.id === knock.id);
  assert.deepEqual([rz0.cols, rz0.rows], [80, 24]);

  // Screen bytes arrive as a BINARY frame; the overlay snapshot as a TEXT frame.
  host.send({ t: TYPES.SCREEN, data: b64('HELLO-WEB\r\n') });
  const screen = await sid.nextBinary((b) => b.toString('utf8').includes('HELLO-WEB'));
  assert.match(screen.toString('utf8'), /HELLO-WEB/);

  host.send({ t: TYPES.STATE, data: { room: code, participants: [{ id: 'host', name: 'ian', role: 'host' }] } });
  const state = await sid.nextText((m) => m.t === 'state');
  assert.equal(state.data.room, code);
  assert.equal(state.data.participants[0].role, 'host');

  // Browser input reaches the host LABELED with the relay-stamped id. A browser-
  // supplied id is ignored — the relay always stamps the real sender.
  sid.send({ t: 'key', id: 'forged', data: b64('K') });
  const key = await host.next((m) => m.t === TYPES.KEY && m.id === knock.id);
  assert.equal(unb64(key.data), 'K');
  assert.notEqual(key.id, 'forged', 'the relay stamps the sender id, not the browser');

  sid.send({ t: 'resize', cols: 120, rows: 40 });
  const rz = await host.next((m) => m.t === TYPES.RESIZE && m.id === knock.id && m.cols === 120);
  assert.equal(rz.rows, 40);

  sid.send({ t: 'pointer', x: 0.5, y: 0.25 });
  const ptr = await host.next((m) => m.t === TYPES.POINTER && m.id === knock.id);
  assert.deepEqual([ptr.x, ptr.y], [0.5, 0.25]);

  sid.send({ t: 'ui', action: { kind: 'command', text: '/recap' } });
  const ui = await host.next((m) => m.t === TYPES.UI && m.id === knock.id);
  assert.deepEqual(ui.action, { kind: 'command', text: '/recap' });

  // A malformed input (key with no data) is dropped, and the channel survives.
  sid.send({ t: 'key' });
  sid.send({ t: 'pointer', x: 0.1, y: 0.2 });
  const ptr2 = await host.next((m) => m.t === TYPES.POINTER && m.id === knock.id && m.x === 0.1);
  assert.equal(ptr2.y, 0.2, 'valid input after a dropped malformed one still routes');
});

test('web door: host tab knocks with a webhost fingerprint (brain auto-admits)', async (t) => {
  const relay = await startRelay({ port: 0, webPort: 0, host: '127.0.0.1', hostKey: newKey() });
  t.after(() => relay.close());

  const host = await connectHost(relay.port);
  t.after(() => host.client.end());
  host.send({ t: TYPES.HELLO, want: 'room' });
  const { code } = await host.next((m) => m.t === TYPES.ROOM);

  const hostTab = connectWeb(relay.webPort, `room=${code}&name=ian&host=htoken-123`);
  t.after(() => hostTab.ws.close());
  await hostTab.ready();

  // The relay forwards the token verbatim as the knock fp — no relay-side trust.
  const knock = await host.next((m) => m.t === TYPES.KNOCK);
  assert.equal(knock.fp, 'webhost:htoken-123', 'host token forwarded as-is in the fp');

  // The brain matches its own token and auto-admits (simulated here).
  host.send({ t: TYPES.ADMIT, id: knock.id });
  const joined = await hostTab.nextText((m) => m.t === 'joined');
  assert.equal(joined.id, knock.id);
});

test('web door: a kicked+banned token is refused on reconnect and cannot knock', async (t) => {
  const relay = await startRelay({ port: 0, webPort: 0, host: '127.0.0.1', hostKey: newKey() });
  t.after(() => relay.close());

  const host = await connectHost(relay.port);
  t.after(() => host.client.end());
  host.send({ t: TYPES.HELLO, want: 'room' });
  const { code } = await host.next((m) => m.t === TYPES.ROOM);

  const g = connectWeb(relay.webPort, `room=${code}&name=mallory&token=tok-bad`);
  await g.ready();
  const knock = await host.next((m) => m.t === TYPES.KNOCK);
  host.send({ t: TYPES.ADMIT, id: knock.id });
  await g.nextText((m) => m.t === 'joined');

  // Kick + ban the token.
  host.send({ t: TYPES.DROP, id: knock.id, ban: true });
  await g.onClose();

  // Same token returns → refused with a 'banned' reason, and no fresh knock reaches
  // the host (the relay enforces the ban before knocking, exactly like the ssh door).
  let knockedAgain = false;
  host.next((m) => m.t === TYPES.KNOCK).then(() => (knockedAgain = true));
  const g2 = connectWeb(relay.webPort, `room=${code}&name=mallory&token=tok-bad`);
  const err = await g2.nextText((m) => m.t === 'error');
  assert.equal(err.reason, 'banned');
  await g2.onClose();
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(knockedAgain, false, 'a banned token never reaches the host');
});

test('web door: a ?name= carrying raw ESC/OSC/BEL bytes is sanitized before it knocks', async (t) => {
  const relay = await startRelay({ port: 0, webPort: 0, host: '127.0.0.1', hostKey: newKey() });
  t.after(() => relay.close());

  const host = await connectHost(relay.port);
  t.after(() => host.client.end());
  host.send({ t: TYPES.HELLO, want: 'room' });
  const { code } = await host.next((m) => m.t === TYPES.ROOM);

  // A hostile invite param: ESC-based CSI, an OSC title-set, a BEL, and a newline —
  // exactly the bytes the host would otherwise write verbatim to its terminal and
  // mirror to every ssh guest. encodeURIComponent carries them through the query.
  const evil = 'a\x1b[31mX\x1b]0;pwned\x07\r\ndrop';
  const g = connectWeb(relay.webPort, `room=${code}&name=${encodeURIComponent(evil)}&token=tok-x`);
  t.after(() => g.ws.close());
  await g.ready();

  const knock = await host.next((m) => m.t === TYPES.KNOCK);
  // The knock name the host receives is printable ASCII only: no ESC (0x1b), no BEL
  // (0x07), no CR/LF — the control bytes are gone, the CSI/OSC bodies are inert text.
  assert.equal(knock.name, 'a[31mX]0;pwneddrop');
  assert.ok(!/[\x00-\x1f\x7f]/.test(knock.name), 'no control bytes reach the host terminal');
});

test('web door: pending knocks are capped per room (card-spam lid)', async (t) => {
  const relay = await startRelay({
    port: 0,
    webPort: 0,
    host: '127.0.0.1',
    hostKey: newKey(),
    registry: { knockLimit: 100 }, // raise so the per-ip limiter doesn't fire first
  });
  t.after(() => relay.close());

  const host = await connectHost(relay.port);
  t.after(() => host.client.end());
  host.send({ t: TYPES.HELLO, want: 'room' });
  const { code } = await host.next((m) => m.t === TYPES.ROOM);

  // Fill pending to the cap: MAX_PENDING guests knock but are never admitted.
  const guests = [];
  for (let i = 0; i < MAX_PENDING; i++) {
    const g = connectWeb(relay.webPort, `room=${code}&name=g${i}&token=t${i}`);
    t.after(() => g.ws.close());
    await g.ready();
    await host.next((m) => m.t === TYPES.KNOCK && m.name === `g${i}`);
    guests.push(g);
  }

  // The next connection overflows the cap → machine-readable 'busy' + close, and
  // the host never sees an over-cap knock.
  let knocked = false;
  host.next((m) => m.t === TYPES.KNOCK).then(() => (knocked = true));
  const over = connectWeb(relay.webPort, `room=${code}&name=over&token=t-over`);
  t.after(() => over.ws.close());
  const err = await over.nextText((m) => m.t === 'error');
  assert.equal(err.reason, 'busy');
  await over.onClose();
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(knocked, false, 'the capped attempt never reaches the host');
});

test('web door: an unknown room code is refused politely', async (t) => {
  const relay = await startRelay({ port: 0, webPort: 0, host: '127.0.0.1', hostKey: newKey() });
  t.after(() => relay.close());

  const g = connectWeb(relay.webPort, `room=no-such-room&name=x&token=t`);
  const err = await g.nextText((m) => m.t === 'error');
  assert.equal(err.reason, 'no-room');
  await g.onClose();
});

test('web door: room password rides the first WS message, not the URL', async (t) => {
  const relay = await startRelay({ port: 0, webPort: 0, host: '127.0.0.1', hostKey: newKey() });
  t.after(() => relay.close());

  const host = await connectHost(relay.port);
  t.after(() => host.client.end());
  host.send({ t: TYPES.HELLO, want: 'room', pass: 'sesame' });
  const { code } = await host.next((m) => m.t === TYPES.ROOM);

  // A guest connects WITHOUT ?pass= — the relay challenges over the wire first.
  const sid = connectWeb(relay.webPort, `room=${code}&name=sid&token=t-sid`);
  t.after(() => sid.ws.close());
  const ask = await sid.nextText((m) => m.t === 'pass?');
  assert.ok(ask, 'the relay asks for the password on the wire, not via the URL');
  // The right password as the FIRST message → the knock reaches the host.
  sid.send({ t: 'pass', pass: 'sesame' });
  const knock = await host.next((m) => m.t === TYPES.KNOCK && m.name === 'sid');
  assert.ok(knock.id, 'a correct in-band password lets the guest knock');

  // A wrong password → machine-readable refusal + close; the knock never lands.
  const eve = connectWeb(relay.webPort, `room=${code}&name=eve&token=t-eve`);
  t.after(() => eve.ws.close());
  await eve.nextText((m) => m.t === 'pass?');
  eve.send({ t: 'pass', pass: 'wrong' });
  const err = await eve.nextText((m) => m.t === 'error');
  assert.equal(err.reason, 'password');
  await eve.onClose();

  // A stale ?pass= in the URL is IGNORED — no password leaks through the query
  // string; the guest is still challenged on the wire.
  const url = connectWeb(relay.webPort, `room=${code}&name=urlpw&token=t-url&pass=sesame`);
  t.after(() => url.ws.close());
  const ask2 = await url.nextText((m) => m.t === 'pass?');
  assert.ok(ask2, 'a URL ?pass= does not satisfy the gate — the wire challenge still fires');

  // Host tab: exempt — its credential is the host token the brain itself minted.
  const hostTab = connectWeb(relay.webPort, `room=${code}&host=htok`);
  t.after(() => hostTab.ws.close());
  const hostKnock = await host.next((m) => m.t === TYPES.KNOCK && m.fp === 'webhost:htok');
  assert.ok(hostKnock.id, 'the host tab needs no room password');
});

test('web door: a room ending mid-password-challenge refuses the late answer', async (t) => {
  const relay = await startRelay({ port: 0, webPort: 0, host: '127.0.0.1', hostKey: newKey() });
  t.after(() => relay.close());

  const host = await connectHost(relay.port);
  t.after(() => host.client.end());
  host.send({ t: TYPES.HELLO, want: 'room', pass: 'sesame' });
  const { code } = await host.next((m) => m.t === TYPES.ROOM);

  // Guest reaches the password prompt (in neither guests nor pending yet)…
  const late = connectWeb(relay.webPort, `room=${code}&name=late&token=t-late`);
  t.after(() => late.ws.close());
  await late.nextText((m) => m.t === 'pass?');

  // …then the host ends the room while they're typing.
  host.send({ t: TYPES.END });
  await new Promise((r) => setTimeout(r, 50)); // let closeRoom run

  // The (correct!) answer must be refused — never knocked into the dead room.
  late.send({ t: 'pass', pass: 'sesame' });
  const err = await late.nextText((m) => m.t === 'error');
  assert.equal(err.reason, 'no-room', 'a late password answer meets a refusal, not a 60s ghost wait');
  await late.onClose();
});
