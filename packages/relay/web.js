// The relay's web door — a browser front-end onto the exact same room machinery
// the ssh guest door uses (spec v2: "the browser is the one multiplayer surface
// for everyone, host included"). startRelay() starts this when opts.webPort is set.
//
// Two jobs, both dumb on purpose (the brain stays in the host CLI):
//
//   1. HTTP static: GET / and GET /<roomCode> serve packages/relay/public/index.html
//      (the SPA entry); GET /<file>.<ext> (e.g. /client.js, /style.css) serves that
//      file from the public dir; GET /assets/* serves the vendored @xterm/xterm files
//      straight out of node_modules. All three are path-traversal safe (resolved and
//      pinned inside their base dir).
//
//   2. WS /ws?room=<code>&name=<name>&token=<browser-token>  — a web participant.
//      It knocks / admits / bans / caps through the SAME registry + room state as an
//      ssh guest; the only difference is the transport:
//        • fp = 'web:' + token          (localStorage token → returning identity)
//        • host tab: /ws?...&host=<hostToken>  → fp = 'webhost:' + hostToken. The
//          relay makes NO trust decision — it just forwards that fp in the knock;
//          the brain auto-admits when it matches the token it generated (role host).
//        • relay→browser  BINARY frame = screen bytes (feed to xterm)
//                         TEXT frame   = JSON protocol ({t:'state'|'joined'|'error'})
//        • browser→relay  TEXT frame   = JSON {t:'key'|'resize'|'pointer'|'ui', …};
//          the relay STAMPS the sender id (never trusts a browser-supplied one) and
//          forwards to the host, so the role gate in the brain still governs.

import http from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { TYPES, encode, validate } from '../shared/protocol.js';
import { sanitizeName } from './names.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(here, 'public');
const INDEX_HTML = path.join(PUBLIC_DIR, 'index.html');

// Resolve the vendored xterm package dir through node resolution so monorepo
// hoisting doesn't matter. `/assets/<rest>` maps to `<xtermDir>/<rest>`.
const require = createRequire(import.meta.url);
const XTERM_DIR = path.dirname(require.resolve('@xterm/xterm/package.json'));

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
};
const contentType = (p) => CONTENT_TYPES[path.extname(p).toLowerCase()] ?? 'application/octet-stream';

// Served when public/index.html doesn't exist yet (T3 owns the real client).
const FALLBACK_INDEX =
  '<!doctype html><meta charset="utf-8"><title>claude-share</title>' +
  '<body style="font:16px system-ui;margin:3rem;max-width:40rem">' +
  '<h1>claude-share</h1><p>the web client is not built yet.</p></body>';

