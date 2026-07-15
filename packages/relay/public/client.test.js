// Tests for the browser client. Two layers:
//
//   1. PURE view-model helpers (no DOM): importing client.js in node runs no browser
//      code (the app is guarded), so we can exercise the state→view-model transforms,
//      the keystroke→bytes translation, and the URL parsing directly.
//
//   2. A smoke test over a real relay web door: fetch / (the SPA), an /assets/* file
//      (vendored xterm), the served /client.js + /style.css, and then complete a full
//      WS join against a fake host — knock → admit → 'joined' → screen + state.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import ssh2 from 'ssh2';
import { WebSocket } from 'ws';
import { startRelay } from '../server.js';
import { encode, Decoder, TYPES } from '../../shared/protocol.js';
import {
  parseLocation,
  buildWsPath,
  b64encode,
  keyToBytes,
  pasteBytes,
  clamp01,
  throttleReady,
  byId,
  roleCaps,
  claudeLabel,
  seenLabel,
  shortFp,
  segmentBox,
  draftView,
  overlayView,
  roleAction,
  kickAction,
  inviteLink,
  ASK_APPROVE_BYTES,
  ASK_DENY_BYTES,
} from './client.js';

// ════════════════════════════════════════════════════════════════════════════
// PURE HELPERS
// ════════════════════════════════════════════════════════════════════════════

test('parseLocation: room code from the path, host token from the query', () => {
  assert.deepEqual(parseLocation('http://x/brave-otter'), { code: 'brave-otter', hostToken: null, isHostTab: false });
  assert.deepEqual(parseLocation('http://x/'), { code: '', hostToken: null, isHostTab: false });
  const h = parseLocation('http://x/brave-otter?host=tok-9');
  assert.deepEqual(h, { code: 'brave-otter', hostToken: 'tok-9', isHostTab: true });
  // A served asset path (has a dot / more than one segment) is never read as a code.
  assert.equal(parseLocation('http://x/client.js').code, '');
  assert.equal(parseLocation('http://x/a/b').code, '');
  // Accepts a location-like object too.
  assert.equal(parseLocation({ pathname: '/quiet-fox', search: '' }).code, 'quiet-fox');
});

test('buildWsPath: host tab carries host; a guest carries token+name', () => {
  const guest = buildWsPath({ code: 'brave-otter', name: 'sid', token: 'abc' });
  const gq = new URLSearchParams(guest.slice(guest.indexOf('?') + 1));
  assert.equal(gq.get('room'), 'brave-otter');
  assert.equal(gq.get('name'), 'sid');
  assert.equal(gq.get('token'), 'abc');
  assert.equal(gq.get('host'), null);

  const host = buildWsPath({ code: 'brave-otter', name: 'ian', token: 'abc', hostToken: 'H' });
  const hq = new URLSearchParams(host.slice(host.indexOf('?') + 1));
  assert.equal(hq.get('host'), 'H');
  assert.equal(hq.get('token'), null, 'the host token wins; no browser token is sent');
});

test('buildWsPath: a host tab carries the seat secret; a guest never does', () => {
  const host = buildWsPath({ code: 'brave-otter', hostToken: 'H', seat: 'seatABC' });
  const hq = new URLSearchParams(host.slice(host.indexOf('?') + 1));
  assert.equal(hq.get('seat'), 'seatABC', 'the host seat rides the host-tab connection');

  const guest = buildWsPath({ code: 'brave-otter', name: 'sid', token: 'abc', seat: 'seatABC' });
  assert.ok(!guest.includes('seat='), 'a guest never sends a host seat (no host token)');

  const noSeat = buildWsPath({ code: 'brave-otter', hostToken: 'H' });
  assert.ok(!noSeat.includes('seat='), 'no seat param when none was minted');
});

test('buildWsPath: the room password never rides the URL', () => {
  // The password now goes on the wire (reply to {t:'pass?'}), never the query
  // string — so even a passed `pass` must not appear in the built path.
  const guest = buildWsPath({ code: 'brave-otter', name: 'sid', token: 'abc', pass: 'pw' });
  assert.ok(!guest.includes('pass='), 'a guest never leaks the password into the URL');

  const open = buildWsPath({ code: 'brave-otter', name: 'sid', token: 'abc' });
  assert.ok(!open.includes('pass='), 'open rooms send no password param at all');

  const host = buildWsPath({ code: 'brave-otter', hostToken: 'H', pass: 'pw' });
  assert.ok(!host.includes('pass='), 'the host tab never carries a password either');
});

