// The control socket — how the wrapped Claude drives its OWN session from the
// inside (spec phase 5a: `collab go|off|status`). A unix socket at CLAUDE_SHARE_CTL,
// 0600 (same-user only), speaking JSON-lines. Every request carries `v:1`; a wrong
// or absent version is refused machine-readably so a future protocol bump can't be
// silently misread. One reply line per request line.
//
// The transport is deliberately dumb: it version-gates, dispatches to a handler by
// request type, and writes the handler's reply. All product logic (go/off/status
// against the room lifecycle) lives in the handlers the caller passes — this file
// never touches the relay or the brain.

import net from 'node:net';
import fs from 'node:fs';
import { Decoder } from '../../shared/protocol.js';

/** The control-socket protocol version. Every request must carry `v` equal to this. */
export const CTL_V = 1;

/**
 * Start the control-socket server.
 *
 * @param {object} opts
 * @param {string} opts.path                     unix socket path (unlinked on close)
 * @param {Record<string, (req:object)=>any>} opts.handlers
 *        map of request type → async handler returning the reply object. Unknown
 *        types get a generic error; a handler that throws becomes an error reply.
 * @returns {{ close():void }}
 */
export function startCtl({ path: sockPath, handlers = {} } = {}) {
  // A stale socket file from a crashed prior run would make listen() fail with
  // EADDRINUSE — clear it first (we own the pid-stamped name).
  try {
    fs.unlinkSync(sockPath);
  } catch {
    /* nothing there — fine */
  }

  const reply = (conn, obj) => {
    try {
      conn.write(JSON.stringify(obj) + '\n');
    } catch {
      /* client already gone */
    }
  };

  const handleLine = async (conn, msg) => {
    // Version gate first — the cheapest, most important check. A wrong or absent
    // version is refused before any handler runs (a client speaking a different
    // protocol must not have its fields reinterpreted).
    if (!msg || typeof msg !== 'object' || msg.v !== CTL_V) {
      return reply(conn, { ok: false, error: 'version' });
    }
    const fn = handlers[msg.t];
    if (typeof fn !== 'function') return reply(conn, { ok: false, error: `unknown request: ${msg.t}` });
    let res;
    try {
      res = await fn(msg);
    } catch (err) {
      res = { ok: false, error: String(err?.message || err) };
    }
    reply(conn, res ?? { ok: false, error: 'no reply' });
  };

  const server = net.createServer((conn) => {
    const dec = new Decoder(); // reused: buffers partial lines, drops malformed JSON
    conn.on('data', (chunk) => {
      for (const msg of dec.push(chunk)) handleLine(conn, msg);
    });
    conn.on('error', () => {}); // a client reset must never crash the host
  });
  server.on('error', () => {}); // post-listen socket errors are non-fatal

  server.listen(sockPath, () => {
    // Same-user only: the socket carries session control, so lock it to 0600 as
    // soon as it exists (listen created the file with the process umask).
    try {
      fs.chmodSync(sockPath, 0o600);
    } catch {
      /* best-effort — a chmod failure must not take the session down */
    }
  });

  return {
    close() {
      try {
        server.close();
      } catch {
        /* already closing */
      }
      try {
        fs.unlinkSync(sockPath);
      } catch {
        /* already gone */
      }
    },
  };
}