function isObj(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// ---- ws send helpers (fail-soft; a closed socket must never throw) -----------

function wsSendBinary(ws, data) {
  if (ws.readyState !== ws.OPEN) return;
  try {
    ws.send(Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8'), { binary: true });
  } catch {
    /* socket already gone */
  }
}
function wsSendText(ws, str) {
  if (ws.readyState !== ws.OPEN) return;
  try {
    ws.send(typeof str === 'string' ? str : JSON.stringify(str));
  } catch {
    /* socket already gone */
  }
}
function wsClose(ws) {
  try {
    ws.close();
  } catch {
    /* already closing */
  }
}
const sendErr = (ws, reason) => wsSendText(ws, JSON.stringify({ t: 'error', reason }));

/**
 * Start the HTTP + WebSocket web door. Shares the live routing state and the
 * registry with the ssh relay so web participants are real room members.
 *
 * @param {object} ctx
 * @param {number} ctx.port                 listen port (0 ⇒ ephemeral; spec prod: 443)
 * @param {string} ctx.host                 bind address
 * @param {Map<string,object>} ctx.live     code -> live room (shared with server.js)
 * @param {object} ctx.registry             the shared room registry (cap/ban/knock-limit)
 * @param {number} ctx.knockTimeoutMs       waiting-screen timeout
 * @param {(rec:object)=>void} ctx.onGuestGone  shared guest-teardown (frees seat, LEFTs the host)
 * @param {(stream:any,data:any)=>void} ctx.safeWrite  shared fail-soft writer (to the host stream)
 * @returns {Promise<{close():void, port:number, address:object}>}
 */
export function startWebDoor(ctx) {
  const { port = 0, host = '127.0.0.1', live, registry, knockTimeoutMs, onGuestGone, safeWrite } = ctx;

  // ---- HTTP: index (SPA-style, room code in the path) + vendored xterm assets

  function serveIndex(res) {
    const s = createReadStream(INDEX_HTML);
    s.on('open', () => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      s.pipe(res);
    });
    s.on('error', () => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(FALLBACK_INDEX);
    });
  }

  // Serve a file from a fixed base dir, path-traversal safe. `rest` begins with '/';
  // any '../' resolves out and fails the prefix check, so a request can never escape
  // the base. Shared by the vendored xterm assets and the public client files.
  async function serveFrom(baseDir, rest, res) {
    const target = path.resolve(baseDir, '.' + rest);
    if (target !== baseDir && !target.startsWith(baseDir + path.sep)) {
      res.writeHead(403, { 'content-type': 'text/plain' });
      return res.end('forbidden');
    }
    let st;
    try {
      st = await stat(target);
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain' });
      return res.end('not found');
    }
    if (!st.isFile()) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      return res.end('not found');
    }
    // no-cache: the browser must revalidate on every load, or a tab keeps running a
    // stale client (style/logic) after the host updates — confusing mid-iteration.
    res.writeHead(200, {
      'content-type': contentType(target),
      'content-length': st.size,
      'cache-control': 'no-cache',
    });
    createReadStream(target).pipe(res);
  }
  const serveAsset = (rest, res) => serveFrom(XTERM_DIR, rest, res);
  const servePublic = (rest, res) => serveFrom(PUBLIC_DIR, rest, res);

  const server = http.createServer((req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { 'content-type': 'text/plain' });
      return res.end('method not allowed');
    }
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    } catch {
      res.writeHead(400, { 'content-type': 'text/plain' });
      return res.end('bad request');
    }
    if (pathname.startsWith('/assets/')) return void serveAsset(pathname.slice('/assets'.length), res);
    // A single-segment path with a file extension (e.g. /client.js, /style.css,
    // /favicon.ico) → a static file from the public dir. Room codes have no dot, so
    // they never match here and fall through to the SPA below.
    if (pathname.indexOf('/', 1) === -1 && path.extname(pathname)) return void servePublic(pathname, res);
    // '/' or a single-segment path (a room code, e.g. /brave-otter) → the SPA.
    if (pathname === '/' || (pathname.indexOf('/', 1) === -1 && pathname.length > 1)) return serveIndex(res);
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  });

  // ---- WS: web participants, on the shared room machinery ---------------------

  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      return socket.destroy();
    }
    if (url.pathname !== '/ws') return socket.destroy();
    wss.handleUpgrade(req, socket, head, (ws) => onConnect(ws, url, req));
  });

  function onConnect(ws, url, req) {
    ws.on('error', () => {}); // client resets are routine; never crash the relay
    const q = url.searchParams;
    const code = q.get('room');
    const hostToken = q.get('host');
    const isHostTab = !!hostToken;
    // Identity: the host tab carries the host token; a guest carries its browser
    // token (session-only if absent). The relay makes no trust call — the brain does.
    const fp = isHostTab ? 'webhost:' + hostToken : 'web:' + (q.get('token') || randomUUID());
    // Printable-ASCII only, same as the ssh door: `?name=` is an untrusted URL param,
    // and the host writes it verbatim to its terminal / log / session.md and mirrors
    // it to every ssh guest — raw ESC/OSC/BEL bytes here would be escape injection.
    const name = sanitizeName(q.get('name'), isHostTab ? 'host' : 'guest');
    const ip = req.socket.remoteAddress || 'unknown';

    // Same gate as the ssh door (spec: respect bans/lockouts/caps identically).
    const room = code ? live.get(code) : null;
    if (!code || !room || !registry.get(code)) return void (sendErr(ws, 'no-room'), wsClose(ws));
    if (!room.hostPresent) return void (sendErr(ws, 'host-gone'), wsClose(ws));
    if (fp && registry.get(code).banned.has(fp)) return void (sendErr(ws, 'banned'), wsClose(ws));
    if (!registry.tryKnock(code, ip)) return void (sendErr(ws, 'lockout'), wsClose(ws));

    const rec = {
      id: randomUUID(),
      code,
      kind: 'web', // marks this rec for the host channel's web-only branches (state/joined)
      ws,
      fp,
      name,
      phase: 'knocking', // web skips the ssh name prompt: name arrives in the query
      cols: 80, // spec floor; refined by the browser's first {t:'resize'}
      rows: 24,
      knockTimer: null,
      announced: false,
      gone: false,
      // Adapters so the shared host-channel handlers (SCREEN/TO/DENY/DROP/close…)
      // treat a web rec exactly like an ssh one: byte writes become binary frames.
      stream: { write: (d) => wsSendBinary(ws, d), end: () => wsClose(ws) },
      conn: { end: () => wsClose(ws) },
      sendText: (s) => wsSendText(ws, s), // STATE + the 'joined' signal go as text
    };
    room.pending.set(rec.id, rec);

    // Knock the host (identical shape to the ssh door). A returning token carries
    // its prior name in `seen`; brand-new ⇒ null.
    const priorName = room.seen.get(fp);
    const seen = priorName !== undefined ? priorName : null;
    room.seen.set(fp, name);
    rec.announced = true;
    safeWrite(room.hostStream, encode({ t: TYPES.KNOCK, id: rec.id, name: rec.name, fp: rec.fp, seen }));
    rec.knockTimer = setTimeout(() => {
      if (rec.gone) return;
      sendErr(ws, 'timeout');
      wsClose(ws); // 'close' → onGuestGone: drops the seat, LEFTs the host
    }, knockTimeoutMs);
    rec.knockTimer.unref?.();

    ws.on('message', (data, isBinary) => {
      if (isBinary) return; // browsers only send JSON text; screen flows one way
      if (rec.phase !== 'live') return; // ignore input until admitted (ssh parity)
      const r = live.get(rec.code);
      if (!r || !r.hostPresent || !r.guests.has(rec.id)) return;
      let msg;
      try {
        msg = JSON.parse(data.toString('utf8'));
      } catch {
        return;
      }
      if (!isObj(msg)) return;
      // Build the host-bound message with the relay-stamped id (never the browser's).
      let out = null;
      switch (msg.t) {
        case 'key':
          out = { t: TYPES.KEY, id: rec.id, data: msg.data };
          break;
        case 'resize':
          if (Number.isFinite(msg.cols) && Number.isFinite(msg.rows)) {
            rec.cols = msg.cols;
            rec.rows = msg.rows;
          }
          out = { t: TYPES.RESIZE, id: rec.id, cols: msg.cols, rows: msg.rows };
          break;
        case 'pointer':
          out = { t: TYPES.POINTER, id: rec.id, x: msg.x, y: msg.y };
          break;
        case 'ui':
          out = { t: TYPES.UI, id: rec.id, action: msg.action };
          break;
        default:
          return;
      }
      if (validate(out)) safeWrite(r.hostStream, encode(out)); // fail closed on anything malformed
    });

    ws.on('close', () => onGuestGone(rec));
  }

  function close() {
    for (const ws of wss.clients) {
      try {
        ws.terminate();
      } catch {
        /* already gone */
      }
    }
    try {
      wss.close();
    } catch {
      /* not started */
    }
    try {
      server.close();
    } catch {
      /* not listening */
    }
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