test('b64encode: round-trips UTF-8 bytes (host decodes Buffer.from(data,"base64"))', () => {
  for (const s of ['K', '\r', '\x1b[D', 'héllo ✦', '', '\x1b[200~paste\x1b[201~']) {
    assert.equal(Buffer.from(b64encode(s), 'base64').toString('utf8'), s);
  }
});

test('keyToBytes: the browser-safe draft keymap', () => {
  assert.equal(keyToBytes({ key: 'Enter' }), '\r');
  assert.equal(keyToBytes({ key: 'Enter', shiftKey: true }), '\x1b\r');
  assert.equal(keyToBytes({ key: 'Backspace' }), '\x7f');
  assert.equal(keyToBytes({ key: 'Backspace', altKey: true }), '\x1b\x7f');
  assert.equal(keyToBytes({ key: 'ArrowLeft' }), '\x1b[D');
  assert.equal(keyToBytes({ key: 'ArrowLeft', altKey: true }), '\x1b[1;3D');
  assert.equal(keyToBytes({ key: 'ArrowRight', altKey: true }), '\x1b[1;3C');
  assert.equal(keyToBytes({ key: 'Home' }), '\x1b[H');
  assert.equal(keyToBytes({ key: 'End' }), '\x1b[F');
  assert.equal(keyToBytes({ key: 'Escape' }), '\x1b');
  assert.equal(keyToBytes({ key: 'a' }), 'a');
  assert.equal(keyToBytes({ key: '✦' }), '✦');
  // Never hijack a Ctrl/Cmd combo — the browser keeps those.
  assert.equal(keyToBytes({ key: 'c', ctrlKey: true }), null);
  assert.equal(keyToBytes({ key: 'v', metaKey: true }), null);
  // Non-printable / unmapped keys are ignored.
  assert.equal(keyToBytes({ key: 'F5' }), null);
  assert.equal(keyToBytes({}), null);
});

test('pasteBytes wraps the bracketed-paste guards the brain collapses to a token', () => {
  assert.equal(pasteBytes('two\nlines'), '\x1b[200~two\nlines\x1b[201~');
});

test('clamp01 + throttleReady', () => {
  assert.equal(clamp01(-3), 0);
  assert.equal(clamp01(2), 1);
  assert.equal(clamp01(0.42), 0.42);
  assert.equal(clamp01('nope'), 0);
  assert.equal(throttleReady(0, 33, 33), true);
  assert.equal(throttleReady(0, 10, 33), false);
});

test('roleCaps: the capability gate per role (viewer / prompter / host)', () => {
  assert.deepEqual(roleCaps('viewer'), { isViewer: true, canCompose: false, isHost: false });
  assert.deepEqual(roleCaps('prompter'), { isViewer: false, canCompose: true, isHost: false });
  assert.deepEqual(roleCaps('host'), { isViewer: false, canCompose: true, isHost: true });
  assert.equal(roleCaps(undefined).isViewer, true, 'unknown role fails closed to viewer');
});

test('claudeLabel / seenLabel / shortFp', () => {
  assert.deepEqual(claudeLabel('busy'), { text: 'Claude is brewing', kind: 'busy' });
  assert.deepEqual(claudeLabel('ask'), { text: 'permission ask pending', kind: 'ask' });
  assert.equal(claudeLabel('idle').kind, 'idle');
  assert.equal(claudeLabel(undefined).kind, 'idle');
  assert.match(seenLabel(null), /first time/);
  assert.equal(seenLabel('sid'), 'seen before as sid');
  assert.equal(shortFp('SHA256:abcdefghijklmnopqrstuvwxyz'), 'abcdefghijkl…');
  assert.equal(shortFp(''), '');
});

test('roleAction/kickAction target the participant id, never the claimed name (finding 4)', () => {
  // Two guests can claim the SAME name; the roster action must carry the unambiguous id.
  assert.deepEqual(roleAction('g2', 'prompter'), { t: 'ui', action: { kind: 'role', id: 'g2', role: 'prompter' } });
  assert.deepEqual(kickAction('g2'), { t: 'ui', action: { kind: 'kick', id: 'g2' } });
  // The id is used verbatim even when a name has spaces / non-word chars (un-mentionable).
  assert.equal(kickAction('uuid-with-space-name').action.id, 'uuid-with-space-name');
});

test('inviteLink builds the token-free share link, never the host URL (finding 1)', () => {
  assert.equal(inviteLink('http://127.0.0.1:8787', 'humble-shark'), 'http://127.0.0.1:8787/humble-shark');
  // The host tab is at <origin>/<code>?host=<token>; the invite drops the token entirely.
  const link = inviteLink('https://claudeshare.re', 'brave-otter');
  assert.equal(link, 'https://claudeshare.re/brave-otter');
  assert.ok(!link.includes('host='), 'the copied invite never carries the host token');
  // A trailing slash on the origin does not double up.
  assert.equal(inviteLink('http://x/', 'c'), 'http://x/c');
});

