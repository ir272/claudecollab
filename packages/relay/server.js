// The relay ssh server — a dumb front door (spec §architecture: "the relay
// understands nothing"). It hands out room codes, forwards bytes stamped with
// who sent them, and stores nothing durable. All product intelligence lives in
// the host brain; this file only routes.
//
// Two connection kinds, told apart by the ssh username (the spike-proven trick):
//   • username 'host'  → speaks the JSON-lines protocol (packages/shared)
//   • username '<code>' → a guest terminal, raw bytes only
//
// Guest join flow (spec §knock): reject `none` auth so stock clients proceed to
// publickey (keyboard-interactive for keyless) → name prompt for an unseen key →
// knock the host → 60s waiting screen → on admit, mirror the host's screen and
// forward the guest's keystrokes/resizes labeled by id. Kicks ban fingerprints.

import ssh2 from 'ssh2';
import { readFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { createRegistry } from './rooms.js';
import { TYPES, encode, validate, Decoder } from '../shared/protocol.js';

const { Server, utils } = ssh2;
const { parseKey } = utils;

const DEFAULT_KNOCK_TIMEOUT_MS = 60 * 1000; // spec: 60s waiting screen
const DEFAULT_TTL_MS = 10 * 60 * 1000; // spec: hold the code 10 min on host drop

// Standard OpenSSH SHA256 fingerprint over the raw public-key blob.
function fingerprint(keyData) {
  return 'SHA256:' + createHash('sha256').update(keyData).digest('base64').replace(/=+$/, '');
}

// Copy — kept plain and friendly (spec frames). CRLF for raw terminals.
const COPY = {
  connecting: (host, code) => `connecting to ${host}'s room ${code}…\r\n`,
  namePrompt: 'pick a name: ',
  knocking: '\u{1F6AA} knocking…\r\n',
  denied: "\r\nthe host didn't let you in this time. no hard feelings \u{1F44B}\r\n",
  timeout: "\r\nno answer — the host isn't available right now. try again later \u{1F44B}\r\n",
  banned: '\r\nyou\'ve been removed from this room.\r\n',
  kicked: '\r\nyou were removed from the room by the host.\r\n',
  noRoom: (code) => `no room "${code}" — it may have ended or the code is wrong. \u{1F44B}\r\n`,
  lockout: 'too many attempts — try again in a minute. \u{1F44B}\r\n',
  ended: '\r\nthe session has ended. \u{1F44B}\r\n',
  // Honest now that reclaim exists (spec failure table: guests see "host
  // reconnecting…"; the relay holds the room for the TTL grace window).
  hostGone: '\r\nhost reconnecting…\r\n',
};

function safeWrite(stream, data) {
  try {
    stream?.write(data);
  } catch {
    /* stream already gone */
  }
}
function safeEnd(obj) {
  try {
    obj?.end();
  } catch {
    /* already closed */
  }
}

/**
 * Start the relay. Resolves once it is listening.
 *
 * @param {object} opts
 * @param {number} [opts.port]              listen port (0 ⇒ ephemeral; spec prod: 22 & 443)
 * @param {string} [opts.host]              bind address (default 127.0.0.1)
 * @param {string} [opts.hostKeyPath]       path to the ssh host private key
 * @param {string|Buffer} [opts.hostKey]    host private key inline (alternative to hostKeyPath)
 * @param {string} [opts.hostName]          name shown to guests ("<hostName>'s room …")
 * @param {number} [opts.knockTimeoutMs]    waiting-screen timeout
 * @param {number} [opts.ttlMs]             host-drop grace before the room closes
 * @param {object} [opts.registry]          extra options forwarded to createRegistry (tests)
 * @returns {Promise<{close():void, port:number, address:object}>}
 */
export function startRelay(opts = {}) {
  const {
    port = 0,
    host = '127.0.0.1',
    hostKeyPath,
    hostKey,
    hostName = 'the host',
    knockTimeoutMs = DEFAULT_KNOCK_TIMEOUT_MS,
    ttlMs = DEFAULT_TTL_MS,
    registry: registryOpts = {},
  } = opts;

  const hostKeyData = hostKey ?? (hostKeyPath ? readFileSync(hostKeyPath) : undefined);
  if (!hostKeyData) throw new Error('startRelay: hostKey or hostKeyPath is required');

  const registry = createRegistry({ ttlMs, ...registryOpts });

  // Live routing state, kept out of the pure registry. code -> room.
  //   guests:  Map<id, rec>  admitted, mirroring
  //   pending: Map<id, rec>  knocking, awaiting admit/deny
  //   seen:    Map<fp, name> fingerprints seen this room (for the `seen` field)
  const live = new Map();
  const conns = new Set(); // every open ssh connection, for a clean shutdown

  function findRec(room, id) {
    return room.guests.get(id) ?? room.pending.get(id);
  }
  function allRecs(room) {
    return [...room.guests.values(), ...room.pending.values()];
  }

  // A guest connection is finished (kick, leave, timeout, room close, wifi drop).
  function endGuest(rec) {
    safeEnd(rec.stream);
    safeEnd(rec.conn);
  }

  function onGuestGone(rec) {
    if (rec.gone) return;
    rec.gone = true;
    clearTimeout(rec.knockTimer);
    const room = live.get(rec.code);
    if (room) {
      room.guests.delete(rec.id);
      room.pending.delete(rec.id);
    }
    registry.removeGuest(rec.code, rec.id);
    // Tell the host so it can free the seat / clear the stale knock.
    if (room?.hostPresent && rec.announced) safeWrite(room.hostStream, encode({ t: TYPES.LEFT, id: rec.id }));
  }

  // Tear a whole room down: notify + disconnect everyone, drop registry state.
  function closeRoom(code, msg) {
    const room = live.get(code);
    if (!room) return;
    clearTimeout(room.hostTimer);
    for (const rec of allRecs(room)) {
      rec.gone = true; // suppress LEFT spam during teardown
      clearTimeout(rec.knockTimer);
      if (msg) safeWrite(rec.stream, msg);
      endGuest(rec);
    }
    safeEnd(room.hostStream);
    safeEnd(room.hostConn);
    registry.close(code);
    live.delete(code);
  }

  // The host's control connection closed. `conn` is the connection that closed;
  // if it is no longer the room's host connection, a newer one has already
  // reclaimed the room (wifi-drop race — the old socket closes late), so ignore.
  function onHostGone(code, conn) {
    const room = live.get(code);
    if (!room || !room.hostPresent) return;
    if (conn && room.hostConn !== conn) return; // superseded by a reclaim; not really gone
    room.hostPresent = false;
    registry.hostDropped(code); // registry starts its own grace timer
    for (const rec of allRecs(room)) safeWrite(rec.stream, COPY.hostGone);
    // Guests wait, visibly (spec). If the host reclaims with its key before the
    // grace window elapses, RECLAIM cancels this timer; otherwise the room ends.
    room.hostTimer = setTimeout(() => closeRoom(code, COPY.ended), ttlMs);
    room.hostTimer.unref?.();
  }

  // ---- host protocol channel ------------------------------------------------

  function setupHostChannel(conn, stream, hostFp) {
    const dec = new Decoder();
    let code = null; // this host owns exactly one room, set on `hello`/`reclaim`

    const handle = (msg) => {
      if (!validate(msg)) return; // drop anything malformed (spec: fail closed)
      switch (msg.t) {
        case TYPES.HELLO: {
          if (code) return; // one room per host connection
          const room = registry.create();
          code = room.code;
          live.set(code, {
            code,
            hostConn: conn,
            hostStream: stream,
            hostPresent: true,
            hostFp, // gates reclaim: only this key may take the room back
            guests: new Map(),
            pending: new Map(),
            seen: new Map(),
            hostTimer: null,
          });
          safeWrite(stream, encode({ t: TYPES.ROOM, code }));
          return;
        }
        case TYPES.RECLAIM: {
          if (code) return; // this connection already owns a room
          const target = msg.code;
          const room = live.get(target);
          // registry.get honors TTL expiry; hostFp must match the original host
          // key so a code-guesser cannot hijack the room brain (spec §trust).
          if (!room || !registry.get(target) || !hostFp || room.hostFp !== hostFp) {
            safeWrite(stream, encode({ t: TYPES.GONE, code: target }));
            return;
          }
          // Reattach this connection as the room's host. Newest wins: bump any
          // still-open prior host socket (the drop may not be detected yet).
          const oldConn = room.hostConn;
          const oldStream = room.hostStream;
          room.hostConn = conn;
          room.hostStream = stream;
          room.hostPresent = true;
          clearTimeout(room.hostTimer); // cancel the pending end-room timer
          room.hostTimer = null;
          registry.hostReturned(target); // cancel the registry grace timer too
          code = target;
          if (oldConn && oldConn !== conn) {
            safeEnd(oldStream);
            safeEnd(oldConn);
          }
          safeWrite(stream, encode({ t: TYPES.ROOM, code }));
          // Re-sync every still-present guest's terminal size so the brain can
          // re-clamp the shared view (sizes may have changed during the outage).
          for (const rec of room.guests.values()) {
            safeWrite(stream, encode({ t: TYPES.RESIZE, id: rec.id, cols: rec.cols, rows: rec.rows }));
          }
          return;
        }
        case TYPES.ADMIT: {
          const room = live.get(code);
          const rec = room && room.pending.get(msg.id);
          if (!rec) return; // unknown / already resolved knock
          clearTimeout(rec.knockTimer);
          // Registry enforces cap + ban; a race that fails here reads as a deny.
          const ok = registry.addGuest(code, rec.id, { name: rec.name, fp: rec.fp ?? undefined, role: 'prompter' });
          if (!ok) {
            room.pending.delete(rec.id);
            safeWrite(rec.stream, COPY.denied);
            endGuest(rec);
            return;
          }
          room.pending.delete(rec.id);
          room.guests.set(rec.id, rec);
          rec.phase = 'live';
          // No "you're live" seam here: the host's join context card (sent next, via
          // TO) already ends with one. Writing it here too printed the separator
          // twice around the card (finding 4) — the card owns the single seam now.
          safeWrite(stream, encode({ t: TYPES.JOINED, id: rec.id }));
          // Hand the host the guest's terminal size so it can clamp the shared view.
          safeWrite(stream, encode({ t: TYPES.RESIZE, id: rec.id, cols: rec.cols, rows: rec.rows }));
          return;
        }
        case TYPES.DENY: {
          const room = live.get(code);
          const rec = room && findRec(room, msg.id);
          if (!rec) return;
          clearTimeout(rec.knockTimer);
          room.pending.delete(rec.id);
          room.guests.delete(rec.id);
          safeWrite(rec.stream, COPY.denied);
          endGuest(rec);
          return;
        }
        case TYPES.SCREEN: {
          const room = live.get(code);
          if (!room) return;
          const buf = Buffer.from(msg.data, 'base64');
          for (const rec of room.guests.values()) if (rec.phase === 'live') safeWrite(rec.stream, buf);
          return;
        }
        case TYPES.TO: {
          const room = live.get(code);
          const rec = room && room.guests.get(msg.id);
          if (rec) safeWrite(rec.stream, Buffer.from(msg.data, 'base64'));
          return;
        }
        case TYPES.DROP: {
          const room = live.get(code);
          const rec = room && findRec(room, msg.id);
          if (!rec) return;
          clearTimeout(rec.knockTimer);
          if (msg.ban && rec.fp) registry.ban(code, rec.fp); // evicts + blocklists the fp
          room.guests.delete(rec.id);
          room.pending.delete(rec.id);
          rec.gone = true; // host already knows; don't echo a LEFT back
          safeWrite(rec.stream, COPY.kicked);
          endGuest(rec);
          return;
        }
        case TYPES.END: {
          if (code) closeRoom(code, COPY.ended);
          safeEnd(stream);
          safeEnd(conn);
          return;
        }
      }
    };

    stream.on('data', (chunk) => {
      for (const msg of dec.push(chunk)) handle(msg);
    });
    const drop = () => {
      if (code) onHostGone(code, conn);
    };
    stream.on('close', drop);
    conn.on('close', drop);
  }

  // ---- guest terminal channel ----------------------------------------------

  function startGuestFlow(conn, stream, code, ident, ip, ptyInfo) {
    const room = live.get(code);
    // registry.get is the source of truth for existence (honors TTL expiry).
    if (!room || !registry.get(code)) {
      safeWrite(stream, COPY.noRoom(code));
      safeEnd(stream);
      safeEnd(conn);
      return;
    }

    safeWrite(stream, COPY.connecting(hostName, code));

    if (!room.hostPresent) {
      safeWrite(stream, COPY.hostGone);
      safeEnd(stream);
      safeEnd(conn);
      return;
    }

    const fp = ident.fp; // null for keyless
    if (fp && registry.get(code).banned.has(fp)) {
      safeWrite(stream, COPY.banned);
      safeEnd(stream);
      safeEnd(conn);
      return;
    }

    if (!registry.tryKnock(code, ip)) {
      safeWrite(stream, COPY.lockout);
      safeEnd(stream);
      safeEnd(conn);
      return;
    }

    const rec = {
      id: randomUUID(),
      code,
      conn,
      stream,
      fp,
      name: null,
      phase: 'name',
      nameBuf: '',
      cols: ptyInfo?.cols ?? 80, // spec floor; refined by window-change
      rows: ptyInfo?.rows ?? 24,
      knockTimer: null,
      announced: false,
      gone: false,
    };
    room.pending.set(rec.id, rec);

    // A known key skips the name prompt and carries its prior name in `seen`.
    const priorName = fp ? room.seen.get(fp) : undefined;
    if (priorName !== undefined) {
      rec.name = priorName;
      sendKnock(room, rec, priorName); // seen = the prior name
    } else {
      safeWrite(stream, COPY.namePrompt);
    }

    stream.on('data', (chunk) => {
      if (rec.phase === 'name') feedName(room, rec, chunk);
      else if (rec.phase === 'live') safeWrite(room.hostStream, encode({ t: TYPES.KEY, id: rec.id, data: chunk.toString('base64') }));
      // 'knocking': input ignored until admitted
    });

    const gone = () => onGuestGone(rec);
    stream.on('close', gone);
    conn.on('close', gone);
  }

  // Minimal line editor for the name prompt (echo, backspace, Enter).
  function feedName(room, rec, chunk) {
    for (const byte of chunk) {
      if (byte === 0x0d || byte === 0x0a) {
        finalizeName(room, rec);
        return;
      }
      if (byte === 0x7f || byte === 0x08) {
        if (rec.nameBuf.length) {
          rec.nameBuf = rec.nameBuf.slice(0, -1);
          safeWrite(rec.stream, '\b \b');
        }
        continue;
      }
      if (byte >= 0x20 && byte < 0x7f) {
        rec.nameBuf += String.fromCharCode(byte);
        safeWrite(rec.stream, String.fromCharCode(byte)); // echo (raw pty, no local echo)
      }
    }
  }

  function finalizeName(room, rec) {
    const name = rec.nameBuf.trim().slice(0, 24) || 'guest';
    rec.name = name;
    if (rec.fp) room.seen.set(rec.fp, name); // remember real keys only
    safeWrite(rec.stream, '\r\n');
    sendKnock(room, rec, null); // first sighting ⇒ seen=null
  }

  function sendKnock(room, rec, seen) {
    rec.phase = 'knocking';
    rec.announced = true;
    safeWrite(rec.stream, COPY.knocking);
    safeWrite(room.hostStream, encode({ t: TYPES.KNOCK, id: rec.id, name: rec.name, fp: rec.fp ?? '', seen }));
    rec.knockTimer = setTimeout(() => {
      if (rec.gone) return;
      room.pending.delete(rec.id);
      safeWrite(rec.stream, COPY.timeout);
      endGuest(rec);
    }, knockTimeoutMs);
    rec.knockTimer.unref?.();
  }

  // ---- connection + auth ----------------------------------------------------

  const server = new Server({ hostKeys: [hostKeyData] }, (conn, info) => {
    conns.add(conn);
    const ip = info?.ip ?? 'unknown';
    const ident = { username: null, fp: null }; // filled on successful auth

    conn.on('authentication', (ctx) => {
      switch (ctx.method) {
        case 'publickey': {
          const fp = fingerprint(ctx.key.data);
          // Signature phase: prove possession before trusting the fingerprint.
          if (ctx.signature) {
            let key;
            try {
              key = parseKey(`${ctx.key.algo} ${ctx.key.data.toString('base64')}`);
            } catch {
              return ctx.reject();
            }
            if (key instanceof Error || key.verify(ctx.blob, ctx.signature, ctx.hashAlgo) !== true) {
              return ctx.reject();
            }
          }
          // Query phase (no signature) or verified: this key is acceptable.
          ident.username = ctx.username;
          ident.fp = fp;
          return ctx.accept();
        }
        case 'keyboard-interactive': {
          // Keyless fallback → session-only identity, no fingerprint (spec §identity).
          ident.username = ctx.username;
          ident.fp = null;
          return ctx.accept();
        }
        default:
          // Reject `none` and passwords; advertise the methods we actually take.
          // (spike finding: rejecting `none` forces stock clients onto publickey.)
          return ctx.reject(['publickey', 'keyboard-interactive']);
      }
    });

    conn.on('ready', () => {
      const isHost = ident.username === 'host';
      conn.on('session', (accept) => {
        const session = accept();
        let ptyInfo = null;
        let started = false;

        session.on('pty', (a, r, i) => {
          ptyInfo = i;
          if (typeof a === 'function') a();
        });
        session.on('window-change', (a, r, i) => {
          if (typeof a === 'function') a();
          // Route a live guest's resize to the host.
          const room = ident._code && live.get(ident._code);
          const rec = room && room.guests.get(ident._rid);
          if (rec) {
            rec.cols = i.cols;
            rec.rows = i.rows;
            safeWrite(room.hostStream, encode({ t: TYPES.RESIZE, id: rec.id, cols: i.cols, rows: i.rows }));
          }
        });

        const begin = (accept) => {
          const stream = typeof accept === 'function' ? accept() : accept;
          if (started) return;
          started = true;
          if (isHost) {
            setupHostChannel(conn, stream, ident.fp);
          } else {
            // Stash ids so window-change can find this guest's record.
            const before = new Set(live.get(ident.username)?.pending.keys() ?? []);
            startGuestFlow(conn, stream, ident.username, ident, ip, ptyInfo);
            const room = live.get(ident.username);
            if (room) {
              for (const id of room.pending.keys()) if (!before.has(id)) ident._rid = id;
              ident._code = ident.username;
            }
          }
        };
        session.on('shell', begin);
        session.on('exec', (accept) => begin(accept));
      });
    });

    conn.on('close', () => conns.delete(conn));
    conn.on('error', () => {}); // client resets are routine; never crash the relay
  });

  function close() {
    for (const code of [...live.keys()]) closeRoom(code, COPY.ended);
    for (const conn of [...conns]) safeEnd(conn);
    server.close();
  }

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, function () {
      server.removeListener('error', reject);
      server.on('error', () => {}); // post-listen errors shouldn't crash the process
      resolve({ close, port: this.address().port, address: this.address() });
    });
  });
}
