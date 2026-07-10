// The host-side relay client — the host brain's one outbound connection to the
// relay (spec §architecture: "one outbound connection"). It is the mirror image
// of packages/relay/server.js's host channel: an ssh2 client that authenticates
// as username 'host', opens a no-pty shell, and speaks the JSON-lines protocol
// from packages/shared over that channel.
//
// Everything product-shaped stays in the CLI (bin/claude-share.js); this module
// only frames messages and surfaces relay events as callbacks. It deliberately
// knows nothing about drafts, roles, or the band.
//
//   host→relay: hello / reclaim / admit / deny / screen / to / drop / end
//   relay→host: room / gone / knock / joined / left / key / resize
//
// The host's ssh key is a stable identity: its fingerprint gates room reclaim on
// the relay (spec §failure-behavior), so callers pass a persistent privateKey.

import ssh2 from 'ssh2';
import { TYPES, encode, validate, Decoder } from '../../shared/protocol.js';

const { Client, utils } = ssh2;

/**
 * Parse a relay location into { host, port }. Accepts `ssh://host:port`,
 * `ssh://host` (port defaults to 22), and a bare `host:port`. Undefined/empty
 * falls back to the localhost dev relay.
 * @param {string} [url]
 * @returns {{host:string, port:number}}
 */
export function parseRelayUrl(url) {
  if (!url) return { host: '127.0.0.1', port: 2222 };
  let s = String(url).trim();
  if (!s.includes('://')) s = 'ssh://' + s;
  let u;
  try {
    u = new URL(s);
  } catch {
    return { host: '127.0.0.1', port: 2222 };
  }
  return { host: u.hostname || '127.0.0.1', port: u.port ? Number(u.port) : 22 };
}