test('byId builds an id → participant map', () => {
  const m = byId([{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }]);
  assert.equal(m.get('a').name, 'A');
  assert.equal(m.size, 2);
});

test('segmentBox: caret blocks inserted at offsets, never names inline', () => {
  const carets = [
    { id: 'u2', offset: 4, color: '#f00', name: 'sid', self: false },
    { id: 'me', offset: 0, color: '#0f0', name: 'ian', self: true },
  ];
  const segs = segmentBox('make the hero', carets);
  // ordered by offset: caret@0, text 'make', caret@4, text ' the hero'
  assert.equal(segs[0].type, 'caret');
  assert.equal(segs[0].self, true);
  assert.deepEqual(segs[1], { type: 'text', value: 'make' });
  assert.equal(segs[2].type, 'caret');
  assert.deepEqual(segs[3], { type: 'text', value: ' the hero' });
  // No segment ever carries the name inline as text.
  assert.ok(!segs.some((s) => s.type === 'text' && /sid|ian/.test(s.value)));
  // An out-of-range offset clamps to the text end; an empty box still yields a seg.
  assert.equal(segmentBox('hi', [{ offset: 999, color: '#fff', name: 'x' }]).at(-1).type, 'caret');
  assert.deepEqual(segmentBox('', []), [{ type: 'text', value: '' }]);
});

test('draftView: authors resolve to names/colors; self is flagged', () => {
  const pById = byId([
    { id: 'host', name: 'ian', color: '#111' },
    { id: 'g1', name: 'sid', color: '#222' },
  ]);
  const box = { id: 'b1', text: 'hello', authors: ['host', 'g1'], caretOffsets: { g1: 5 } };
  const dv = draftView(box, pById, 'g1');
  assert.deepEqual(dv.authors.map((a) => a.name), ['ian', 'sid']);
  assert.equal(dv.authors[1].isSelf, true);
  assert.equal(dv.focusedBySelf, true, 'self has a caret in this box');
  assert.equal(dv.carets[0].color, '#222');
});

test('overlayView: the full view model, self excluded from cursors', () => {
  const state = {
    room: 'brave-otter',
    participants: [
      { id: 'host', name: 'ian', role: 'host', color: '#e5484d' },
      { id: 'g1', name: 'sid', role: 'prompter', color: '#0091ff' },
    ],
    drafts: { boxes: [{ id: 'b1', text: 'hi', authors: ['g1'], caretOffsets: { g1: 2 } }] },
    queue: [{ n: 1, author: 'g1', text: 'ship it' }],
    claudeState: 'busy',
    paused: false,
    pointers: {
      g1: { x: 0.5, y: 0.25, name: 'sid', color: '#0091ff' },
      host: { x: 0.1, y: 0.1, name: 'ian', color: '#e5484d' },
    },
    knocks: [{ id: 'k1', name: 'mallory', fp: 'web:tok', seen: null }],
  };

  const asHost = overlayView(state, 'host');
  assert.equal(asHost.isHost, true);
  assert.equal(asHost.role, 'host');
  assert.equal(asHost.othersPointers.length, 1, 'own pointer excluded');
  assert.equal(asHost.othersPointers[0].id, 'g1');
  assert.equal(asHost.queue[0].name, 'sid');
  assert.equal(asHost.queue[0].color, '#0091ff');
  assert.equal(asHost.claude.kind, 'busy');
  assert.equal(asHost.knocks[0].seenLabel.includes('first time'), true);

  const asGuest = overlayView(state, 'g1');
  assert.equal(asGuest.isHost, false);
  assert.equal(asGuest.canCompose, true);
  assert.equal(asGuest.othersPointers[0].id, 'host', 'guest sees the host cursor, not its own');
  assert.equal(asGuest.drafts[0].focusedBySelf, true);

  // Defensive: a junk snapshot yields an empty-but-valid view (fails closed to viewer).
  const empty = overlayView(null, null);
  assert.equal(empty.isViewer, true);
  assert.deepEqual(empty.drafts, []);
  assert.deepEqual(empty.othersPointers, []);
});

test('overlayView surfaces the ask context only as a clean {tool, summary}', () => {
  const base = {
    participants: [{ id: 'g1', name: 'sid', role: 'prompter', color: '#0091ff' }],
    drafts: { boxes: [] },
  };
  const asking = overlayView({ ...base, claudeState: 'ask', ask: { tool: 'Bash', summary: 'rm -rf /tmp/x' } }, 'g1');
  assert.deepEqual(asking.ask, { tool: 'Bash', summary: 'rm -rf /tmp/x' });
  // No ask field → null (the card stays hidden).
  assert.equal(overlayView({ ...base, claudeState: 'idle' }, 'g1').ask, null);
  // A junk ask value never crashes the view model.
  assert.equal(overlayView({ ...base, claudeState: 'ask', ask: 'nope' }, 'g1').ask, null);
});

test('the ask-answer bytes are safe: approve = "1", deny = Esc (never "2")', () => {
  // Real Claude v2 answers a numbered select: option 1 is Yes, Esc is the "(esc)" No.
  // "2" is "Yes, and don't ask again" — an APPROVE variant, so it must NOT be deny.
  assert.equal(ASK_APPROVE_BYTES, '1');
  assert.equal(ASK_DENY_BYTES, '\x1b');
  assert.notEqual(ASK_DENY_BYTES, '2', 'deny must never send an approve-and-remember key');
});

test('overlayView: turn history attaches to each author’s panel (who typed what + response)', () => {
  const state = {
    room: 'brave-otter',
    participants: [
      { id: 'host', name: 'ian', role: 'host', color: '#e5484d' },
      { id: 'g1', name: 'sid', role: 'prompter', color: '#0091ff' },
    ],
    drafts: { boxes: [] },
    queue: [{ n: 1, author: 'g1', text: 'queued one' }],
    history: [
      { id: 1, author: 'host', prompt: 'add rate limiting', response: 'done', running: false },
      { id: 2, author: 'g1', prompt: 'use redis', response: '', running: true },
      { id: 3, author: 'host', prompt: 'now the README', response: 'wrote docs', running: false },
    ],
    claudeState: 'busy',
    paused: false,
    pointers: {},
    knocks: [],
  };
  const v = overlayView(state, 'host');
  const hostPanel = v.panels.find((p) => p.id === 'host');
  const g1Panel = v.panels.find((p) => p.id === 'g1');

  assert.deepEqual(
    hostPanel.turns.map((t) => [t.prompt, t.response, t.running]),
    [
      ['add rate limiting', 'done', false],
      ['now the README', 'wrote docs', false],
    ],
    'each author only sees their own turns, in order',
  );
  assert.deepEqual(g1Panel.turns.map((t) => [t.prompt, t.running]), [['use redis', true]]);
  assert.equal(g1Panel.pending[0].text, 'queued one', 'still-queued prompts remain separate from history');

  // Missing history field → panels still valid with empty turns.
  const noHistory = overlayView({ ...state, history: undefined }, 'host');
  assert.deepEqual(
    noHistory.panels.find((p) => p.id === 'host').turns,
    [],
  );
});

// ════════════════════════════════════════════════════════════════════════════
// SMOKE: HTTP serves the client, and a WS join completes against a fake host
// ════════════════════════════════════════════════════════════════════════════

const { Client, utils } = ssh2;
const { generateKeyPairSync, parseKey } = utils;

function newKey() {
  for (let i = 0; i < 8; i++) {
    const priv = generateKeyPairSync('ed25519').private;
    if (!(parseKey(priv) instanceof Error)) return priv;
  }
  return generateKeyPairSync('ed25519').private;
}

// A fake host: ssh2 client on username 'host', no-pty shell, speaking JSON-lines.
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

// A browser tab: a real ws client separating binary (screen) from text (JSON).
function connectWeb(webPort, query) {
  const ws = new WebSocket(`ws://127.0.0.1:${webPort}/ws?${query}`);
  ws.binaryType = 'arraybuffer';
  const texts = [];
  const bins = [];
  const tw = [];
  const bw = [];
  const drain = (waiters, item) => {
    for (let i = waiters.length - 1; i >= 0; i--) if (waiters[i].pred(item)) waiters.splice(i, 1)[0].resolve(item);
  };
  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      const buf = Buffer.from(data);
      bins.push(buf);
      drain(bw, buf);
    } else {
      let m;
      try {
        m = JSON.parse(data.toString('utf8'));
      } catch {
        return;
      }
      texts.push(m);
      drain(tw, m);
    }
  });
  ws.on('error', () => {});
  return {
    ws,
    ready: () => new Promise((res, rej) => (ws.readyState === ws.OPEN ? res() : (ws.on('open', res), ws.on('error', rej)))),
    send: (o) => ws.send(JSON.stringify(o)),
    nextText: (pred) => {
      const f = texts.find(pred);
      return f ? Promise.resolve(f) : new Promise((res) => tw.push({ pred, resolve: res }));
    },
    nextBinary: (pred = () => true) => {
      const f = bins.find(pred);
      return f ? Promise.resolve(f) : new Promise((res) => bw.push({ pred, resolve: res }));
    },
  };
}