// Coerce screen/to payloads (Buffer or string) to the base64 the protocol wants.
const toB64 = (data) => (Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8')).toString('base64');

/**
 * The opening protocol move for a (re)connection once it is ready: ask for a fresh
 * room when we hold none, or RECLAIM the room we already own after a drop (spec
 * §failure-behavior: "reconnect with the same key restores identity + role; relay
 * holds the code 10 min"). bin/claude-share.js calls this each time a relay
 * connection becomes ready, so an initial connect says hello and every reconnect
 * reclaims — the piece the CLI was missing.
 * @param {string|null|undefined} heldRoom the room code we currently hold, if any
 * @returns {{t:'hello'} | {t:'reclaim', code:string}}
 */
export function openingMove(heldRoom) {
  return heldRoom ? { t: 'reclaim', code: heldRoom } : { t: 'hello' };
}

/**
 * Connect to the relay as the host and return an event/command handle.
 *
 * @param {object} opts
 * @param {string} [opts.url]                relay location (default localhost:2222)
 * @param {string|Buffer} [opts.privateKey]  host ssh private key (stable identity;
 *                                            an ephemeral one is generated if omitted)
 * @param {number} [opts.keepaliveInterval]  ssh keepalive ms (default 20s)
 * @returns {{
 *   ready: Promise<void>,
 *   onRoom, onGone, onKnock, onJoin, onLeave, onKey, onResize, onClose, onError,
 *   hello():void, reclaim(code):void,
 *   admit(id):void, deny(id):void,
 *   sendScreen(data):void, sendTo(id,data):void,
 *   drop(id,ban):void, end():void, close():void
 * }}
 */
export function connectRelay(opts = {}) {
  const { url, keepaliveInterval = 20000 } = opts;
  const { host, port } = parseRelayUrl(url);
  // A stable key lets the host reclaim its room after a drop; if the caller has
  // none we still connect (relay rejects `none` auth) with a throwaway key —
  // reclaim just won't work across restarts, which is fine for a one-off run.
  const privateKey = opts.privateKey ?? utils.generateKeyPairSync('ed25519').private;

  const client = new Client();
  const dec = new Decoder();

  // One callback set per event; on*() returns an unsubscribe fn.
  const sets = {
    room: new Set(),
    gone: new Set(),
    knock: new Set(),
    join: new Set(),
    leave: new Set(),
    key: new Set(),
    resize: new Set(),
    close: new Set(),
    error: new Set(),
  };
  const on = (set) => (cb) => {
    set.add(cb);
    return () => set.delete(cb);
  };
  const emit = (name, ...args) => {
    for (const cb of sets[name]) {
      try {
        cb(...args);
      } catch {
        /* a listener throwing must not desync the wire loop */
      }
    }
  };

  let stream = null;
  let closed = false;

  const send = (obj) => {
    if (closed || !stream) return;
    try {
      stream.write(encode(obj));
    } catch {
      /* channel already gone */
    }
  };

  // Route one decoded relay→host message to its callback set. Drop anything that
  // fails validation (spec: fail closed — the host never acts on a malformed line).
  const route = (msg) => {
    if (!validate(msg)) return;
    switch (msg.t) {
      case TYPES.ROOM:
        return emit('room', msg.code);
      case TYPES.GONE:
        return emit('gone', msg.code);
      case TYPES.KNOCK:
        return emit('knock', { id: msg.id, name: msg.name, fp: msg.fp, seen: msg.seen });
      case TYPES.JOINED:
        return emit('join', msg.id);
      case TYPES.LEFT:
        return emit('leave', msg.id);
      case TYPES.KEY:
        return emit('key', { id: msg.id, data: Buffer.from(msg.data, 'base64') });
      case TYPES.RESIZE:
        return emit('resize', { id: msg.id, cols: msg.cols, rows: msg.rows });
      // host→relay types (hello/admit/screen/…) never arrive here; ignore.
      default:
        return;
    }
  };

  let settled = false;
  const ready = new Promise((resolve, reject) => {
    client.on('error', (err) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
      emit('error', err);
    });
    client.on('close', () => {
      closed = true;
      emit('close');
    });
    client.on('ready', () => {
      // No pty — the host channel is a pure byte pipe for the protocol (mirrors
      // the relay, which routes by username 'host', not by whether a pty exists).
      client.shell(false, (err, s) => {
        if (err) {
          if (!settled) {
            settled = true;
            reject(err);
          }
          return;
        }
        stream = s;
        s.on('data', (chunk) => {
          for (const msg of dec.push(chunk)) route(msg);
        });
        s.on('close', () => {
          closed = true;
          emit('close');
        });
        settled = true;
        resolve();
      });
    });
    client.connect({ host, port, username: 'host', privateKey, keepaliveInterval });
  });
  // Nobody may await ready (fire-and-forget wiring); don't crash on a rejection.
  ready.catch(() => {});

  return {
    ready,

    onRoom: on(sets.room), // (code)                       room granted (create or reclaim)
    onGone: on(sets.gone), // (code)                       reclaim refused (expired / wrong key)
    onKnock: on(sets.knock), // ({id,name,fp,seen})        a guest is knocking
    onJoin: on(sets.join), // (id)                         a guest was admitted
    onLeave: on(sets.leave), // (id)                       a guest disconnected
    onKey: on(sets.key), // ({id, data:Buffer})            guest keystrokes, labeled
    onResize: on(sets.resize), // ({id, cols, rows})       guest terminal size
    onClose: on(sets.close), // ()                         the control channel closed
    onError: on(sets.error), // (err)                      ssh transport error

    hello: () => send({ t: TYPES.HELLO, want: 'room' }),
    reclaim: (code) => send({ t: TYPES.RECLAIM, code }),
    admit: (id) => send({ t: TYPES.ADMIT, id }),
    deny: (id) => send({ t: TYPES.DENY, id }),
    sendScreen: (data) => send({ t: TYPES.SCREEN, data: toB64(data) }),
    sendTo: (id, data) => send({ t: TYPES.TO, id, data: toB64(data) }),
    drop: (id, ban = false) => send({ t: TYPES.DROP, id, ban: !!ban }),
    end: () => send({ t: TYPES.END }),

    /** Tear down the transport without ending the room (e.g. on host crash). */
    close: () => {
      closed = true;
      try {
        stream?.end();
      } catch {
        /* already closed */
      }
      try {
        client.end();
      } catch {
        /* already closed */
      }
    },
  };
}