const b64 = (s) => Buffer.from(s).toString('base64');

test('smoke: HTTP serves the SPA + client.js + style.css + xterm asset', async (t) => {
  const relay = await startRelay({ port: 0, webPort: 0, host: '127.0.0.1', hostKey: newKey() });
  t.after(() => relay.close());
  const base = `http://127.0.0.1:${relay.webPort}`;

  const index = await fetch(`${base}/`);
  assert.equal(index.status, 200);
  assert.match(index.headers.get('content-type'), /text\/html/);
  const html = await index.text();
  assert.match(html, /id="join"/, 'the real client HTML (not the fallback) is served');
  assert.match(html, /\/client\.js/);

  // A room-code path still serves the SPA (client reads the code from the path).
  const room = await fetch(`${base}/brave-otter`);
  assert.equal(room.status, 200);
  assert.match(room.headers.get('content-type'), /text\/html/);

  // The public client files are served with the right content-types.
  const js = await fetch(`${base}/client.js`);
  assert.equal(js.status, 200);
  assert.match(js.headers.get('content-type'), /javascript/);
  assert.match(await js.text(), /export function overlayView/);

  const css = await fetch(`${base}/style.css`);
  assert.equal(css.status, 200);
  assert.match(css.headers.get('content-type'), /text\/css/);

  // The vendored xterm bundle (an /assets/* file).
  const xterm = await fetch(`${base}/assets/lib/xterm.js`);
  assert.equal(xterm.status, 200);
  assert.match(xterm.headers.get('content-type'), /javascript/);

  // A missing public file is a 404 (not the SPA).
  const missing = await fetch(`${base}/nope.js`);
  assert.equal(missing.status, 404);
});

test('smoke: a browser completes a WS join against a fake host', async (t) => {
  const relay = await startRelay({ port: 0, webPort: 0, host: '127.0.0.1', hostKey: newKey() });
  t.after(() => relay.close());

  const host = await connectHost(relay.port);
  t.after(() => host.client.end());
  host.send({ t: TYPES.HELLO, want: 'room' });
  const { code } = await host.next((m) => m.t === TYPES.ROOM);

  const web = connectWeb(relay.webPort, buildWsPath({ code, name: 'sid', token: 'tok-sid' }).slice('/ws?'.length));
  t.after(() => web.ws.close());
  await web.ready();

  // Knock reaches the host with the derived web fingerprint.
  const knock = await host.next((m) => m.t === TYPES.KNOCK);
  assert.equal(knock.name, 'sid');
  assert.equal(knock.fp, 'web:tok-sid');

  // Admit → the browser gets its 'joined' frame (its cue to go live) with the id it
  // uses as selfId for overlayView.
  host.send({ t: TYPES.ADMIT, id: knock.id });
  const joined = await web.nextText((m) => m.t === 'joined');
  assert.equal(joined.id, knock.id);

  // Screen bytes arrive as a binary frame (fed to xterm); state as a text frame.
  host.send({ t: TYPES.SCREEN, data: b64('HELLO-WEB\r\n') });
  const screen = await web.nextBinary((b) => b.toString('utf8').includes('HELLO-WEB'));
  assert.match(screen.toString('utf8'), /HELLO-WEB/);

  const stateMsg = {
    t: TYPES.STATE,
    data: {
      room: code,
      participants: [
        { id: 'host', name: 'ian', role: 'host', color: '#e5484d' },
        { id: joined.id, name: 'sid', role: 'prompter', color: '#0091ff' },
      ],
      drafts: { boxes: [] },
      queue: [],
      claudeState: 'idle',
      paused: false,
      pointers: {},
      knocks: [],
    },
  };
  host.send(stateMsg);
  const st = await web.nextText((m) => m.t === 'state');
  // The client's pure view model turns this snapshot into a valid view for selfId.
  const view = overlayView(st.data, joined.id);
  assert.equal(view.room, code);
  assert.equal(view.me.name, 'sid');
  assert.equal(view.canCompose, true);
  assert.equal(view.isHost, false);

  // A browser key is base64 UTF-8 bytes; it reaches the host labeled with the
  // relay-stamped id (never a browser-supplied one).
  web.send({ t: 'key', data: b64encode('\r') });
  const key = await host.next((m) => m.t === TYPES.KEY && m.id === knock.id);
  assert.equal(Buffer.from(key.data, 'base64').toString('utf8'), '\r');
});
